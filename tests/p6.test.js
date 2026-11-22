import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { evaluateP6 } from '../src/p6.js';
import { createEngine } from '../src/engine.js';
import { canOpen } from '../src/risk.js';
import { createActions } from '../src/actions.js';
import { createNotifier } from '../src/notifier.js';

const CFG = { minBarVolumeUsd: 5000, minMomentumPct: 5, maxAgeHours: 6, freshAgeHours: 1, maxPre1hPct: 0, entryWindowMs: 150_000 };
const T0 = Math.floor(Date.UTC(2026, 10, 18, 5, 0, 0) / 300_000) * 300_000 + 30_000;   // 30 dtk setelah sebuah bar tutup

// bar ke-i berakhir (T0 - 30s) - (n-1-i)*5m; bar terakhir adalah bar sinyal yang baru tutup.
function bars(specs) {
  const n = specs.length;
  return specs.map(([open, close, volume], i) => ({ time: (T0 - 30_000) / 1000 - (n - i) * 300, open, high: Math.max(open, close), low: Math.min(open, close), close, volume }));
}
const flat = (n, price = 1) => Array.from({ length: n }, () => [price, price, 100]);
const tokenAged = (hours, extra = {}) => ({ id: 'T1', symbol: 'NEW', decimals: 6, usdPrice: 1.1, mcap: 2e5, liquidity: 30000, holderCount: 300, firstPool: { createdAt: new Date(T0 - hours * 3_600_000).toISOString() }, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true }, ...extra });

test('P6 entry: pair baru + bar meledak', () => {
  const r = evaluateP6(bars([...flat(5), [1, 1.1, 8000]]), tokenAged(0.4), T0, CFG);
  assert.equal(r.ok, true); assert.equal(r.fresh, true); assert.ok(r.momentumPct > 9);
});

test('P6 penolakan: umur, volume, momentum, sinyal basi, bar yang belum tutup diabaikan', () => {
  const ok = bars([...flat(5), [1, 1.1, 8000]]);
  assert.equal(evaluateP6(ok, tokenAged(10), T0, CFG).status, 'too_old');
  assert.equal(evaluateP6(ok, { ...tokenAged(0.4), firstPool: undefined }, T0, CFG).status, 'age_unknown');
  assert.equal(evaluateP6(bars([...flat(5), [1, 1.1, 3000]]), tokenAged(0.4), T0, CFG).status, 'low_volume');
  assert.equal(evaluateP6(bars([...flat(5), [1, 1.03, 8000]]), tokenAged(0.4), T0, CFG).status, 'low_momentum');
  assert.equal(evaluateP6(ok, tokenAged(0.4), T0 + 200_000, CFG).status, 'stale_signal');
  const withLive = [...ok, { time: (T0 - 30_000) / 1000, open: 1.1, high: 9, low: 1.1, close: 9, volume: 9e6 }];   // bar berjalan: tidak boleh dipakai
  assert.equal(evaluateP6(withLive, tokenAged(0.4), T0, CFG).barVolumeUsd, 8000);
});

test('P6 pair bukan baru: harga 1 jam sebelumnya harus <= 0%', () => {
  const pumped = bars([...Array.from({ length: 14 }, (_, i) => [1 + i * 0.02, 1 + (i + 1) * 0.02, 100]), [1.3, 1.45, 8000]]);
  const r = evaluateP6(pumped, tokenAged(3), T0, CFG);
  assert.equal(r.status, 'pumped_1h'); assert.ok(r.pre1hPct > 0);
  const calm = bars([...Array.from({ length: 14 }, (_, i) => [1.2 - i * 0.01, 1.2 - (i + 1) * 0.01, 100]), [1.05, 1.2, 8000]]);
  const ok = evaluateP6(calm, tokenAged(3), T0, CFG);
  assert.equal(ok.ok, true); assert.equal(ok.fresh, false); assert.ok(ok.pre1hPct <= 0);
});

