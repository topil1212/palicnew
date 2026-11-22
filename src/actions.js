// Aksi operator untuk Mini App. Tiap fungsi mengembalikan { ok: true, ... } atau { ok: false, error }.
// Bentuk JSON mengikuti yang dibaca frontend (src/miniapp/web/js/app.js).
import { SPEC, getSetting, setSetting } from './settings.js';
import { getState, setState } from './db.js';
import { canOpen, openPositions, realizedPnlSince } from './risk.js';
import { dayStats, wibMidnight, dailyReportData, evidenceText, briefText } from './reports.js';
import { STRATEGIES, strategyName } from './strategies.js';

const DAY = 86_400_000;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const ok = (data = {}) => ({ ok: true, ...data });
const fail = (error) => ({ ok: false, error });
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const posInt = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const parse = (text, fallback = null) => { try { return JSON.parse(text); } catch { return fallback; } };

const EXIT_LABEL = { tp: 'TP target', sl: 'Stop loss', breakeven: 'Breakeven', time: 'Waktu tahan selesai', manual: 'Manual', dead: 'Dead-exit', trail: 'Trailing', no_price: 'Harga hilang', liquidity: 'Likuiditas anjlok' };

// Pengelompokan setelan di layar. type/min/max/integer diambil dari SPEC supaya satu sumber kebenaran.
const RAW_GROUPS = [
  { id: 'intel', title: 'Scorecard & keamanan', fields: [['lp_lock_required', 'Wajib likuiditas terkunci', '', 'Hanya masuk token yang LP-nya terkunci/terbakar (data RugCheck)'], ['lp_lock_min_usd', 'Likuiditas terkunci minimum', 'USD'],['honeypot_check', 'Cek bisa-dijual sebelum masuk', '', 'Beli-lalu-jual lewat quote; tolak bila tidak ada rute jual'], ['honeypot_max_loss_pct', 'Rugi round-trip maksimum', '%'], ['liq_guard_enabled', 'Pemantau likuiditas posisi', '', 'Keluar bila likuiditas anjlok (rug / pool ditarik)'], ['liq_guard_drop_pct', 'Pemantau: turun dari saat masuk', '%'], ['liq_guard_min_usd', 'Pemantau: batas bawah likuiditas', 'USD'], ['reject_token2022', 'Tolak SEMUA Token-2022', '', 'Bawaan mati: yang berekstensi berbahaya tetap ditolak'], ['token2022_max_fee_bps', 'Pajak transfer maksimum', 'bps', '100 = 1%'], ['intel_hard_gates', 'Gerbang keamanan', '', 'Tolak mint/freeze authority aktif & data kritis hilang'], ['min_overall_score', 'Skor minimum', '', '0 = hanya dicatat']] },
  { id: 'p6', title: 'P6', fields: [['p6_size_sol', 'Ukuran posisi', 'SOL'], ['p6_max_open', 'Maks posisi terbuka'], ['p6_hold_minutes', 'Lama tahan', 'menit', 'Jual semua setelah ini; tanpa TP/SL harga'], ['p6_dead_exit_minutes', 'Dead-exit: batas waktu', 'menit', '0 = mati'], ['p6_dead_exit_pct', 'Dead-exit: kenaikan minimum', '%', 'Keluar bila belum pernah naik setinggi ini'], ['p6_trail_enabled', 'Trailing lebar', '', 'Melindungi moonshot; bukan SL harga'], ['p6_trail_arm_pct', 'Trailing aktif setelah naik', '%'], ['p6_trail_pct', 'Jarak trailing dari puncak', '%'], ['p6_min_bar_volume_usd', 'Volume bar 5m minimum', 'USD'], ['p6_min_momentum_pct', 'Kenaikan bar 5m minimum', '%'], ['p6_max_age_hours', 'Umur pair maksimum', 'jam'], ['p6_fresh_age_hours', 'Dianggap baru lahir bila lebih muda dari', 'jam'], ['p6_max_pre1h_pct', 'Harga 1 jam sebelumnya maksimum', '%', 'Untuk pair yang bukan baru lahir'], ['p6_min_bars', 'Histori minimal', 'bar 5m', 'Pair lebih muda dilewati'], ['p6_vol_spike_ratio', 'Lonjakan volume minimum', 'x', 'Dibanding rata-rata bar sebelumnya'], ['p6_vol_baseline_bars', 'Bar pembanding volume', 'bar'], ['p6_min_active_bars', 'Bar aktif sebelum sinyal', 'bar', 'Menolak lonjakan satu-bar sendirian'], ['p6_max_momentum_pct', 'Kenaikan bar maksimum', '%', 'Lebih dari ini = parabolik; 0 = mati'], ['p6_min_close_strength_pct', 'Posisi close dalam range bar', '%', 'Minimum; 100 = ditutup di puncak'], ['p6_breakout_bars', 'Breakout atas N bar', 'bar'], ['p6_max_from_high_pct', 'Jarak maksimum dari puncak', '%'], ['p6_min_buy_ratio_pct', 'Porsi beli minimum (5m)', '%', '0 = mati'], ['p6_min_traders', 'Trader unik minimum (5m)', '', 'Bila data ada; 0 = mati'], ['p6_min_liq_mcap_pct', 'Likuiditas minimum / mcap', '%', '0 = mati'], ['p6_entry_window_s', 'Jendela sinyal', 'dtk'], ['p6_max_move_pct', 'Batal bila harga bergeser', '%', 'Dari close bar sinyal; 0 = mati'], ['p6_cooldown_minutes', 'Cooldown per token', 'menit'], ['p6_min_liquidity_usd', 'Likuiditas minimum', 'USD', 'Pengaman tambahan; 0 = mati'], ['p6_min_holders', 'Holder minimum', '', '0 = mati'], ['p6_scan_max_tokens', 'Token dianalisis per scan']] },
  { id: 'risk', title: 'Risiko', fields: [['paused', 'Jeda manual', '', 'Hidup = tidak ada entry baru'], ['daily_loss_limit_sol', 'Rugi 24 jam maksimum', 'SOL', '0 = mati'], ['loss_streak_pause', 'Jeda setelah rugi beruntun', '', '0 = mati'], ['pause_minutes', 'Lama jeda', 'menit']] },
  { id: 'sim', title: 'Simulasi paper', fields: [['paper_capital_sol', 'Modal paper', 'SOL'], ['paper_slippage_pct', 'Slippage', '%'], ['paper_fee_pct', 'Fee', '%']] },
  { id: 'scan', title: 'Pemindaian', fields: [['scan_interval_s', 'Jeda antar scan', 'dtk']] },
];

