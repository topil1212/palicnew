import { SPEC, allSettings, setSetting } from './settings.js';
import { realizedPnlSince, openPositions } from './risk.js';
import { fmt } from './engine.js';
import { getState } from './db.js';
import { tokenRows } from './tokenlinks.js';
import { strategyName } from './strategies.js';

const DAY = 86_400_000;
const sign = (n, d = 2) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}`;
const ago = (ms) => { const m = Math.round(ms / 60_000); return m < 90 ? `${m}m` : `${(m / 60).toFixed(1)}j`; };

export function createCommands({ db, engine, jup, now = () => Date.now() }) {
  const handlers = {
    help: () => [
      'Palic v2 · strategi P6. Kontrol penuh di Mini App (tombol menu).',
      '/status ringkasan · /posisi posisi terbuka',
      '/history [n] transaksi tertutup · /scan pindai sekarang',
      '/settings daftar setelan · /set <nama> <nilai>',
      '/pause · /resume jeda entry baru',
    ].join('\n'),
    start: () => handlers.help(),

    status() {
      const open = openPositions(db);
      const total = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(pnl_sol),0) AS pnl, COALESCE(SUM(pnl_sol > 0),0) AS wins FROM positions WHERE status='closed'").get();
      const lines = [
        `${getState(db, 'trading_mode', 'dry_run') === 'live' ? 'LIVE' : 'PAPER'} · ${open.length} posisi terbuka`,
        `PnL 24j: ${sign(realizedPnlSince(db, now() - DAY), 4)} SOL · total: ${sign(Number(total.pnl), 4)} SOL (${total.n} tutup, menang ${total.wins})`,
      ];
      const p6 = engine.lastScanP6?.();
      if (!p6) lines.push('Belum ada pemindaian.');
      if (p6) lines.push(`P6 ${ago(now() - p6.at)} lalu: ${p6.fetched} pair → ${p6.screened} kandidat → ${p6.analysed} dianalisis, ${p6.entries} masuk${p6.error ? ` · ${p6.error}` : ''}`);
      return lines.join('\n');
    },

    async posisi() {
      const open = openPositions(db);
      if (!open.length) return 'Tidak ada posisi terbuka.';
      const prices = await jup.prices(open.map((p) => p.mint)).catch(() => ({}));
      const text = open.map((p) => {
        const px = prices[p.mint];
        const pnl = px ? (px / p.entry_price - 1) * 100 : null;
        const rules = p.strategy === 'p6'
          ? `tahan ${Math.round((p.hold_ms || 0) / 60000)}m · dead-exit ${Math.round((p.dead_exit_ms || 0) / 60000)}m/+${p.dead_exit_pct}%`
          : `TP ${fmt(p.tp_price)} · SL ${fmt(p.sl_price)}${p.breakeven_done ? ' (breakeven)' : ''}`;
        return `#${p.id} ${p.symbol} [${strategyName(p.strategy)}] · masuk ${fmt(p.entry_price)} · kini ${px ? fmt(px) : '?'}${pnl == null ? '' : ` (${sign(pnl)}%)`}\n   ${rules} · ${ago(now() - p.entry_ms)}`;
      }).join('\n');
      return { text, buttons: tokenRows(open) };
    },

    history(arg) {
      const n = Math.min(30, Math.max(1, Number(arg) || 10));
      const rows = db.prepare("SELECT * FROM positions WHERE status='closed' ORDER BY exit_ms DESC LIMIT ?").all(n);
      if (!rows.length) return 'Belum ada transaksi tertutup.';
      const text = rows.map((p) => `#${p.id} ${p.symbol} [${strategyName(p.strategy)}] ${sign(p.pnl_pct)}% (${sign(p.pnl_sol, 4)} SOL) · ${p.exit_reason} · ${ago(p.exit_ms - p.entry_ms)}`).join('\n');
      return { text, buttons: tokenRows(rows) };
    },

    async scan() {
      const s = await engine.scanP6();
      return `Scan P6 selesai: ${s.fetched} pair → ${s.screened} kandidat → ${s.analysed} dianalisis. Masuk ${s.entries}.${s.error ? ` Error: ${s.error}` : ''}`;
    },

    settings() {
      return allSettings(db).map((s) => `${s.key} = ${s.value}${s.value === s.def ? '' : ` (bawaan ${s.def})`}`).join('\n');
    },

    set(arg) {
      const [key, ...rest] = String(arg || '').split(/\s+/);
      if (!key || !rest.length) return 'Format: /set <nama> <nilai>. Lihat /settings.';
      const r = setSetting(db, key, rest.join(' '), 'telegram', now());
      return r.ok ? `${key}: ${r.before} → ${r.value}` : `Ditolak: ${r.error}`;
    },

    pause: () => handlers.set('paused true'),
    resume: () => handlers.set('paused false'),
  };

  return async function handle(text) {
    const [head, ...rest] = text.trim().split(/\s+/);
    const name = head.replace(/^\//, '').replace(/@.*$/, '').toLowerCase();
    const fn = handlers[name];
    if (!fn || !Object.prototype.hasOwnProperty.call(handlers, name)) return 'Perintah tidak dikenal. /help';
    return await fn(rest.join(' '));
  };
}

export { SPEC };
