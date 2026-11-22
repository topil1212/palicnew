// Screening baru untuk strategi P6 (menggantikan evaluateP6 di p6.js; exit/hold/dead-exit/trailing TIDAK berubah).
// Murni, tanpa I/O. Dua tahap supaya slot analisis chart (p6_scan_max_tokens) tidak terbuang:
//   1) prefilterToken  : cuma pakai data token dari Jupiter (tanpa panggilan chart) -> murah, dijalankan ke semua token.
//   2) evaluateScreen  : pakai candle 5m -> hanya untuk token yang lolos tahap 1, diurutkan dari yang paling "panas".
//
// Beda dengan P6 lama (satu bar 5m: volume > $X dan naik > Y%): sinyal sekarang harus berupa BREAKOUT YANG TERKONFIRMASI,
// bukan sekadar bar hijau besar:
//   - volume bar sinyal melonjak dibanding rata-rata bar sebelumnya (bukan angka absolut saja) dan bukan lonjakan satu-bar sendirian
//   - kenaikan bar punya batas bawah DAN atas (bar parabolik = sudah terlambat)
//   - bar ditutup dekat puncaknya (bukan sumbu atas panjang) dan menembus penutupan beberapa bar terakhir
//   - harga tidak jauh di bawah puncak historisnya (bukan pantulan setelah dump)
//   - tekanan beli > jual, likuiditas tidak setipis kapitalisasi pasarnya (rawan dimanipulasi)
import { pairAgeHours } from './p6.js';

const BAR_S = 300;
const no = (status, reason, extra = {}) => ({ ok: false, status, reason, ...extra });
const round = (n, d = 2) => Number(n.toFixed(d));
const num = (v) => (v == null || v === '' ? NaN : Number(v));

export const vol5 = (token) => (Number(token?.stats5m?.buyVolume) || 0) + (Number(token?.stats5m?.sellVolume) || 0);

// Porsi volume beli pada jendela 5 menit berjalan; null bila datanya tidak ada.
export function buyRatioOf(token) {
  const b = num(token?.stats5m?.buyVolume);
  const s = num(token?.stats5m?.sellVolume);
  return Number.isFinite(b) && Number.isFinite(s) && b + s > 0 ? b / (b + s) : null;
}

// Tahap 1. Mengembalikan { ok, status, reason } atau { ok:true, status:'pass', v5, buyRatio, heat }.
export function prefilterToken(token, nowMs, cfg) {
  if (!(Number(token?.usdPrice) > 0)) return no('no_price', 'tidak ada harga');
  const age = pairAgeHours(token, nowMs);
  if (age == null) return no('age_unknown', 'umur pair tidak diketahui');
  if (age >= cfg.maxAgeHours) return no('too_old', `umur ${round(age, 1)} jam`);
  const v5 = vol5(token);
  if (v5 < cfg.minBarVolumeUsd * 0.5) return no('quiet', `volume 5m $${Math.round(v5)} masih sepi`);
  if (cfg.minLiquidityUsd > 0 && !(Number(token.liquidity) >= cfg.minLiquidityUsd)) return no('low_liquidity', `likuiditas < $${cfg.minLiquidityUsd}`);
  if (cfg.minHolders > 0 && !(Number(token.holderCount) >= cfg.minHolders)) return no('low_holders', `holder < ${cfg.minHolders}`);

  const liq = num(token.liquidity);
  const mcap = num(token.mcap);
  if (cfg.minLiqMcapPct > 0 && Number.isFinite(liq) && Number.isFinite(mcap) && mcap > 0) {
    const pct = (liq / mcap) * 100;
    if (pct < cfg.minLiqMcapPct) return no('thin_liquidity', `likuiditas hanya ${round(pct, 1)}% dari mcap (min ${cfg.minLiqMcapPct}%)`);
  }
  const buyRatio = buyRatioOf(token);
  if (cfg.minBuyRatioPct > 0 && buyRatio != null && buyRatio * 100 < cfg.minBuyRatioPct) {
    return no('sell_pressure', `porsi beli 5m ${round(buyRatio * 100, 0)}% < ${cfg.minBuyRatioPct}%`);
  }
  const traders = num(token?.stats5m?.numTraders);
  if (cfg.minTraders > 0 && Number.isFinite(traders) && traders < cfg.minTraders) return no('few_traders', `hanya ${traders} trader dalam 5m (min ${cfg.minTraders})`);

  return { ok: true, status: 'pass', v5, buyRatio, heat: v5 * (buyRatio ?? 0.5) };
}