const make = (jupOverrides = {}) => {
  const db = openDb();
  setSetting(db, 'paper_slippage_pct', 0); setSetting(db, 'paper_fee_pct', 0);
  const prices = {}; const msgs = [];
  let t = T0;
  const jup = { prices: async () => prices, candles: async () => [], trending: async () => [], recent: async () => [], toptraded: async () => [], ...jupOverrides };
  const engine = createEngine({ db, jup, now: () => t, notify: async (m) => msgs.push(m), pauseBetweenFetchesMs: 0 });
  return { db, engine, prices, msgs, advance: (ms) => { t += ms; } };
};
const plan = { ageHours: 0.4, barVolumeUsd: 8000, momentumPct: 10, pre1hPct: null, fresh: true };
const open = (e, mint = 'T1') => e.engine.openAny({ mint, symbol: 'NEW', price: 1, plan, token: tokenAged(0.4), strategy: 'p6' });

test('posisi P6: bertanda strategi, tanpa TP/SL, ukuran & aturan keluar disimpan', async () => {
  const e = make();
  const r = await open(e);
  assert.equal(r.opened, true);
  const p = e.db.prepare('SELECT * FROM positions').get();
  assert.equal(p.strategy, 'p6'); assert.equal(p.size_sol, 0.05); assert.equal(p.hold_ms, 3_600_000); assert.equal(p.dead_exit_ms, 600_000); assert.equal(p.dead_exit_pct, 2);
  assert.ok(e.msgs[0].includes('P6'));
});

test('P6 dead-exit: 10 menit tanpa menyentuh +2% -> keluar', async () => {
  const e = make(); await open(e);
  e.prices.T1 = 1.01; e.advance(5 * 60_000); await e.engine.tick();
  assert.equal(e.db.prepare('SELECT status FROM positions').get().status, 'open');
  e.advance(5 * 60_000 + 1000); await e.engine.tick();
  const p = e.db.prepare('SELECT * FROM positions').get();
  assert.equal(p.status, 'closed'); assert.equal(p.exit_reason, 'dead');
  assert.ok(e.msgs.some((m) => m.includes('JUAL') && m.includes('P6')));
});

test('P6 (trailing dimatikan) pernah +2% lalu tahan penuh 60 menit; tidak ada TP/SL harga (naik 10x atau turun 80% tidak menutup)', async () => {
  const e = make(); setSetting(e.db, 'p6_trail_enabled', 'false'); await open(e);
  e.prices.T1 = 1.03; e.advance(2 * 60_000); await e.engine.tick();
  e.prices.T1 = 10; e.advance(20 * 60_000); await e.engine.tick();      // 10x: tidak ada TP
  assert.equal(e.db.prepare('SELECT status FROM positions').get().status, 'open');
  e.prices.T1 = 0.2; e.advance(20 * 60_000); await e.engine.tick();     // -80%: tidak ada SL
  assert.equal(e.db.prepare('SELECT status FROM positions').get().status, 'open');
  e.advance(20 * 60_000); await e.engine.tick();                         // total > 60 menit
  const p = e.db.prepare('SELECT * FROM positions').get();
  assert.equal(p.status, 'closed'); assert.equal(p.exit_reason, 'time');
});

test('risk P6: rugi beruntun memasang jeda; batas posisi; saklar nonaktif', async () => {
  const e = make();
  setSetting(e.db, 'p6_cooldown_minutes', 0); setSetting(e.db, 'daily_loss_limit_sol', 0);
  setSetting(e.db, 'p6_max_open', 1);
  assert.equal((await open(e, 'P1')).opened, true);
  assert.match((await open(e, 'P2')).reason, /P6: sudah 1 posisi/);
  setSetting(e.db, 'p6_enabled', 'false');
  assert.match(canOpen(e.db, 'P3', T0, { strategy: 'p6' }).reason, /nonaktif/);
});

