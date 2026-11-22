import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import bs58 from 'bs58';
import { openDb, getState } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { createEngine } from '../src/engine.js';
import { createLive, parseKey } from '../src/live.js';
import { createActions } from '../src/actions.js';

const plan = { tpPrice: 70, slPrice: 47, tpPct: 37, slPct: -8, rr: 4.6, zona: 50, zoneTouches: 2, target: 70, dropPct: 30 };
const token = { id: 'M1', symbol: 'AAA', decimals: 6, mcap: 1e6, liquidity: 1e5, holderCount: 500 };

function fakeLive({ failSell = false, delay = 0 } = {}) {
  const calls = { buy: 0, sell: 0 };
  return { calls, mode: () => state.mode, configured: () => true,
    async buy() { calls.buy += 1; if (delay) await new Promise((r) => setTimeout(r, delay)); return { signature: 'BUYSIG', sizeSol: 0.05, tokenAmountRaw: '1000000', entryPriceUsd: 51.5 }; },
    async sell() { calls.sell += 1; if (failSell) throw new Error('rpc down'); return { signature: 'SELLSIG', proceedsSol: 0.06 }; } };
}
const state = { mode: 'live' };

const make = (live) => {
  const db = openDb();
  const prices = {}; const msgs = [];
  const jup = { prices: async () => prices, candles: async () => [], trending: async () => [] };
  const engine = createEngine({ db, jup, live, notify: async (m) => msgs.push(m), pauseBetweenFetchesMs: 0 });
  return { db, engine, prices, msgs };
};

test('mode paper: eksekutor live tidak pernah dipanggil', async () => {
  state.mode = 'dry_run';
  const live = fakeLive(); const { engine, db } = make(live);
  const r = await engine.openAny({ mint: 'M1', symbol: 'AAA', price: 51, plan, token });
  assert.equal(r.opened, true); assert.equal(live.calls.buy, 0);
  assert.equal(db.prepare('SELECT execution_mode FROM positions').get().execution_mode, 'dry_run');
});

test('mode live: beli memakai fill nyata, jual menghitung PnL dari hasil SOL', async () => {
  state.mode = 'live';
  const live = fakeLive(); const { engine, db, prices } = make(live);
  const r = await engine.openAny({ mint: 'M1', symbol: 'AAA', price: 51, plan, token });
  assert.equal(r.opened, true);
  const p = db.prepare('SELECT * FROM positions').get();
  assert.equal(p.execution_mode, 'live'); assert.equal(p.entry_price, 51.5); assert.equal(p.size_sol, 0.05); assert.equal(p.entry_signature, 'BUYSIG'); assert.equal(p.token_amount, '1000000');
  prices.M1 = 71; assert.equal((await engine.closeManually(p.id)).ok, true);   // P6: tanpa TP harga, jual lewat penutupan
  const c = db.prepare('SELECT * FROM positions').get();
  assert.equal(c.status, 'closed'); assert.equal(c.exit_signature, 'SELLSIG');
  assert.ok(Math.abs(c.pnl_sol - 0.01) < 1e-12); assert.ok(Math.abs(c.pnl_pct - 20) < 1e-9);
});

test('jual live gagal: posisi tetap terbuka, dicoba lagi tick berikutnya, notifikasi tidak spam', async () => {
  state.mode = 'live';
  const live = fakeLive({ failSell: true }); const { engine, db, prices, msgs } = make(live);
  await engine.openAny({ mint: 'M1', symbol: 'AAA', price: 51, plan, token });
  const id = db.prepare('SELECT id FROM positions').get().id;
  prices.M1 = 40; await engine.closeManually(id); await engine.closeManually(id);
  assert.equal(db.prepare('SELECT status FROM positions').get().status, 'open');
  assert.equal(live.calls.sell, 2);
  assert.equal(msgs.filter((m) => m.includes('JUAL LIVE GAGAL')).length, 1);
});

test('dua pembelian bersamaan untuk token yang sama hanya mengeksekusi satu transaksi', async () => {
  state.mode = 'live';
  const live = fakeLive({ delay: 20 }); const { engine } = make(live);
  const [a, b] = await Promise.all([engine.openAny({ mint: 'M1', symbol: 'AAA', price: 51, plan, token }), engine.openAny({ mint: 'M1', symbol: 'AAA', price: 51, plan, token })]);
  assert.equal(live.calls.buy, 1);
  assert.equal([a, b].filter((r) => r.opened).length, 1);
});

test('beli live gagal: tidak ada posisi, alasan tercatat', async () => {
  state.mode = 'live';
  const live = { ...fakeLive(), buy: async () => { throw new Error('price impact 9%'); } };
  const { engine, db } = make(live);
  const r = await engine.openAny({ mint: 'M1', symbol: 'AAA', price: 51, plan, token });
  assert.equal(r.opened, false); assert.match(r.reason, /price impact/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 0);
});

// --- live.js dengan wallet sekali pakai dan jaringan palsu ---
const wallet = Keypair.generate();
const MINT = Keypair.generate().publicKey.toBase58();
function swapTx() {
  const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: bs58.encode(new Uint8Array(32).fill(7)), instructions: [] }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}
