import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, Keypair, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import bs58 from 'bs58';
import { feeCandidates, feeParams, __resetRouteCache } from '../src/route-config.js';
import { openDb } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { createLive } from '../src/live.js';

const SOL = 'So11111111111111111111111111111111111111112';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

// akun token yang valid untuk mint tertentu (165 byte, mint di 0..32, state=1 di offset 108)
const tokenAccount = (mint) => { const data = Buffer.alloc(165); new PublicKey(mint).toBuffer().copy(data, 0); data[108] = 1; return { owner: TOKEN_PROGRAM, data }; };
const connWith = (presentFor) => ({
  getMultipleAccountsInfo: async (addresses) => addresses.map((a, i) => (presentFor(i, a) ? tokenAccount(presentFor(i, a)) : null)),
});

test('akun tujuan belum ada: tanpa biaya', async () => {
  __resetRouteCache();
  assert.deepEqual(await feeParams(connWith(() => null), MINT, SOL), {});
});

test('akun tujuan ada dan valid (sisi output didahulukan): biaya 50 bps + alamat akun', async () => {
  __resetRouteCache();
  const rows = feeCandidates(MINT, SOL);                       // output SOL dulu
  const p = await feeParams(connWith((i) => (i === 0 ? SOL : null)), MINT, SOL);
  assert.equal(p.platformFeeBps, 50);
  assert.equal(p.feeAccount, rows[0].address.toBase58());
});

test('akun dengan mint salah / error RPC / tanpa koneksi: tanpa biaya, tidak melempar error', async () => {
  __resetRouteCache();
  assert.deepEqual(await feeParams(connWith((i) => (i === 0 ? MINT : null)), MINT, SOL), {});   // mint tidak cocok
  __resetRouteCache();
  assert.deepEqual(await feeParams({ getMultipleAccountsInfo: async () => { throw new Error('rpc down'); } }, MINT, SOL), {});
  assert.deepEqual(await feeParams(null, MINT, SOL), {});
});

test('hasil dicache; error RPC tidak pernah dicache', async () => {
  __resetRouteCache();
  let calls = 0;
  const conn = { getMultipleAccountsInfo: async (a) => { calls += 1; return a.map(() => null); } };
  await feeParams(conn, MINT, SOL); await feeParams(conn, MINT, SOL);
  assert.equal(calls, 1);
  __resetRouteCache();
  let n = 0;
  const flaky = { getMultipleAccountsInfo: async (a) => { n += 1; if (n === 1) throw new Error('x'); return a.map(() => null); } };
  await feeParams(flaky, MINT, SOL); await feeParams(flaky, MINT, SOL);
  assert.equal(n, 2);
});

function swapTx(payer) {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: bs58.encode(Buffer.alloc(32, 1)), instructions: [] }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

test('live.quote / buildSigned memasang biaya hanya bila akunnya ada', async () => {
  const wallet = Keypair.generate();
  for (const withAccount of [true, false]) {
    __resetRouteCache();
    const db = openDb(); setSetting(db, 'live_size_sol', 0.05);
    const urls = [], bodies = [];
    const fetchImpl = async (url, init) => {
      urls.push(url);
      if (url.includes('/quote')) return { ok: true, json: async () => ({ outAmount: '1500000', priceImpactPct: '0.001' }) };
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ swapTransaction: swapTx(wallet.publicKey), lastValidBlockHeight: 1e9 }) };
    };
    const connection = connWith((i) => (withAccount && i === 0 ? SOL : null));
    const live = createLive({ db, env: { SOLANA_PRIVATE_KEY: bs58.encode(wallet.secretKey) }, fetchImpl, connection });
    const q = await live.__test.quote(MINT, SOL, '1000');
    await live.__test.buildSigned(q);
    assert.equal(urls[0].includes('platformFeeBps=50'), withAccount);
    assert.equal(Boolean(bodies[0].feeAccount), withAccount);
    assert.ok(!('routeFeeAccount' in bodies[0].quoteResponse), 'metadata lokal tidak ikut dikirim ke Jupiter');
  }
});