const rawFields = (id) => RAW_GROUPS.find((g) => g.id === id).fields;
const GROUPS = [
  RAW_GROUPS.find((g) => g.id === 'p6'),
  RAW_GROUPS.find((g) => g.id === 'intel'),
  RAW_GROUPS.find((g) => g.id === 'risk'),
  RAW_GROUPS.find((g) => g.id === 'sim'),
  { id: 'scan', title: 'Pemindaian', fields: rawFields('scan') },
];


export function createActions({ db, engine, jup, notifier = null, live = null, now = () => Date.now(), env = process.env }) {
  let solCache = { at: 0, price: null };
  async function solUsd() {
    if (now() - solCache.at < 60_000) return solCache.price;
    try { const p = (await jup.prices([SOL_MINT]))[SOL_MINT]; solCache = { at: now(), price: p > 0 ? p : null }; } catch { solCache = { at: now(), price: solCache.price }; }
    return solCache.price;
  }

  const slip = () => getSetting(db, 'paper_slippage_pct') / 100;
  const fee = () => getSetting(db, 'paper_fee_pct');
  const netPct = (p, price) => (p.execution_mode === 'live' ? (price / p.entry_price - 1) * 100 : ((price * (1 - slip())) / p.entry_price - 1) * 100 - 2 * fee());

  // Status trailing P6 untuk layar: belum aktif (menunggu +arm%), atau aktif dengan stop saat ini (dalam % dari harga masuk).
  function trailView(p) {
    if (p.strategy !== 'p6' || !getSetting(db, 'p6_trail_enabled')) return { trailArmPct: null, trailPct: null, trailActive: false, trailStopPct: null };
    const arm = getSetting(db, 'p6_trail_arm_pct');
    const trail = getSetting(db, 'p6_trail_pct');
    const active = (p.peak_price || 0) >= p.entry_price * (1 + arm / 100);
    return { trailArmPct: arm, trailPct: trail, trailActive: active, trailStopPct: active ? (p.peak_price * (1 - trail / 100) / p.entry_price - 1) * 100 : null };
  }

  // Harga yang tidak diperbarui > 2 menit tidak dipakai menghitung untung/rugi mengambang (bisa palsu bila pool mati).
  const isBlind = (p) => p.status === 'open' && (!p.last_price || now() - (p.last_price_ms || 0) > 120_000);

  function positionView(p) {
    const open = p.status === 'open';
    const livePct = open && p.last_price && !isBlind(p) ? netPct(p, p.last_price) : null;
    const pnlPercent = open ? livePct : p.pnl_pct;
    const pnlSol = open ? (livePct == null ? null : p.size_sol * livePct / 100) : p.pnl_sol;
    const mc = (price) => (p.entry_mcap && price ? p.entry_mcap * (price / p.entry_price) : null);
    return {
      id: p.id, mint: p.mint, symbol: p.symbol, status: p.status, mode: p.execution_mode || 'dry_run', strategy: p.strategy || 'p6', strategyName: strategyName(p.strategy || 'p6'),
      holdMs: p.hold_ms ?? null, deadExitMs: p.dead_exit_ms ?? null, deadExitPct: p.dead_exit_pct ?? null,
      ...trailView(p),
      sizeSol: p.size_sol, pnlPercent: num(pnlPercent), pnlSol: num(pnlSol),
      entryMcap: num(p.entry_mcap), highMcap: num(mc(p.peak_price)), exitMcap: num(mc(p.exit_price)),
      tpPercent: p.strategy === 'p6' ? null : (p.tp_price / p.entry_price - 1) * 100, slPercent: p.strategy === 'p6' ? null : (p.sl_price / p.entry_price - 1) * 100,
      trailingEnabled: false, trailingPercent: null,
      openedAtMs: p.entry_ms, closedAtMs: p.exit_ms ?? null,
      exitReason: EXIT_LABEL[p.exit_reason] || p.exit_reason || '', exitValuation: 'quote', estimate: false,
      valuationStatus: isBlind(p) ? 'blind' : '',
      mfePercent: (p.peak_price / p.entry_price - 1) * 100, maePercent: ((p.trough_price || p.entry_price) / p.entry_price - 1) * 100,
      entrySignature: p.entry_signature || '', exitSignature: p.exit_signature || '',
    };
  }

  function walletSnapshot() {
    const capital = getSetting(db, 'paper_capital_sol');
    const realized = Number(db.prepare("SELECT COALESCE(SUM(pnl_sol),0) AS v FROM positions WHERE status='closed'").get().v);
    const open = openPositions(db);
    const used = open.reduce((s, p) => s + p.size_sol, 0);
    const unrealized = open.reduce((s, p) => s + (p.last_price && !isBlind(p) ? p.size_sol * netPct(p, p.last_price) / 100 : 0), 0);
    const closedCount = db.prepare("SELECT COUNT(*) AS n FROM positions WHERE status='closed'").get().n;
    return { capitalSol: capital, availableSol: capital + realized - used, usedSol: used, equitySol: capital + realized + unrealized, realizedSol: realized, unrealizedSol: unrealized, openCount: open.length, closedCount };
  }

  function riskView() {
    const gates = Object.keys(STRATEGIES).filter((id) => getSetting(db, STRATEGIES[id].enabledKey)).map((id) => canOpen(db, '__probe__', now(), { strategy: id }));
    const gate = gates.find((g) => g.ok) || gates[0] || { ok: false, reason: 'tidak ada strategi aktif' };
    const closed = db.prepare("SELECT pnl_sol FROM positions WHERE status='closed' AND exit_ms >= ? ORDER BY exit_ms").all(now() - 7 * DAY);
    let cum = 0, peak = 0, dd = 0;
    for (const r of closed) { cum += r.pnl_sol; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    const recent = db.prepare("SELECT pnl_sol FROM positions WHERE status='closed' ORDER BY exit_ms DESC, id DESC LIMIT 50").all();
    let streak = 0; for (const r of recent) { if (r.pnl_sol < 0) streak += 1; else break; }
    const open = openPositions(db);
    return {
      enabled: true, allowed: gate.ok, halted: getSetting(db, 'paused'), blockedBy: gate.ok ? '' : gate.reason,
      dailyPnlSol: realizedPnlSince(db, now() - DAY), maxDailyLossSol: getSetting(db, 'daily_loss_limit_sol'),
      drawdownSol: dd, maxDrawdownSol: 0, drawdownWindowDays: 7,
      consecutiveLosses: streak, maxConsecutiveLosses: getSetting(db, 'loss_streak_pause'),
      exposureSol: open.reduce((s, p) => s + p.size_sol, 0), maxExposureSol: getSetting(db, 'paper_capital_sol'),
    };
  }

  const mode = () => (getState(db, 'trading_mode', 'dry_run'));

  return {
    async overview() {
      const open = openPositions(db);
      const floating = open.reduce((s, p) => s + (p.last_price && !isBlind(p) ? p.size_sol * netPct(p, p.last_price) / 100 : 0), 0);
      const regime = parse(getState(db, 'regime', 'null')) || { regime: 'unknown', score: null, flags: [] };
      const lastEvent = db.prepare("SELECT MAX(ts) AS t FROM events WHERE kind IN ('open','skip')").get().t;
      const lastScan = engine.lastScanP6();
      return ok({
        serverTimeMs: now(), solUsd: await solUsd(), mode: mode(), agentEnabled: !getSetting(db, 'paused'),
        strategies: Object.values(STRATEGIES).map((d) => ({ id: d.id, name: d.name, enabled: Boolean(getSetting(db, d.enabledKey)), openCount: open.filter((p) => p.strategy === d.id).length, maxOpen: getSetting(db, d.maxOpenKey) })),
        walletConfigured: Boolean(live?.configured?.()),
        llm: { configured: false, usedByStrategy: false },
        strategy: { id: 'multi', name: Object.values(STRATEGIES).filter((s) => getSetting(db, s.enabledKey)).map((s) => s.name).join(' + ') || 'tidak ada', positionSizeSol: getSetting(db, 'p6_size_sol'), maxOpenPositions: getSetting(db, 'p6_max_open'), tpPercent: null, slPercent: null },
        open: { count: open.length, sizeSol: open.reduce((s, p) => s + p.size_sol, 0), pnlSol: floating },
        pendingIntents: 0,
        today: dayStats(db, wibMidnight(now())), last24h: dayStats(db, now() - DAY),
        risk: riskView(),
        book: { id: 'main', label: 'Dry run', wallet: walletSnapshot(), maxOpenPositions: getSetting(db, 'p6_max_open') },
        regime: { name: regime.regime, score: num(regime.score), flags: regime.flags || [] },
        intelMode: getSetting(db, 'min_overall_score') > 0 ? 'enforce' : 'shadow',
        lastSignalAtMs: lastScan?.at ?? lastEvent ?? null, lastCandidateAtMs: null,
      });
    },

    async activity() { return ok({ items: [] }); },

    decisionFeed({ limit = 40, outcome = '' } = {}) {
      const windowHours = 6;
      const rows = db.prepare("SELECT * FROM events WHERE ts >= ? AND kind IN ('open','close','skip') ORDER BY ts DESC LIMIT 400").all(now() - windowHours * 3_600_000);
      const map = { open: 'buy', close: 'exit', skip: 'skip' };
      const all = rows.map((r) => {
        const d = parse(r.detail, {}) || {};
        const reasons = Array.isArray(d.reasons) ? d.reasons : [String(r.detail || '')];
        return { outcome: map[r.kind], mint: r.mint || '', symbol: d.symbol || '', atMs: r.ts, reasons, moreReasons: 0, strategy: d.strategy ? strategyName(d.strategy) : '', stage: d.stage || '', positionId: d.positionId || null, candidateId: null };
      });
      const counts = { buy: 0, skip: 0, exit: 0, pending: 0 };
      for (const d of all) counts[d.outcome] += 1;
      const cap = Math.max(1, Math.min(100, Number(limit) || 40));
      return ok({ windowHours, counts, decisions: all.filter((d) => !outcome || d.outcome === outcome).slice(0, cap) });
    },

    async listPositions({ status = 'open', limit = 30 } = {}) {
      const cap = Math.max(1, Math.min(100, Number(limit) || 30));
      const rows = status === 'closed'
        ? db.prepare("SELECT * FROM positions WHERE status='closed' ORDER BY exit_ms DESC LIMIT ?").all(cap)
        : db.prepare("SELECT * FROM positions WHERE status='open' ORDER BY entry_ms DESC LIMIT ?").all(cap);
      return ok({ solUsd: await solUsd(), positions: rows.map(positionView) });
    },

    async positionDetail(id) {
      const pid = posInt(id);
      if (!pid) return fail('ID posisi tidak valid.');
      const p = db.prepare('SELECT * FROM positions WHERE id = ?').get(pid);
      if (!p) return fail('Posisi tidak ditemukan.');
      const mc = (price) => (p.entry_mcap && price ? p.entry_mcap * (price / p.entry_price) : null);
      const trades = [{ side: 'buy', atMs: p.entry_ms, mcap: num(p.entry_mcap), sizeSol: p.size_sol, reason: 'sinyal P6' }];
      if (p.status === 'closed') trades.push({ side: 'sell', atMs: p.exit_ms, mcap: num(mc(p.exit_price)), sizeSol: p.size_sol, reason: EXIT_LABEL[p.exit_reason] || p.exit_reason });
      return ok({ solUsd: await solUsd(), position: positionView(p), trades });
    },

    async closePosition(id) {
      const pid = posInt(id);
      if (!pid) return fail('ID posisi tidak valid.');
      const r = await engine.closeManually(pid);
      return r.ok ? ok({ message: 'Posisi ditutup.' }) : r;
    },

    async listIntents() { return ok({ intents: [] }); },
    async confirmIntent() { return fail('Mode konfirmasi tidak dipakai.'); },
    async declineIntent() { return fail('Mode konfirmasi tidak dipakai.'); },

    settingsView() {
      const groups = GROUPS.map((g) => ({ id: g.id, title: g.title, fields: g.fields.map(([key, label, unit = '', hint = '']) => {
        const spec = SPEC[key];
        return { key, label, hint, unit, type: spec.type === 'bool' ? 'bool' : 'number', value: getSetting(db, key), min: spec.min ?? null, max: spec.max ?? null, integer: Boolean(spec.int) };
      }) }));
      return ok({ mode: mode(), strategies: Object.values(STRATEGIES).map((d) => ({ id: d.id, name: d.name, enabled: Boolean(getSetting(db, d.enabledKey)), description: 'Strategi rahasia' })), groups });
    },

    changeSetting(key, rawValue, { actor = 'miniapp' } = {}) {
      const real = key === 'risk_halt' ? 'paused' : key;
      const r = setSetting(db, real, rawValue, actor, now());
      return r.ok ? ok({ message: 'Tersimpan.' }) : fail(r.error);
    },

    // Saklar strategi: enabled eksplisit (true/false); tanpa enabled berarti balik status. Beberapa strategi bisa aktif bersamaan.
    selectStrategy(id, { actor = 'miniapp', enabled } = {}) {
      const def = STRATEGIES[id];
      if (!def) return fail('Strategi tidak dikenal.');
      const want = typeof enabled === 'boolean' ? enabled : !getSetting(db, def.enabledKey);
      const r = setSetting(db, def.enabledKey, want, actor, now());
      return r.ok ? ok({ enabled: r.value, message: `${def.name} ${r.value ? 'ON' : 'OFF'}.` }) : fail(r.error);
    },

    async changeTradingMode(value, { actor = 'miniapp', confirmText = '' } = {}) {
      if (value === 'dry_run') { db.prepare("INSERT INTO state (key, value) VALUES ('trading_mode','dry_run') ON CONFLICT(key) DO UPDATE SET value='dry_run'").run(); return ok(); }
      if (!live) return fail('Mode live belum tersedia di Palic v2.');
      return live.enable({ value, confirmText, actor });
    },

    listChanges({ limit = 30 } = {}) {
      const rows = db.prepare('SELECT * FROM changes ORDER BY id DESC LIMIT ?').all(limit);
      return ok({ changes: rows.map((c) => ({ id: c.id, scope: 'setting', target: '', key: c.key, oldValue: c.old_value, newValue: c.new_value, atMs: c.ts, actor: c.actor || '', rolledBackBy: c.rolled_back_by || null })) });
    },

    rollbackChange(id, { actor = 'miniapp' } = {}) {
      const c = db.prepare('SELECT * FROM changes WHERE id = ?').get(posInt(id) || -1);
      if (!c) return fail('Perubahan tidak ditemukan.');
      if (c.rolled_back_by) return fail('Perubahan ini sudah dibatalkan.');
      const r = setSetting(db, c.key, c.old_value, actor, now());
      if (!r.ok) return fail(r.error);
      const newId = db.prepare('SELECT MAX(id) AS id FROM changes').get().id;
      db.prepare('UPDATE changes SET rolled_back_by = ? WHERE id = ?').run(newId, c.id);
      return ok({ message: 'Dibatalkan.' });
    },

    async dryRunWallet() {
      return ok({ solUsd: await solUsd(), mode: mode(), wallet: walletSnapshot(), walletConfigured: Boolean(live?.configured?.()), maxOpenPositions: getSetting(db, 'p6_max_open'), capitalMinSol: SPEC.paper_capital_sol.min, capitalMaxSol: SPEC.paper_capital_sol.max });
    },

    setDryRunCapital(value, { actor = 'miniapp' } = {}) {
      const r = setSetting(db, 'paper_capital_sol', value, actor, now());
      return r.ok ? ok() : fail(r.error);
    },

    async listWallets() { return ok({ wallets: [] }); },
    async walletsPnl() { return ok({ wallets: [] }); },
    addWallet() { return fail('Wallet pantauan tidak dipakai di Palic v2.'); },
    removeWallet() { return fail('Wallet pantauan tidak dipakai di Palic v2.'); },
    listLessons() { return ok({ lessons: [] }); },
    reviewLesson() { return fail('Lessons tidak dipakai di Palic v2.'); },
    async runLearningNow() { return fail('Learning tidak dipakai di Palic v2.'); },

    briefReport() { return ok({ text: briefText(db, now()) }); },
    intelReport() { return ok({ book: 'dry_run', text: evidenceText(db) }); },
    async sendDailyReportToChat() {
      if (!notifier) return fail('Telegram belum aktif.');
      await notifier.dailyReport(dailyReportData(db, wibMidnight(now()), { dateLabel: `${new Date(now() + 7 * 3_600_000).toISOString().slice(0, 10)} WIB` }));
      return ok({ message: 'Laporan harian dikirim.' });
    },
  };
}