function liveEnv({ balanceSol = 1, tokenRaw = '2000000' } = {}) {
  const db = openDb(); setSetting(db, 'live_size_sol', 0.05);
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push({ url, init });
    if (url.includes('/quote')) return { ok: true, json: async () => ({ outAmount: '1500000', priceImpactPct: '0.001' }) };
    if (url.includes('/swap')) return { ok: true, json: async () => ({ swapTransaction: swapTx(), lastValidBlockHeight: 1e9 }) };
    throw new Error(`url tak terduga ${url}`);
  };
  let sent = 0, bal = balanceSol * 1e9;
  const connection = {
    getBalance: async () => (sent ? bal + 0.06e9 : bal),
    sendRawTransaction: async (raw) => { assert.ok(raw.length > 64); sent += 1; return `SIG${sent}`; },
    getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
    getBlockHeight: async () => 1,
    getParsedTokenAccountsByOwner: async () => ({ value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: tokenRaw } } } } } }] }),
  };
  const live = createLive({ db, env: { SOLANA_PRIVATE_KEY: bs58.encode(wallet.secretKey) }, fetchImpl, connection, solUsd: async () => 100 });
  return { db, live, urls, connection };
}

test('parseKey: base58 dan array JSON sama, kosong ditolak', () => {
  assert.equal(parseKey(bs58.encode(wallet.secretKey)).publicKey.toBase58(), wallet.publicKey.toBase58());
  assert.equal(parseKey(JSON.stringify([...wallet.secretKey])).publicKey.toBase58(), wallet.publicKey.toBase58());
  assert.throws(() => parseKey(''), /kosong/);
});

test('live.buy: quote -> swap -> tanda tangan -> kirim -> konfirmasi, harga efektif dari saldo token', async () => {
  const { live, urls } = liveEnv({ tokenRaw: '2000000' });
  const f = await live.buy({ mint: MINT, decimals: 6 });
  assert.equal(f.signature, 'SIG1'); assert.equal(f.sizeSol, 0.05); assert.equal(f.tokenAmountRaw, '2000000');
  assert.ok(Math.abs(f.entryPriceUsd - (0.05 * 100) / 2) < 1e-9);
  assert.ok(urls[0].url.includes('amount=50000000') && urls[0].url.includes('slippageBps=300'));
  const body = JSON.parse(urls[1].init.body);
  assert.equal(body.userPublicKey, wallet.publicKey.toBase58());
});

test('live.sell: menjual seluruh saldo token dan mengukur hasil SOL dari selisih saldo', async () => {
  const { live, urls } = liveEnv({ tokenRaw: '2000000' });
  const f = await live.sell({ mint: MINT });
  assert.equal(f.signature, 'SIG1'); assert.ok(Math.abs(f.proceedsSol - 0.06) < 1e-9);
  assert.ok(urls[0].url.includes('amount=2000000'));
});

test('live.buy menolak saldo kurang dan price impact besar', async () => {
  await assert.rejects(() => liveEnv({ balanceSol: 0.02 }).live.buy({ mint: 'M', decimals: 6 }), /saldo/);
  const e = liveEnv();
  const bad = createLive({ db: e.db, env: { SOLANA_PRIVATE_KEY: bs58.encode(wallet.secretKey) }, connection: e.connection, fetchImpl: async () => ({ ok: true, json: async () => ({ outAmount: '1', priceImpactPct: '0.2' }) }) });
  await assert.rejects(() => bad.buy({ mint: 'M', decimals: 6 }), /price impact/);
});

test('enable(): wajib kunci, wajib ketik LIVE, wajib saldo cukup; tidak menyala sendiri', async () => {
  const e = liveEnv();
  assert.equal(e.live.mode(), 'dry_run');
  assert.equal((await e.live.enable({ value: 'live', confirmText: '', actor: 'x' })).ok, false);
  assert.equal((await e.live.enable({ value: 'live', confirmText: 'live', actor: 'x' })).ok, false);
  const noKey = createLive({ db: e.db, env: {}, connection: e.connection });
  assert.match((await noKey.enable({ value: 'live', confirmText: 'LIVE', actor: 'x' })).error, /SOLANA_PRIVATE_KEY/);
  assert.equal(e.live.mode(), 'dry_run');
  assert.equal((await e.live.enable({ value: 'live', confirmText: 'LIVE', actor: 'tuan' })).ok, true);
  assert.equal(e.live.mode(), 'live');
  const poor = liveEnv({ balanceSol: 0.01 });
  assert.match((await poor.live.enable({ value: 'live', confirmText: 'LIVE', actor: 'x' })).error, /Saldo/);
});

test('actions: mode live lewat Mini App memakai enable(); kembali ke paper selalu boleh', async () => {
  const e = liveEnv();
  const jup = { prices: async () => ({}), candles: async () => [], trending: async () => [] };
  const engine = createEngine({ db: e.db, jup, live: e.live, notify: async () => {} });
  const actions = createActions({ db: e.db, engine, jup, live: e.live });
  assert.equal((await actions.changeTradingMode('live', { confirmText: 'salah' })).ok, false);
  assert.equal((await actions.changeTradingMode('live', { confirmText: 'LIVE', actor: 'tuan' })).ok, true);
  assert.equal((await actions.overview()).mode, 'live');
  assert.equal((await actions.changeTradingMode('dry_run')).ok, true);
  assert.equal(getState(e.db, 'trading_mode'), 'dry_run');
});
