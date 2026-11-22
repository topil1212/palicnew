import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateScreen, prefilterToken, buyRatioOf } from '../src/screen.js';

const BAR = 300;
const NOW = Date.UTC(2026, 10, 22, 12, 0, 20);                 // 20 dtk setelah bar sinyal tutup
const sigTime = Math.floor(NOW / 1000 / BAR) * BAR - BAR;       // bar 5m yang baru tutup
const cfg = {
  minBarVolumeUsd: 5000, minMomentumPct: 5, maxAgeHours: 6, freshAgeHours: 1, maxPre1hPct: 0, entryWindowMs: 150_000,
  minBars: 4, volSpikeRatio: 3, volBaselineBars: 6, minActiveBars: 2, maxMomentumPct: 35, minCloseStrengthPct: 60, breakoutBars: 6,
  maxFromHighPct: 30, minBuyRatioPct: 55, minTraders: 0, minLiqMcapPct: 3, minLiquidityUsd: 5000, minHolders: 0,
};
const token = (o = {}) => ({ id: 'M', usdPrice: 1, createdAt: new Date(NOW - 40 * 60_000).toISOString(), liquidity: 20000, mcap: 200000, holderCount: 300, stats5m: { buyVolume: 6000, sellVolume: 3000 }, ...o });
const bar = (i, o, c, v, hi = Math.max(o, c) * 1.002, lo = Math.min(o, c) * 0.998) => ({ time: sigTime - (i * BAR), open: o, high: hi, low: lo, close: c, volume: v });
// 6 bar tenang di sekitar 1.00, lalu bar sinyal 1.00 -> 1.10 dengan volume 12k
const quiet = () => [6, 5, 4, 3, 2, 1].map((i) => bar(i, 1.0, 1.0 + (i % 2) * 0.004, 1500));
const good = () => [...quiet(), bar(0, 1.0, 1.1, 12000, 1.105, 0.999)].sort((a, b) => a.time - b.time);

test('breakout valid lolos', () => {
  const r = evaluateScreen(good(), token(), NOW, cfg);
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.spikeRatio >= 3);
  assert.equal(r.fresh, true);
});
test('lonjakan satu-bar sendirian ditolak', () => {
  const c = [bar(6, 1, 1, 0), bar(5, 1, 1, 0), bar(4, 1, 1, 0), bar(3, 1, 1, 0), bar(2, 1, 1, 0), bar(1, 1, 1, 300), bar(0, 1, 1.1, 12000, 1.105, 0.999)].sort((a, b) => a.time - b.time);
  assert.equal(evaluateScreen(c, token(), NOW, cfg).status, 'lone_spike');
});
test('volume besar tapi tidak melonjak dibanding biasanya', () => {
  const c = [6, 5, 4, 3, 2, 1].map((i) => bar(i, 1.0, 1.0 + (i % 2) * 0.004, 8000)).concat(bar(0, 1.0, 1.1, 12000, 1.105, 0.999)).sort((a, b) => a.time - b.time);
  assert.equal(evaluateScreen(c, token(), NOW, cfg).status, 'weak_spike');
});
test('bar parabolik ditolak', () => {
  const c = good(); c[c.length - 1] = bar(0, 1.0, 1.6, 12000, 1.61, 0.999);
  assert.equal(evaluateScreen(c, token(), NOW, cfg).status, 'parabolic');
});
test('sumbu atas panjang ditolak', () => {
  const c = good(); c[c.length - 1] = bar(0, 1.0, 1.07, 12000, 1.3, 0.999);
  assert.equal(evaluateScreen(c, token(), NOW, cfg).status, 'weak_close');
});
test('tanpa breakout (masih di bawah penutupan tinggi sebelumnya) ditolak', () => {
  const c = good(); c[2] = bar(4, 1.0, 1.2, 1500, 1.21, 0.999);   // ada penutupan 1.2 di bar sebelumnya
  assert.equal(evaluateScreen(c, token(), NOW, cfg).status, 'no_breakout');
});
test('pantulan jauh di bawah puncak ditolak', () => {
  const c = good(); c.unshift(bar(9, 3.0, 3.0, 1500, 3.2, 2.9));
  assert.equal(evaluateScreen(c, token(), NOW, cfg).status, 'far_from_high');
});
test('sinyal basi ditolak', () => {
  assert.equal(evaluateScreen(good(), token(), NOW + 400_000, cfg).status, 'stale_signal');
});
test('histori terlalu pendek ditolak', () => {
  const c = good().slice(-3);
  assert.equal(evaluateScreen(c, token(), NOW, cfg).status, 'few_bars');
});
test('pair lama yang sudah naik 1 jam terakhir ditolak, yang datar lolos', () => {
  const old = token({ createdAt: new Date(NOW - 3 * 3_600_000).toISOString() });
  const hist = (start) => Array.from({ length: 14 }, (_, k) => 14 - k).map((i) => bar(i, start, start, 1500));   // 14 bar = >1 jam histori
  const up = hist(0.5).concat(quiet().map((b) => ({ ...b, open: 1.0, close: 1.0, high: 1.002, low: 0.998 })), bar(0, 1.0, 1.1, 12000, 1.105, 0.999)).filter((b, i, a) => a.findIndex((x) => x.time === b.time) === i).sort((a, b) => a.time - b.time);
  assert.equal(evaluateScreen(up, old, NOW, cfg).status, 'pumped_1h');
  const flat = up.map((b) => (b.time <= sigTime - 3600 ? { ...b, open: 1.05, close: 1.05, high: 1.06, low: 1.04 } : b));
  const r = evaluateScreen(flat, old, NOW, cfg);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.fresh, false);
});

test('prefilter: tekanan jual, likuiditas tipis vs mcap, likuiditas rendah', () => {
  assert.equal(prefilterToken(token(), NOW, cfg).ok, true);
  assert.equal(prefilterToken(token({ stats5m: { buyVolume: 2000, sellVolume: 7000 } }), NOW, cfg).status, 'sell_pressure');
  assert.equal(prefilterToken(token({ liquidity: 6000, mcap: 900000 }), NOW, cfg).status, 'thin_liquidity');
  assert.equal(prefilterToken(token({ liquidity: 1000 }), NOW, cfg).status, 'low_liquidity');
  assert.equal(prefilterToken(token({ stats5m: { buyVolume: 100, sellVolume: 100 } }), NOW, cfg).status, 'quiet');
});
test('prefilter: data stats5m tidak ada -> filter opsional dilewati, urutan "panas" memakai porsi beli netral', () => {
  const p = prefilterToken(token({ stats5m: undefined }), NOW, { ...cfg, minBarVolumeUsd: 0 });
  assert.equal(p.ok, true);
  assert.equal(buyRatioOf(token({ stats5m: undefined })), null);
});