test('scanP6 membuka posisi dari pair baru yang memenuhi syarat dan mengabaikan yang tidak', async () => {
  const good = { ...tokenAged(0.4), id: 'G1', symbol: 'GOOD', stats5m: { buyVolume: 6000, sellVolume: 4000 } };
  const weak = { ...tokenAged(0.4), id: 'W1', symbol: 'WEAK', stats5m: { buyVolume: 6000, sellVolume: 4000 } };
  const old = { ...tokenAged(12), id: 'O1', symbol: 'OLD', stats5m: { buyVolume: 9000, sellVolume: 9000 } };
  const e = make({
    recent: async () => [good, weak, old], toptraded: async () => [],
    candles: async (mint) => (mint === 'G1' ? bars([...flat(5), [1, 1.1, 8000]]) : bars([...flat(5), [1, 1.02, 8000]])),
  });
  e.prices.G1 = 1.1; e.prices.W1 = 1.02;
  const s = await e.engine.scanP6();
  assert.equal(s.entries, 1); assert.equal(s.fetched, 3); assert.equal(s.screened, 2);   // OLD tersaring umur
  const p = e.db.prepare('SELECT * FROM positions').get();
  assert.equal(p.symbol, 'GOOD'); assert.equal(p.strategy, 'p6');
  assert.equal(s.reasons.low_momentum, 1);
  assert.equal(e.engine.lastScanP6().entries, 1);
});

test('scanP6 melaporkan error bila kedua sumber gagal; nonaktif tidak memindai', async () => {
  const e = make({ recent: async () => { throw new Error('429'); }, toptraded: async () => { throw new Error('429'); } });
  assert.match((await e.engine.scanP6()).error, /gagal diambil/);
  setSetting(e.db, 'p6_enabled', 'false');
  assert.equal((await e.engine.scanP6()).error, 'P6 nonaktif');
});

test('Mini App: posisi memuat nama strategi, P6 tanpa TP/SL, strategi bisa diaktifkan/dinonaktifkan, umpan keputusan berlabel', async () => {
  const e = make();
  await open(e);
  const jup = { prices: async () => ({}), candles: async () => [], trending: async () => [] };
  const actions = createActions({ db: e.db, engine: e.engine, jup, now: () => T0 });
  const p = (await actions.listPositions({ status: 'open' })).positions[0];
  assert.equal(p.strategyName, 'P6'); assert.equal(p.tpPercent, null); assert.equal(p.slPercent, null); assert.equal(p.holdMs, 3_600_000);
  const view = actions.settingsView();
  assert.deepEqual(view.strategies.map((s) => [s.name, s.enabled]), [['P6', true]]);
  assert.ok(view.groups.some((g) => g.id === 'p6'));
  assert.equal(actions.selectStrategy('p6').ok, true);
  assert.equal(actions.settingsView().strategies.find((s) => s.id === 'p6').enabled, false);
  assert.equal(actions.selectStrategy('xx').ok, false);
  assert.equal((await actions.overview()).strategy.name, 'tidak ada');   // P6 baru saja dimatikan, S1 sudah tidak ada
  const feed = actions.decisionFeed({});
  assert.equal(feed.decisions.find((d) => d.outcome === 'buy').strategy, 'P6');
});

test('Telegram: caption posisi dibuka/ditutup memuat nama strategi', async () => {
  const e = make();
  const sent = [];
  const tg = { enabled: true, send: async (t) => sent.push({ text: t }), sendPhoto: async (buf, caption) => sent.push({ photo: buf.length > 1000, caption }) };
  const notify = createNotifier({ tg, db: e.db, solUsd: async () => 75 });
  await open(e);
  const id = e.db.prepare('SELECT id FROM positions').get().id;
  await notify('x', { kind: 'opened', positionId: id });
  e.prices.T1 = 1.05; e.advance(61 * 60_000); await e.engine.tick();
  await notify('x', { kind: 'closed', positionId: id });
  assert.equal(sent.length, 2);
  assert.ok(sent[0].photo && sent[0].caption.includes('Strategi: P6') && sent[0].caption.includes('dead-exit'));
  assert.ok(sent[1].photo && sent[1].caption.includes('Strategi: P6'));
});

