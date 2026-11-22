import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { setSetting, getSetting } from '../src/settings.js';
import { createEngine } from '../src/engine.js';

const plan = { ageHours: 0.3, barVolumeUsd: 9000, momentumPct: 12, fresh: true };
const T0 = 1_800_000_000_000;

// token dengan likuiditas saat masuk 20000; liquidityNow bisa diubah-ubah oleh tes
const make = () => {
  const db = openDb();
  setSetting(db, 'paper_slippage_pct', 0); setSetting(db, 'paper_fee_pct', 0);
  const state = { liq: 20000, calls: 0, throwTokens: false };
  const prices = {}; const msgs = [];
  let t = T0;
  const jup = {
    prices: async () => prices, candles: async () => [], trending: async () => [], recent: async () => [], toptraded: async () => [],
    tokens: async (mints) => { state.calls += 1; if (state.throwTokens) throw new Error('HTTP 429'); return mints.map((id) => ({ id, liquidity: state.liq })); },
  };
  const engine = createEngine({ db, jup, now: () => t, notify: async (m) => msgs.push(m), pauseBetweenFetchesMs: 0 });
  return { db, engine, state, prices, msgs, advance: (ms) => { t += ms; } };
};
const open = (e, mint = 'T1', strategy = 'p6') => e.engine.openAny({ mint, symbol: 'TT', price: 1, plan, token: { liquidity: 20000, mcap: 1e5 }, strategy });
const status = (e, id = 1) => e.db.prepare('SELECT status, exit_reason FROM positions WHERE id = ?').get(id);

test('likuiditas anjlok >= 50% dari saat masuk: posisi ditutup segera dengan alasan likuiditas, dan operator diberi tahu', async () => {
  const e = make(); await open(e);
  e.prices.T1 = 1.5;
  e.state.liq = 12000; e.advance(31_000); await e.engine.tick();            // turun 40%: aman
  assert.equal(status(e).status, 'open');
  e.state.liq = 9000; e.advance(31_000); await e.engine.tick();             // turun 55%: bahaya
  assert.deepEqual({ ...status(e) }, { status: 'closed', exit_reason: 'liquidity' });
  assert.ok(e.msgs.some((m) => m.includes('LIKUIDITAS ANJLOK') && m.includes('P6')));
});

test('batas bawah mutlak: likuiditas di bawah 500 USD menutup posisi walau penurunannya kecil dari saat masuk', async () => {
  const e = make();
  await e.engine.openAny({ mint: 'T1', symbol: 'TT', price: 1, plan, token: { liquidity: 600, mcap: 1e5 }, strategy: 'p6' });
  e.prices.T1 = 1;
  e.state.liq = 400; e.advance(31_000); await e.engine.tick();
  assert.equal(status(e).exit_reason, 'liquidity');
});

test('pemantau satu permintaan untuk semua posisi, dibatasi 30 detik, bisa dimatikan, dan gagal-aman bila API error', async () => {
  const e = make(); await open(e, 'T1'); await open(e, 'T2');
  e.prices.T1 = 1; e.prices.T2 = 1;
  await e.engine.tick(); await e.engine.tick();                              // dua tick berdekatan: hanya 1 permintaan
  assert.equal(e.state.calls, 1);
  e.advance(31_000); await e.engine.tick();
  assert.equal(e.state.calls, 2);                                            // tetap satu permintaan walau dua posisi
  setSetting(e.db, 'liq_guard_enabled', 'false'); e.advance(31_000); e.state.liq = 1;
  await e.engine.tick();
  assert.equal(e.state.calls, 2); assert.equal(status(e).status, 'open');   // dimatikan: tidak memeriksa dan tidak menutup
  setSetting(e.db, 'liq_guard_enabled', 'true'); e.state.throwTokens = true; e.advance(31_000);
  await e.engine.tick();
  assert.equal(status(e).status, 'open');                                    // API error: tidak menutup posisi sembarangan
});

test('berlaku untuk semua posisi; angka batas bisa diubah; posisi sehat tidak disentuh', async () => {
  const e = make();
  const basePlan = { tpPrice: 70, slPrice: 47, tpPct: 37, slPct: -8, rr: 4, zona: 50, zoneTouches: 2, target: 70, dropPct: 30 };
  await e.engine.openAny({ mint: 'P6X', symbol: 'SS', price: 51, plan: basePlan, token: { liquidity: 20000, mcap: 1e5 }, strategy: 'p6' });
  e.prices.P6X = 51;
  setSetting(e.db, 'liq_guard_drop_pct', 20);                                // lebih ketat: 20%
  e.state.liq = 17000; e.advance(31_000); await e.engine.tick();             // turun 15%: aman
  assert.equal(status(e).status, 'open');
  e.state.liq = 15000; e.advance(31_000); await e.engine.tick();             // turun 25%: keluar
  assert.equal(status(e).exit_reason, 'liquidity');
  assert.equal(getSetting(e.db, 'p6_min_liquidity_usd'), 5000);              // syarat likuiditas P6 sesuai permintaan
});