// Tahap 2. Bentuk hasil sengaja sama dengan evaluateP6 (ageHours, barVolumeUsd, momentumPct, pre1hPct, fresh, signalClose).
export function evaluateScreen(candles, token, nowMs, cfg) {
  const age = pairAgeHours(token, nowMs);
  if (age == null) return no('age_unknown', 'umur pair tidak diketahui');
  if (age >= cfg.maxAgeHours) return no('too_old', `umur ${round(age, 1)} jam >= ${cfg.maxAgeHours} jam`, { ageHours: round(age, 2) });
  const closed = (Array.isArray(candles) ? candles : []).filter((c) => (c.time + BAR_S) * 1000 <= nowMs);
  if (!closed.length) return no('no_data', 'belum ada bar 5m yang selesai', { ageHours: round(age, 2) });

  const idx = closed.length - 1;
  const sig = closed[idx];
  const sinceCloseMs = nowMs - (sig.time + BAR_S) * 1000;
  const base = { ageHours: round(age, 2), barVolumeUsd: Math.round(sig.volume), signalAgeS: Math.round(sinceCloseMs / 1000) };
  if (sinceCloseMs > cfg.entryWindowMs) return no('stale_signal', `bar sinyal sudah ${base.signalAgeS} dtk lalu (jendela ${Math.round(cfg.entryWindowMs / 1000)} dtk)`, base);
  if (idx < cfg.minBars) return no('few_bars', `histori baru ${idx} bar 5m (minimal ${cfg.minBars})`, base);
  if (!(sig.volume > cfg.minBarVolumeUsd)) return no('low_volume', `volume bar 5m $${Math.round(sig.volume)} <= $${cfg.minBarVolumeUsd}`, base);

  // Pembanding volume dihitung per jendela waktu (bar yang tidak ada = tidak ada transaksi = 0), bukan per jumlah elemen array.
  const windowStart = sig.time - cfg.volBaselineBars * BAR_S;
  const prior = closed.filter((c) => c.time >= windowStart && c.time < sig.time);
  const active = prior.filter((c) => c.volume > 0).length;
  if (active < cfg.minActiveBars) return no('lone_spike', `hanya ${active} bar aktif sebelum sinyal (min ${cfg.minActiveBars}): lonjakan sendirian, rawan satu pelaku`, base);
  const baselineVol = prior.reduce((s, c) => s + c.volume, 0) / cfg.volBaselineBars;
  const spike = sig.volume / Math.max(baselineVol, 1);
  if (spike < cfg.volSpikeRatio) return no('weak_spike', `volume hanya ${round(spike, 1)}x rata-rata ${cfg.volBaselineBars} bar sebelumnya (min ${cfg.volSpikeRatio}x)`, { ...base, spikeRatio: round(spike, 1) });

  const momentum = (sig.close / sig.open - 1) * 100;
  const withMom = { ...base, spikeRatio: round(spike, 1), momentumPct: round(momentum, 1) };
  if (!(momentum > cfg.minMomentumPct)) return no('low_momentum', `momentum bar ${round(momentum, 1)}% <= ${cfg.minMomentumPct}%`, withMom);
  if (cfg.maxMomentumPct > 0 && momentum > cfg.maxMomentumPct) return no('parabolic', `bar naik ${round(momentum, 1)}% > ${cfg.maxMomentumPct}%: terlalu terlambat untuk masuk`, withMom);

  const range = sig.high - sig.low;
  const closeStrength = range > 0 ? ((sig.close - sig.low) / range) * 100 : 100;
  if (closeStrength < cfg.minCloseStrengthPct) return no('weak_close', `bar ditutup di ${round(closeStrength, 0)}% dari range (min ${cfg.minCloseStrengthPct}%): sumbu atas panjang`, { ...withMom, closeStrengthPct: round(closeStrength, 0) });

  const lookback = closed.slice(Math.max(0, idx - cfg.breakoutBars), idx);
  const priorHigh = Math.max(...lookback.map((c) => c.close));
  if (!(sig.close > priorHigh)) return no('no_breakout', `close belum menembus penutupan tertinggi ${cfg.breakoutBars} bar terakhir`, { ...withMom, closeStrengthPct: round(closeStrength, 0) });

  const high = Math.max(...closed.map((c) => c.high));
  const fromHigh = (1 - sig.close / high) * 100;
  if (fromHigh > cfg.maxFromHighPct) return no('far_from_high', `harga ${round(fromHigh, 0)}% di bawah puncak histori (maks ${cfg.maxFromHighPct}%): kemungkinan pantulan setelah dump`, { ...withMom, fromHighPct: round(fromHigh, 0) });

  // Harga ~1 jam sebelum sinyal (berdasarkan waktu, bukan indeks). Pair baru / tanpa histori sejam dianggap "fresh".
  const ref = [...closed].reverse().find((c) => c.time <= sig.time - 3600);
  const fresh = age < cfg.freshAgeHours || !ref;
  let pre1h = null;
  if (!fresh) {
    pre1h = (sig.open / ref.open - 1) * 100;
    if (pre1h > cfg.maxPre1hPct) return no('pumped_1h', `harga 1 jam sebelumnya ${round(pre1h, 1)}% > ${cfg.maxPre1hPct}% (sudah naik, rawan beli di puncak)`, { ...withMom, pre1hPct: round(pre1h, 1) });
  }
  return {
    ok: true, status: 'entry', signalClose: sig.close,
    reason: fresh ? 'pair baru + breakout bar 5m dengan lonjakan volume' : 'breakout bar 5m dengan lonjakan volume, harga 1 jam sebelumnya datar/turun',
    ...withMom, closeStrengthPct: round(closeStrength, 0), fromHighPct: round(fromHigh, 0), pre1hPct: pre1h == null ? null : round(pre1h, 1), fresh,
  };
}
