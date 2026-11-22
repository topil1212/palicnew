// Semua angka yang boleh diubah operator. Satu tempat: nilai bawaan, batas waras, dan penjelasan.
const num = (def, min, max, help, int = false) => ({ type: 'number', def, min, max, help, int });
const bool = (def, help) => ({ type: 'bool', def, help });

export const SPEC = {
  paper_capital_sol: num(10, 0.1, 100000, 'Modal paper (SOL)'),
  intel_hard_gates: bool(true, 'Gerbang keamanan scorecard: tolak mint/freeze authority aktif dan data kritis hilang'),
  min_overall_score: num(0, 0, 100, 'Skor scorecard minimum (0 = hanya dicatat, tidak memblokir)'),
  daily_loss_limit_sol: num(0.3, 0, 1000, 'Rugi realisasi 24 jam maksimum sebelum berhenti masuk (SOL, 0 = mati)'),
  loss_streak_pause: num(3, 0, 50, 'Jeda setelah rugi beruntun sebanyak ini (0 = mati)', true),
  pause_minutes: num(60, 1, 10080, 'Lama jeda setelah rugi beruntun (menit)'),
  paper_slippage_pct: num(1, 0, 20, 'Slippage simulasi per transaksi (%)'),
  paper_fee_pct: num(0.3, 0, 5, 'Fee simulasi per transaksi (%)'),
  scan_interval_s: num(45, 30, 3600, 'Jeda antar pemindaian (detik)', true),
  live_size_sol: num(0.05, 0.01, 1, 'Ukuran posisi LIVE (SOL) — terpisah dari ukuran paper'),
  live_slippage_pct: num(3, 0.5, 25, 'Slippage swap LIVE (%)'),
  p6_enabled: bool(true, 'Strategi P6 aktif'),
  p6_min_bar_volume_usd: num(5000, 0, 1e9, 'P6: volume bar 5m sinyal minimum (USD)'),
  p6_min_momentum_pct: num(5, 0, 1000, 'P6: kenaikan bar 5m sinyal minimum (%)'),
  p6_max_age_hours: num(6, 0.1, 168, 'P6: umur pair maksimum (jam)'),
  p6_fresh_age_hours: num(1, 0.05, 24, 'P6: pair lebih muda dari ini dianggap baru lahir (jam)'),
  p6_max_pre1h_pct: num(0, -100, 100, 'P6: perubahan harga 1 jam sebelum sinyal maksimum (%) untuk pair yang bukan baru'),
  p6_min_bars: num(4, 2, 30, 'Screening: minimal bar 5m yang sudah selesai sebagai pembanding (pair yang lebih muda dilewati)', true),
  p6_vol_spike_ratio: num(3, 1, 100, 'Screening: volume bar sinyal minimal sekian kali rata-rata bar sebelumnya'),
  p6_vol_baseline_bars: num(6, 3, 24, 'Screening: jumlah bar sebelumnya untuk rata-rata volume', true),
  p6_min_active_bars: num(2, 0, 12, 'Screening: minimal bar sebelumnya yang punya transaksi (menolak lonjakan satu-bar sendirian)', true),
  p6_max_momentum_pct: num(35, 0, 1000, 'Screening: kenaikan bar 5m maksimum (%); lebih dari ini dianggap parabolik/terlambat (0 = mati)'),
  p6_min_close_strength_pct: num(60, 0, 100, 'Screening: bar harus ditutup minimal di posisi ini dari range-nya (%, 0 = bawah, 100 = puncak)'),
  p6_breakout_bars: num(6, 2, 24, 'Screening: close sinyal harus menembus penutupan tertinggi sekian bar terakhir', true),
  p6_max_from_high_pct: num(30, 1, 100, 'Screening: maksimum jarak harga di bawah puncak histori chart (%)'),
  p6_min_buy_ratio_pct: num(55, 0, 100, 'Screening: porsi volume beli minimum pada 5 menit terakhir (%, 0 = mati)'),
  p6_min_traders: num(0, 0, 1e6, 'Screening: jumlah trader unik 5m minimum bila datanya ada (0 = mati)', true),
  p6_min_liq_mcap_pct: num(3, 0, 100, 'Screening: likuiditas minimum sebagai % dari market cap (0 = mati); terlalu tipis = mudah dimanipulasi'),
  p6_entry_window_s: num(150, 30, 600, 'P6: sinyal sah sampai sekian detik setelah bar tutup', true),
  p6_hold_minutes: num(60, 5, 1440, 'P6: lama tahan lalu jual semua (menit)'),
  p6_dead_exit_minutes: num(10, 0, 240, 'P6: dead-exit — keluar bila belum pernah naik setinggi ini dalam sekian menit (0 = mati)'),
  p6_dead_exit_pct: num(2, 0, 100, 'P6: dead-exit — kenaikan minimum dari harga masuk (%)'),
  p6_max_move_pct: num(8, 0, 100, 'P6: batal masuk bila harga real-time sudah bergeser lebih dari ini dari close bar sinyal (%, 0 = mati)'),
  p6_trail_enabled: bool(true, 'P6: trailing lebar aktif (hanya melindungi moonshot, bukan SL harga)'),
  p6_trail_arm_pct: num(200, 10, 100000, 'P6: trailing mulai bekerja setelah harga naik sejauh ini dari harga masuk (%)'),
  p6_trail_pct: num(30, 1, 90, 'P6: jual bila harga turun sejauh ini dari puncak setelah trailing aktif (%)'),
  p6_size_sol: num(0.05, 0.01, 10, 'P6: ukuran posisi (SOL)'),
  p6_max_open: num(3, 1, 20, 'P6: maks posisi terbuka', true),
  p6_cooldown_minutes: num(30, 0, 1440, 'P6: jeda sebelum token yang sama boleh dimasuki lagi (menit)'),
  liq_guard_enabled: bool(true, 'Pemantau likuiditas posisi terbuka: keluar bila likuiditas anjlok (pengaman rug / pool ditarik)'),
  liq_guard_drop_pct: num(50, 5, 95, 'Pemantau likuiditas: keluar bila likuiditas turun sebesar ini dari saat masuk (%)'),
  liq_guard_min_usd: num(500, 0, 1e9, 'Pemantau likuiditas: keluar bila likuiditas di bawah ini (USD)'),
  p6_min_liquidity_usd: num(5000, 0, 1e12, 'P6: likuiditas minimum (USD, 0 = mati) — tambahan pengaman, bukan bagian dokumen'),
  p6_min_holders: num(0, 0, 1e9, 'P6: jumlah holder minimum (0 = mati) — tambahan pengaman, bukan bagian dokumen', true),
  p6_scan_max_tokens: num(10, 1, 40, 'P6: maks token dianalisis chart-nya per pemindaian', true),
  lp_lock_required: bool(true, 'Wajib: likuiditas terkunci/terbakar (tidak bisa ditarik pembuat pool) sebelum masuk — data RugCheck'),
  lp_lock_min_usd: num(5000, 0, 1e9, 'Nilai minimum likuiditas yang terkunci/terbakar (USD) agar boleh masuk'),
  honeypot_check: bool(true, 'Cek bisa-dijual sebelum masuk (simulasi beli lalu jual lewat quote)'),
  honeypot_max_loss_pct: num(15, 1, 90, 'Rugi round-trip maksimum pada uji bisa-dijual (%)'),
  reject_token2022: bool(false, 'Tolak SEMUA token Token-2022 (bawaan: hanya tolak yang punya ekstensi berbahaya; 94% pair baru adalah Token-2022)'),
  token2022_max_fee_bps: num(300, 0, 10000, 'Pajak transfer Token-2022 maksimum yang diterima (basis poin; 100 = 1%)', true),
  paused: bool(false, 'Jeda manual: tidak ada entry baru'),
};