test('saklar strategi: enabled eksplisit, overview memuat status & jumlah posisi, entry diblokir saat OFF', async () => {
  const e = make();
  const jup = { prices: async () => ({}), candles: async () => [], trending: async () => [] };
  const actions = createActions({ db: e.db, engine: e.engine, jup, now: () => T0 });
  await open(e);
  let o = await actions.overview();
  assert.deepEqual(o.strategies.map((s) => [s.id, s.enabled, s.openCount]), [['p6', true, 1]]);
  assert.equal(actions.selectStrategy('p6', { enabled: false }).enabled, false);
  assert.equal(actions.selectStrategy('p6', { enabled: false }).enabled, false);   // idempoten, bukan balik status
  o = await actions.overview();
  assert.equal(o.strategies.find((s) => s.id === 'p6').enabled, false);
  assert.match((await open(e, 'P9')).reason, /nonaktif/);
  assert.equal(e.db.prepare("SELECT status FROM positions").get().status, 'open');   // posisi lama tetap
  e.prices.T1 = 1.05; e.advance(61 * 60_000); await e.engine.tick();
  assert.equal(e.db.prepare("SELECT exit_reason FROM positions").get().exit_reason, 'time');   // tetap dikelola & ditutup saat OFF
  assert.equal(actions.selectStrategy('p6', { enabled: true }).enabled, true);
  assert.equal(actions.selectStrategy('s1').ok, false);                       // S1 sudah dihapus
});

test('P6 memakai harga real-time, bukan harga daftar yang basi; batal bila harga sudah bergeser jauh', async () => {
  const stale = { ...tokenAged(0.4), id: 'G1', symbol: 'GOOD', usdPrice: 5, stats5m: { buyVolume: 6000, sellVolume: 4000 } };   // daftar bilang 5, kenyataan ~1.1
  const e = make({ recent: async () => [stale], candles: async () => bars([...flat(5), [1, 1.1, 8000]]) });
  e.prices.G1 = 1.12;
  assert.equal((await e.engine.scanP6()).entries, 1);
  assert.equal(e.db.prepare('SELECT entry_price FROM positions').get().entry_price, 1.12);   // bukan 5
  const e2 = make({ recent: async () => [stale], candles: async () => bars([...flat(5), [1, 1.1, 8000]]) });
  e2.prices.G1 = 1.6;                                   // +45% dari close bar sinyal: sudah lari
  const s2 = await e2.engine.scanP6();
  assert.equal(s2.entries, 0); assert.equal(s2.reasons.price_moved, 1);
  const e3 = make({ recent: async () => [stale], candles: async () => bars([...flat(5), [1, 1.1, 8000]]) });   // tanpa harga real-time: tidak masuk
  assert.equal((await e3.engine.scanP6()).reasons.no_price, 1);
  setSetting(e2.db, 'p6_max_move_pct', 0);              // pagar dimatikan operator
  e2.db.prepare('DELETE FROM events').run();
  assert.equal((await e2.engine.scanP6()).entries, 1);
});

test('P6 trailing D: tidak aktif sebelum +200%, aktif sesudahnya, jual saat turun 30% dari puncak', async () => {
  const e = make(); await open(e);                        // masuk di harga 1 (tanpa slippage di tes)
  e.prices.T1 = 2.9; e.advance(2 * 60_000); await e.engine.tick();      // +190%: belum aktif
  e.prices.T1 = 1.5; e.advance(2 * 60_000); await e.engine.tick();      // turun 48% dari puncak, tapi trailing belum aktif -> tahan
  assert.equal(e.db.prepare('SELECT status FROM positions').get().status, 'open');
  e.prices.T1 = 4; e.advance(2 * 60_000); await e.engine.tick();        // +300%: trailing aktif, puncak 4
  e.prices.T1 = 3; e.advance(60_000); await e.engine.tick();            // stop = 2.8, harga 3 masih di atasnya
  assert.equal(e.db.prepare('SELECT status FROM positions').get().status, 'open');
  e.prices.T1 = 2.7; e.advance(60_000); await e.engine.tick();          // di bawah 2.8 -> keluar
  const p = e.db.prepare('SELECT * FROM positions').get();
  assert.equal(p.status, 'closed'); assert.equal(p.exit_reason, 'trail');
  assert.ok(p.pnl_pct > 150);                             // mengamankan sebagian besar keuntungan, bukan rugi
  assert.ok(e.msgs.some((m) => m.includes('trailing') && m.includes('P6')));
});

