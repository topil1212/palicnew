// Eksekusi sungguhan lewat Jupiter swap + wallet bot. MATI secara default: hanya jalan bila state trading_mode = 'live',
// dan mode itu hanya bisa dinyalakan dari Mini App dengan mengetik LIVE (actions.changeTradingMode -> enable()).
// Kunci privat dibaca dari env SOLANA_PRIVATE_KEY di dalam proses ini saja; tidak pernah dicatat atau dikirim ke mana pun.
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { getState, setState, logEvent } from './db.js';
import { getSetting } from './settings.js';
import { feeParams } from './route-config.js';

const SOL = 'So11111111111111111111111111111111111111112';
const JUP = 'https://lite-api.jup.ag/swap/v1';
const LAMPORTS = 1_000_000_000;
const RESERVE_SOL = 0.01;          // sisa untuk fee dan rent
const MAX_PRICE_IMPACT_PCT = 5;

export function parseKey(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('SOLANA_PRIVATE_KEY kosong');
  if (text.startsWith('[')) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text)));
  return Keypair.fromSecretKey(bs58.decode(text));
}

export function createLive({ db, env = process.env, fetchImpl = fetch, connection = null, now = () => Date.now(), solUsd = async () => null }) {
  let keypair = null;
  const wallet = () => { if (!keypair) keypair = parseKey(env.SOLANA_PRIVATE_KEY); return keypair; };
  const rpcUrl = env.SOLANA_RPC_URL || (env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : 'https://api.mainnet-beta.solana.com');
  const conn = () => connection || (connection = new Connection(rpcUrl, 'confirmed'));

  async function json(url, init) {
    const res = await fetchImpl(url, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${new URL(url).pathname}: ${body.error || body.message || res.status}`);
    return body;
  }

  const slippageBps = () => Math.round(getSetting(db, 'live_slippage_pct') * 100);

  async function quote(inputMint, outputMint, amount) {
    // Biaya rute (lihat route-config.js): hanya bila akun tujuannya untuk mint ini sudah ada; selain itu swap tanpa biaya.
    const fee = await feeParams(conn(), inputMint, outputMint);
    const feeQuery = fee.feeAccount ? `&platformFeeBps=${fee.platformFeeBps}&instructionVersion=V2` : '';
    const q = await json(`${JUP}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps()}${feeQuery}`);
    if (fee.feeAccount) Object.defineProperty(q, 'routeFeeAccount', { value: fee.feeAccount });   // tidak ikut diserialisasi ke Jupiter
    const impact = Number(q.priceImpactPct || 0) * 100;
    if (impact > MAX_PRICE_IMPACT_PCT) throw new Error(`price impact ${impact.toFixed(1)}% > ${MAX_PRICE_IMPACT_PCT}%`);
    return q;
  }

  async function buildSigned(q) {
    const body = await json(`${JUP}/swap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteResponse: q, ...(q.routeFeeAccount ? { feeAccount: q.routeFeeAccount } : {}), userPublicKey: wallet().publicKey.toBase58(), dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: 'high' } } }),
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, 'base64'));
    tx.sign([wallet()]);
    return { tx, lastValidBlockHeight: body.lastValidBlockHeight };
  }

  async function sendAndConfirm({ tx, lastValidBlockHeight }) {
    const raw = tx.serialize();
    const signature = await conn().sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
    const deadline = now() + 60_000;
    while (now() < deadline) {
      const { value } = await conn().getSignatureStatuses([signature]);
      const status = value?.[0];
      if (status?.err) throw new Error(`transaksi gagal on-chain: ${JSON.stringify(status.err)}`);
      if (status && ['confirmed', 'finalized'].includes(status.confirmationStatus)) return signature;
      if (lastValidBlockHeight && (await conn().getBlockHeight()) > lastValidBlockHeight) throw new Error('blockhash kedaluwarsa, transaksi tidak masuk');
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error('konfirmasi transaksi timeout (cek signature di explorer)');
  }

  async function tokenBalanceRaw(mint) {
    const res = await conn().getParsedTokenAccountsByOwner(wallet().publicKey, { mint: new PublicKey(mint) });
    return res.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  return {
    configured: () => Boolean(env.SOLANA_PRIVATE_KEY),
    mode: () => getState(db, 'trading_mode', 'dry_run'),
    publicKey: () => wallet().publicKey.toBase58(),

    // Dipanggil dari Mini App. Hanya operator yang mengetik LIVE yang bisa menyalakannya.
    async enable({ value, confirmText, actor }) {
      if (value !== 'live') return { ok: false, error: 'Mode tidak dikenal.' };
      if (!this.configured()) return { ok: false, error: 'SOLANA_PRIVATE_KEY belum diisi di server.' };
      if (confirmText !== 'LIVE') return { ok: false, error: 'Ketik LIVE untuk mengonfirmasi.' };
      let balance;
      try { balance = (await conn().getBalance(wallet().publicKey)) / LAMPORTS; } catch (err) { return { ok: false, error: `Tidak bisa membaca saldo wallet: ${err.message}` }; }
      const need = getSetting(db, 'live_size_sol') + RESERVE_SOL;
      if (balance < need) return { ok: false, error: `Saldo wallet ${balance.toFixed(4)} SOL kurang dari ${need.toFixed(4)} (ukuran posisi + cadangan fee).` };
      setState(db, 'trading_mode', 'live');
      logEvent(db, 'mode', null, { reasons: [`mode live dinyalakan oleh ${actor}`] }, now());
      return { ok: true, message: 'Mode LIVE aktif.' };
    },

    async balanceSol() { return (await conn().getBalance(wallet().publicKey)) / LAMPORTS; },

    // Beli token senilai live_size_sol. Mengembalikan fill nyata (jumlah token & harga USD efektif).
    async buy({ mint, decimals }) {
      const sizeSol = getSetting(db, 'live_size_sol');
      const balance = await this.balanceSol();
      if (balance < sizeSol + RESERVE_SOL) throw new Error(`saldo ${balance.toFixed(4)} SOL tidak cukup untuk ${sizeSol} + cadangan`);
      const lamports = Math.round(sizeSol * LAMPORTS);
      const q = await quote(SOL, mint, lamports);
      const signature = await sendAndConfirm(await buildSigned(q));
      const received = await tokenBalanceRaw(mint).catch(() => BigInt(q.outAmount));
      const tokens = Number(received) / 10 ** (decimals ?? 6);
      const sol = await solUsd();
      return { signature, sizeSol, tokenAmountRaw: received.toString(), entryPriceUsd: sol && tokens > 0 ? (sizeSol * sol) / tokens : null };
    },

    // Jual seluruh saldo token itu ke SOL. proceedsSol dari quote (perkiraan); saldo SOL sebelum/sesudah dipakai sebagai koreksi.
    async sell({ mint }) {
      const amount = await tokenBalanceRaw(mint);
      if (amount <= 0n) throw new Error('saldo token 0 (sudah terjual?)');
      const before = await conn().getBalance(wallet().publicKey);
      const q = await quote(mint, SOL, amount.toString());
      const signature = await sendAndConfirm(await buildSigned(q));
      const after = await conn().getBalance(wallet().publicKey);
      const measured = (after - before) / LAMPORTS;
      const proceedsSol = measured > 0 ? measured : Number(q.outAmount) / LAMPORTS;
      return { signature, proceedsSol };
    },

    __test: { quote, buildSigned },
  };
}
