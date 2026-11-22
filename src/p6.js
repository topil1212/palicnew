// Strategi P6 (dari dokumen "Benang Merah Trenching Memecoin Solana"): pair baru + bar 5m meledak, tanpa TP/SL harga.
// Murni, tanpa I/O. Semua syarat harus benar:
//   1. umur pair < maxAgeHours (ideal < freshAgeHours)
//   2. volume bar sinyal (5m yang baru tutup) > minBarVolumeUsd
//   3. momentum bar sinyal > minMomentumPct
//   4. pair baru (< freshAgeHours / belum ada histori 1 jam) ATAU harga 1 jam sebelum sinyal <= maxPre1hPct
//   Masuk di open bar berikutnya: sinyal hanya sah sampai entryWindowMs setelah bar sinyal tutup (tanpa menunggu konfirmasi).
const BAR_S = 300;

export function pairAgeHours(token, nowMs) {
  const created = token?.firstPool?.createdAt || token?.createdAt;
  const ms = created ? Date.parse(created) : NaN;
  return Number.isFinite(ms) ? Math.max(0, (nowMs - ms) / 3_600_000) : null;
}

const no = (status, reason, extra = {}) => ({ ok: false, status, reason, ...extra });
const round = (n, d = 2) => Number(n.toFixed(d));

export function evaluateP6(candles, token, nowMs, cfg) {
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
  if (!(sig.volume > cfg.minBarVolumeUsd)) return no('low_volume', `volume bar 5m $${Math.round(sig.volume)} <= $${cfg.minBarVolumeUsd}`, base);
  const momentum = (sig.close / sig.open - 1) * 100;
  if (!(momentum > cfg.minMomentumPct)) return no('low_momentum', `momentum bar ${round(momentum, 1)}% <= ${cfg.minMomentumPct}%`, { ...base, momentumPct: round(momentum, 1) });

  const fresh = age < cfg.freshAgeHours || idx < 12;
  let pre1h = null;
  if (!fresh) {
    pre1h = (sig.open / closed[idx - 12].open - 1) * 100;
    if (pre1h > cfg.maxPre1hPct) return no('pumped_1h', `harga 1 jam sebelumnya ${round(pre1h, 1)}% > ${cfg.maxPre1hPct}% (sudah naik, rawan beli di puncak)`, { ...base, momentumPct: round(momentum, 1), pre1hPct: round(pre1h, 1) });
  }
  return { ok: true, status: 'entry', signalClose: sig.close, reason: fresh ? 'pair baru + bar 5m meledak' : 'bar 5m meledak, harga 1 jam sebelumnya datar/turun', ...base, momentumPct: round(momentum, 1), pre1hPct: pre1h == null ? null : round(pre1h, 1), fresh };
}