function parse(spec, raw) {
  if (spec.type === 'bool') {
    const t = String(raw).trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'ya'].includes(t)) return { ok: true, value: true };
    if (['false', '0', 'no', 'off', 'tidak'].includes(t)) return { ok: true, value: false };
    return { ok: false, error: 'harus true atau false' };
  }
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value)) return { ok: false, error: 'harus angka' };
  if (spec.int && !Number.isInteger(value)) return { ok: false, error: 'harus bilangan bulat' };
  if (value < spec.min || value > spec.max) return { ok: false, error: `harus antara ${spec.min} dan ${spec.max}` };
  return { ok: true, value };
}

export function getSetting(db, key) {
  const spec = SPEC[key];
  if (!spec) throw new Error(`setelan tidak dikenal: ${key}`);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return spec.def;
  const parsed = parse(spec, row.value);
  return parsed.ok ? parsed.value : spec.def;
}

export function setSetting(db, key, raw, actor = 'operator', now = Date.now()) {
  const spec = SPEC[key];
  if (!spec) return { ok: false, error: `setelan tidak dikenal: ${key}` };
  const parsed = parse(spec, raw);
  if (!parsed.ok) return { ok: false, error: `${key} ${parsed.error}` };
  const before = getSetting(db, key);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(parsed.value));
  db.prepare('INSERT INTO changes (ts, key, old_value, new_value, actor) VALUES (?, ?, ?, ?, ?)').run(now, key, String(before), String(parsed.value), actor);
  return { ok: true, value: parsed.value, before };
}

export function allSettings(db) {
  return Object.keys(SPEC).map((key) => ({ key, value: getSetting(db, key), help: SPEC[key].help, def: SPEC[key].def }));
}
