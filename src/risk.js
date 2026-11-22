import { getSetting } from './settings.js';
import { getState, setState, logEvent } from './db.js';
import { strategyOf } from './strategies.js';

const DAY_MS = 86_400_000;

export function realizedPnlSince(db, sinceMs, strategy = null) {
  const row = strategy
    ? db.prepare("SELECT COALESCE(SUM(pnl_sol), 0) AS pnl FROM positions WHERE status = 'closed' AND exit_ms >= ? AND strategy = ?").get(sinceMs, strategy)
    : db.prepare("SELECT COALESCE(SUM(pnl_sol), 0) AS pnl FROM positions WHERE status = 'closed' AND exit_ms >= ?").get(sinceMs);
  return Number(row.pnl);
}

export function openPositions(db, strategy = null) {
  return strategy
    ? db.prepare("SELECT * FROM positions WHERE status = 'open' AND strategy = ? ORDER BY id").all(strategy)
    : db.prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY id").all();
}

// Kunci state jeda per strategi.
const stateKey = (base, strategy) => `${base}_${strategy}`;

// Mengembalikan { ok: true } atau { ok: false, reason } — satu-satunya gerbang sebelum posisi dibuka.
// Batas posisi, jeda rugi beruntun dan batas rugi harian dihitung PER STRATEGI; eksposur terhadap modal dihitung total.
export function canOpen(db, mint, now = Date.now(), { strategy = 'p6' } = {}) {
  const def = strategyOf(strategy);
  if (getSetting(db, 'paused')) return { ok: false, reason: 'jeda manual aktif' };
  if (!getSetting(db, def.enabledKey)) return { ok: false, reason: `strategi ${def.name} nonaktif` };
  const pausedUntil = Number(getState(db, stateKey('pause_until', strategy), 0));
  if (pausedUntil > now) return { ok: false, reason: `jeda rugi beruntun ${def.name} sampai ${new Date(pausedUntil).toISOString().slice(11, 16)} UTC` };

  const all = openPositions(db);
  const mine = all.filter((p) => p.strategy === strategy);
  if (mine.length >= getSetting(db, def.maxOpenKey)) return { ok: false, reason: `${def.name}: sudah ${mine.length} posisi terbuka` };
  if (all.some((p) => p.mint === mint)) return { ok: false, reason: 'posisi token ini sudah terbuka' };

  const exposure = all.reduce((s, p) => s + p.size_sol, 0) + getSetting(db, def.sizeKey);
  if (exposure > getSetting(db, 'paper_capital_sol')) return { ok: false, reason: 'eksposur melebihi modal' };

  const limit = getSetting(db, 'daily_loss_limit_sol');
  if (limit > 0 && realizedPnlSince(db, now - DAY_MS, strategy) <= -limit) return { ok: false, reason: `rugi 24 jam ${def.name} sudah mencapai batas ${limit} SOL` };

  const cooldownMs = def.cooldownMs((key) => getSetting(db, key));
  if (cooldownMs > 0) {
    const last = db.prepare("SELECT exit_ms FROM positions WHERE mint = ? AND status = 'closed' ORDER BY exit_ms DESC LIMIT 1").get(mint);
    if (last && now - last.exit_ms < cooldownMs) return { ok: false, reason: 'token ini baru saja ditutup (cooldown)' };
  }
  return { ok: true };
}

// Dipanggil setelah posisi ditutup: pasang jeda kalau N posisi terakhir strategi itu (sejak jeda sebelumnya) rugi semua.
export function afterClose(db, now = Date.now(), strategy = 'p6') {
  const n = getSetting(db, 'loss_streak_pause');
  if (n <= 0) return null;
  const since = Number(getState(db, stateKey('streak_from_id', strategy), 0));
  const recent = db.prepare("SELECT id, pnl_sol FROM positions WHERE status = 'closed' AND strategy = ? AND id > ? ORDER BY exit_ms DESC, id DESC LIMIT ?").all(strategy, since, n);
  if (recent.length < n || !recent.every((p) => p.pnl_sol < 0)) return null;
  const until = now + getSetting(db, 'pause_minutes') * 60_000;
  setState(db, stateKey('pause_until', strategy), until);
  setState(db, stateKey('streak_from_id', strategy), Math.max(...recent.map((p) => p.id)));
  logEvent(db, 'loss_streak_pause', null, { strategy, reasons: [`${n} rugi beruntun (${strategyOf(strategy).name})`] }, now);
  return until;
}
