import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { createEngine } from '../src/engine.js';
import { createRugcheck } from '../src/rugcheck.js';
import { sellabilityCheck } from '../src/safety.js';

const res = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const fast = { gapMs: 0, backoffMs: 1 };

test('RugCheck: ringkasan di-parse, 404 = belum dikenal (null), 429 dicoba ulang, galat dilempar', async () => {
  const rc = createRugcheck({ ...fast, fetchImpl: async () => res(200, { lpLockedPct: 91.4, score_normalised: 1, risks: [{ name: 'Low Liquidity', level: 'danger', value: 'x' }] }) });
  assert.deepEqual(await rc.summary('M'), { lpLockedPct: 91.4, score: 1, risks: [{ name: 'Low Liquidity', level: 'danger' }] });
  assert.equal(await createRugcheck({ ...fast, fetchImpl: async () => res(404) }).summary('M'), null);
  let n = 0;
  const retry = createRugcheck({ ...fast, fetchImpl: async () => (++n < 3 ? res(429) : res(200, { lpLockedPct: 100 })) });
  assert.equal((await retry.summary('M')).lpLockedPct, 100); assert.equal(n, 3);
  await assert.rejects(() => createRugcheck({ ...fast, retries: 1, fetchImpl: async () => res(429) }).summary('M'), /HTTP 429/);
  await assert.rejects(() => createRugcheck({ ...fast, fetchImpl: async () => res(400) }).summary('M'), /HTTP 400/);
});

const SOL = 'So11111111111111111111111111111111111111112';
const okQuote = { quote: async (a) => (a === SOL ? { outAmount: '1000' } : { outAmount: String(0.05e9 * 0.97) }) };
const rcWith = (summary) => ({ summary: async () => { if (summary instanceof Error) throw summary; return summary; } });
const check = (rc, token, extra = {}) => sellabilityCheck({ jup: okQuote, mint: 'M1', token, sizeSol: 0.05, rugcheck: rc, requireLpLock: true, lpLockMinUsd: 5000, ...extra });
const tok = (liquidity) => ({ id: 'M1', liquidity, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' });

test('gerbang kunci LP: nilai terkunci = persen x likuiditas, minimal 5000 USD', async () => {
  assert.equal((await check(rcWith({ lpLockedPct: 100 }), tok(12000))).ok, true);          // 12000 terkunci
  assert.equal((await check(rcWith({ lpLockedPct: 50 }), tok(12000))).ok, true);           // 6000 >= 5000
  const low = await check(rcWith({ lpLockedPct: 40 }), tok(12000));                        // 4800 < 5000
  assert.equal(low.ok, false); assert.match(low.reason, /terkunci hanya 40%.*batas 5000/);
  assert.equal((await check(rcWith({ lpLockedPct: 0 }), tok(500000))).ok, false);          // pool besar tapi tidak terkunci: ditolak
  assert.equal((await check(rcWith({ lpLockedPct: 100 }), tok(4000))).ok, false);          // terkunci penuh tapi pool cuma 4000
  assert.equal((await check(rcWith({ lpLockedPct: 100 }), tok(5000))).ok, true);           // tepat di batas
});

test('gerbang kunci LP gagal-tertutup: tanpa data, API error, tanpa likuiditas, tanpa sumber', async () => {
  assert.match((await check(rcWith(null), tok(20000))).reason, /belum dikenal RugCheck/);
  assert.match((await check(rcWith({ lpLockedPct: null }), tok(20000))).reason, /tidak tersedia/);
  assert.match((await check(rcWith(new Error('HTTP 429')), tok(20000))).reason, /tidak bisa diperiksa \(HTTP 429\)/);
  assert.match((await check(rcWith({ lpLockedPct: 100 }), { id: 'M1' })).reason, /likuiditas pool tidak diketahui/);
  assert.match((await sellabilityCheck({ jup: okQuote, mint: 'M1', token: tok(20000), sizeSol: 0.05, requireLpLock: true })).reason, /tidak ada sumber datanya/);
  assert.equal((await sellabilityCheck({ jup: okQuote, mint: 'M1', token: tok(20000), sizeSol: 0.05, requireLpLock: false })).ok, true);   // dimatikan: tidak dicek
});

test('gerbang kunci dijalankan sebelum quote (token tak terkunci tidak membuang permintaan quote)', async () => {
  let quotes = 0;
  const jup = { quote: async () => { quotes += 1; return { outAmount: '1000' }; } };
  const r = await sellabilityCheck({ jup, mint: 'M1', token: tok(20000), sizeSol: 0.05, rugcheck: rcWith({ lpLockedPct: 0 }), requireLpLock: true });
  assert.equal(r.ok, false); assert.equal(quotes, 0);
});

const plan = { ageHours: 0.3, barVolumeUsd: 9000, momentumPct: 12, fresh: true };
const make = (rugcheck) => {
  const db = openDb();
  setSetting(db, 'paper_slippage_pct', 0);
  const jup = { prices: async () => ({}), candles: async () => [], trending: async () => [], recent: async () => [], toptraded: async () => [], quote: okQuote.quote };
  return { db, engine: createEngine({ db, jup, rugcheck, notify: async () => {}, pauseBetweenFetchesMs: 0 }) };
};
const open = (e, token) => e.engine.openAny({ mint: 'M1', symbol: 'TT', price: 1, plan, token, strategy: 'p6' });

test('openAny: token dengan LP tidak terkunci ditolak (semua entry lewat pintu yang sama); yang terkunci dibuka; setelan bisa mematikan', async () => {
  const unlocked = make(rcWith({ lpLockedPct: 0 }));
  const r = await open(unlocked, tok(30000));
  assert.equal(r.opened, false); assert.match(r.reason, /ditolak uji bisa-dijual: likuiditas terkunci hanya 0%/);
  assert.equal(unlocked.db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 0);
  const ev = JSON.parse(unlocked.db.prepare("SELECT detail FROM events WHERE kind = 'skip'").get().detail);
  assert.equal(ev.stage, 'keamanan');
  const basePlan = { tpPrice: 70, slPrice: 47, tpPct: 37, slPct: -8, rr: 4, zona: 50, zoneTouches: 2, target: 70, dropPct: 30 };
  assert.equal((await unlocked.engine.openAny({ mint: 'M9', symbol: 'SS', price: 51, plan: basePlan, token: { ...tok(30000), id: 'M9' }, strategy: 'p6' })).opened, false);
  assert.equal((await open(make(rcWith({ lpLockedPct: 100 })), tok(30000))).opened, true);
  const off = make(rcWith({ lpLockedPct: 0 })); setSetting(off.db, 'lp_lock_required', 'false');
  assert.equal((await open(off, tok(30000))).opened, true);
  assert.equal((await open(make(rcWith(new Error('HTTP 429'))), tok(30000))).opened, false);   // RugCheck mati: tidak masuk
});