test('P6 trailing berlaku juga untuk posisi yang sudah terbuka; saklar & angka bisa diubah; puncak mengikuti harga tertinggi', async () => {
  const e = make(); setSetting(e.db, 'p6_trail_enabled', 'false'); await open(e);     // posisi dibuat saat trailing mati
  e.prices.T1 = 5; e.advance(3 * 60_000); await e.engine.tick();                      // puncak 5 (+400%)
  setSetting(e.db, 'p6_trail_enabled', 'true');                                       // dinyalakan belakangan
  e.prices.T1 = 3.4; e.advance(60_000); await e.engine.tick();                        // stop 3.5 -> keluar
  assert.equal(e.db.prepare('SELECT exit_reason FROM positions').get().exit_reason, 'trail');
  const e2 = make(); await open(e2);
  setSetting(e2.db, 'p6_trail_pct', 50); setSetting(e2.db, 'p6_trail_arm_pct', 100);
  e2.prices.T1 = 2.2; e2.advance(2 * 60_000); await e2.engine.tick();                 // +120% >= 100% -> aktif, puncak 2.2
  e2.prices.T1 = 1.3; e2.advance(60_000); await e2.engine.tick();                     // stop 1.1, harga 1.3 aman
  assert.equal(e2.db.prepare('SELECT status FROM positions').get().status, 'open');
  e2.prices.T1 = 1.05; e2.advance(60_000); await e2.engine.tick();
  assert.equal(e2.db.prepare('SELECT exit_reason FROM positions').get().exit_reason, 'trail');
});

test('Mini App memuat status trailing P6 (belum aktif -> aktif dengan stop)', async () => {
  const e = make(); await open(e);
  const jup = { prices: async () => ({}), candles: async () => [], trending: async () => [] };
  const actions = createActions({ db: e.db, engine: e.engine, jup, now: () => T0 });
  let p = (await actions.listPositions({ status: 'open' })).positions[0];
  assert.equal(p.trailActive, false); assert.equal(p.trailArmPct, 200); assert.equal(p.trailPct, 30);
  e.prices.T1 = 4; e.advance(60_000); await e.engine.tick();
  p = (await actions.listPositions({ status: 'open' })).positions[0];
  assert.equal(p.trailActive, true); assert.ok(Math.abs(p.trailStopPct - 180) < 1e-6);   // 4*0.7 = 2.8 -> +180%
  assert.ok(actions.settingsView().groups.find((g) => g.id === 'p6').fields.some((f) => f.key === 'p6_trail_pct'));
});

// --- posisi tanpa harga (pool kering / token hilang dari API harga) ---
const makeBlind = (liquidity, chartFresh = false) => {
  const e = make({ token: async () => ({ id: 'T1', liquidity }), candles: async () => (chartFresh ? [{ time: Math.floor(T0 / 1000) - 30, open: 1, high: 1.2, low: 1, close: 1.1, volume: 100 }] : []) });
  return e;
};

test('posisi tanpa harga + likuiditas 0 setelah masa tunggu: ditutup rugi total, bukan untung palsu', async () => {
  const e = makeBlind(0); await open(e);
  e.prices.T1 = 4; await e.engine.tick();                       // sempat +300% (puncak tercatat)
  delete e.prices.T1;                                           // lalu harga hilang dari API
  e.advance(60_000); await e.engine.tick();
  assert.equal(e.db.prepare('SELECT status FROM positions').get().status, 'open');   // masih masa tunggu
  assert.ok(e.msgs.some((m) => m.includes('HARGA HILANG')));
  e.advance(5 * 60_000); await e.engine.tick();
  const p = e.db.prepare('SELECT * FROM positions').get();
  assert.equal(p.status, 'closed'); assert.equal(p.exit_reason, 'no_price');
  assert.equal(p.pnl_pct, -100); assert.ok(Math.abs(p.pnl_sol + p.size_sol) < 1e-12);
});

test('posisi tanpa harga tetapi likuiditas masih ada: ditunggu, lalu dihapus buku setelah batas maksimum', async () => {
  const e = makeBlind(5000); await open(e);
  delete e.prices.T1; await e.engine.tick();
  e.advance(10 * 60_000); await e.engine.tick();
  assert.equal(e.db.prepare('SELECT status FROM positions').get().status, 'open');
  e.advance(25 * 60_000); await e.engine.tick();
  assert.equal(e.db.prepare('SELECT exit_reason FROM positions').get().exit_reason, 'no_price');
});

test('harga API hilang tetapi chart 1 menit segar: dinilai dari chart dan dikelola normal', async () => {
  const e = makeBlind(0, true); await open(e);
  delete e.prices.T1;
  await e.engine.tick();
  const p = e.db.prepare('SELECT * FROM positions').get();
  assert.equal(p.status, 'open'); assert.equal(p.last_price, 1.1);
  assert.ok(!e.msgs.some((m) => m.includes('HARGA HILANG')));
});

test('harga kembali: status buta dihapus; Mini App menandai harga basi dan tidak menghitungnya sebagai untung mengambang', async () => {
  const e = makeBlind(0); await open(e);
  e.prices.T1 = 3; await e.engine.tick();
  const jup = { prices: async () => ({}), candles: async () => [], trending: async () => [] };
  let t = T0;
  const actions = createActions({ db: e.db, engine: e.engine, jup, now: () => t });
  assert.equal((await actions.listPositions({ status: 'open' })).positions[0].valuationStatus, '');
  t = T0 + 10 * 60_000;                                           // harga terakhir sudah basi
  const view = (await actions.listPositions({ status: 'open' })).positions[0];
  assert.equal(view.valuationStatus, 'blind'); assert.equal(view.pnlPercent, null);
  assert.equal((await actions.overview()).open.pnlSol, 0);
});

test('posisi buta dengan likuiditas residu (0,002 USD) dianggap mati setelah masa tunggu, bukan menunggu 30 menit', async () => {
  const e = makeBlind(0.002); await open(e);
  delete e.prices.T1; await e.engine.tick();
  e.advance(6 * 60_000); await e.engine.tick();
  assert.equal(e.db.prepare('SELECT exit_reason FROM positions').get().exit_reason, 'no_price');
  const alive = makeBlind(5000); await open(alive);            // likuiditas masih bermakna: tetap ditunggu
  delete alive.prices.T1; await alive.engine.tick();
  alive.advance(6 * 60_000); await alive.engine.tick();
  assert.equal(alive.db.prepare('SELECT status FROM positions').get().status, 'open');
});

test('P6 holder minimum: token dengan holder di bawah batas dilewati, di atas batas dibuka; 0 = mati', async () => {
  const few = { ...tokenAged(0.4), id: 'H1', symbol: 'FEW', holderCount: 120, stats5m: { buyVolume: 6000, sellVolume: 4000 } };
  const many = { ...tokenAged(0.4), id: 'H2', symbol: 'MANY', holderCount: 400, stats5m: { buyVolume: 6000, sellVolume: 4000 } };
  const e = make({ recent: async () => [few, many], toptraded: async () => [], candles: async () => bars([...flat(5), [1, 1.1, 8000]]) });
  setSetting(e.db, 'p6_min_holders', 250);
  e.prices.H1 = 1.1; e.prices.H2 = 1.1;
  const s = await e.engine.scanP6();
  assert.equal(s.reasons.low_holders, 1); assert.equal(s.entries, 1);
  assert.deepEqual(e.db.prepare('SELECT symbol FROM positions').all().map((r) => r.symbol), ['MANY']);
});
