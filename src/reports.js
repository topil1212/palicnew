// Statistik dari posisi tertutup: dipakai laporan teks, kartu harian, dan layar Status. Semua hanya membaca database.
const DAY = 86_400_000;
const WIB_OFFSET = 7 * 3_600_000;

export function wibMidnight(nowMs) {
  return Math.floor((nowMs + WIB_OFFSET) / DAY) * DAY - WIB_OFFSET;
}

export function closedSince(db, sinceMs) {
  return db.prepare("SELECT * FROM positions WHERE status = 'closed' AND exit_ms >= ? ORDER BY exit_ms").all(sinceMs);
}

export function dayStats(db, sinceMs) {
  const rows = closedSince(db, sinceMs);
  const wins = rows.filter((r) => r.pnl_sol > 0).length;
  const pnl = rows.reduce((s, r) => s + r.pnl_sol, 0);
  return { closed: rows.length, wins, losses: rows.length - wins, winRate: rows.length ? (wins / rows.length) * 100 : null, pnlSol: pnl };
}

export function dailyReportData(db, sinceMs, { label = 'DAILY REPORT', dateLabel } = {}) {
  const rows = closedSince(db, sinceMs);
  const wins = rows.filter((r) => r.pnl_sol > 0);
  const losses = rows.filter((r) => r.pnl_sol <= 0);
  const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const avgWin = avg(wins.map((r) => r.pnl_pct));
  const avgLoss = avg(losses.map((r) => r.pnl_pct));
  const invested = rows.reduce((s, r) => s + r.size_sol, 0);
  const pnlSol = rows.reduce((s, r) => s + r.pnl_sol, 0);
  const sorted = [...rows].sort((a, b) => b.pnl_pct - a.pnl_pct);
  const trade = (r) => (r ? { symbol: r.symbol, pnlPercent: r.pnl_pct } : null);
  return {
    totalTrades: rows.length, wins: wins.length, losses: losses.length,
    winRate: rows.length ? (wins.length / rows.length) * 100 : 0,
    pnlSol, pnlPercent: invested > 0 ? (pnlSol / invested) * 100 : 0,
    avgWin, avgLoss, riskReward: avgLoss < 0 ? avgWin / Math.abs(avgLoss) : 0,
    strategy: ([...new Set(rows.map((r) => 'P6'))].join(' + ')) || 'P6', mode: 'dry_run', badge: label, dateLabel,
    bestTrade: trade(sorted[0]), worstTrade: trade(sorted[sorted.length - 1]),
    positions: rows.map((r) => ({ symbol: r.symbol, pnlPercent: r.pnl_pct, pnlSol: r.pnl_sol, exitReason: r.exit_reason })),
  };
}

export function evidenceText(db) {
  const rows = db.prepare("SELECT * FROM positions WHERE status = 'closed'").all();
  if (!rows.length) return 'Belum ada trade tertutup, jadi belum ada bukti statistik.';
  const wins = rows.filter((r) => r.pnl_sol > 0);
  const losses = rows.filter((r) => r.pnl_sol <= 0);
  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const expectancy = mean(rows.map((r) => r.pnl_pct));
  const lines = [
    `Trade tertutup: ${rows.length} · menang ${wins.length} (${((wins.length / rows.length) * 100).toFixed(0)}%) · kalah ${losses.length}`,
    `Rata-rata menang ${mean(wins.map((r) => r.pnl_pct)).toFixed(2)}% · rata-rata kalah ${mean(losses.map((r) => r.pnl_pct)).toFixed(2)}%`,
    `Ekspektasi per trade: ${expectancy >= 0 ? '+' : ''}${expectancy.toFixed(2)}% · total ${rows.reduce((s, r) => s + r.pnl_sol, 0).toFixed(4)} SOL`,
    rows.length < 30 ? `Peringatan: baru ${rows.length} trade; di bawah 30 hasilnya belum bisa dipercaya.` : '',
    '', 'Menurut alasan exit:',
  ];
  const by = (keyFn) => {
    const map = new Map();
    for (const r of rows) { const k = keyFn(r); map.set(k, [...(map.get(k) || []), r]); }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  };
  for (const [k, rs] of by((r) => r.exit_reason || '?')) lines.push(`  ${k}: ${rs.length}x · rata-rata ${mean(rs.map((r) => r.pnl_pct)).toFixed(2)}%`);
  lines.push('', 'Menurut strategi:');
  for (const [k, rs] of by((r) => 'P6')) lines.push(`  ${k}: ${rs.length}x · menang ${rs.filter((r) => r.pnl_sol > 0).length} · rata-rata ${mean(rs.map((r) => r.pnl_pct)).toFixed(2)}% · total ${rs.reduce((s, r) => s + r.pnl_sol, 0).toFixed(4)} SOL`);
  lines.push('', 'Menurut skor scorecard saat masuk:');
  const bucket = (r) => { try { const o = JSON.parse(r.snapshot_json)?.intel?.overall; return o == null ? 'tanpa skor' : o >= 60 ? 'skor >= 60' : o >= 40 ? 'skor 40-59' : 'skor < 40'; } catch { return 'tanpa skor'; } };
  for (const [k, rs] of by(bucket)) lines.push(`  ${k}: ${rs.length}x · rata-rata ${mean(rs.map((r) => r.pnl_pct)).toFixed(2)}%`);
  return lines.filter((l) => l !== null).join('\n');
}

export function briefText(db, nowMs) {
  const since = nowMs - DAY;
  const count = (kind) => db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ? AND ts >= ?').get(kind, since).n;
  const stats = dayStats(db, since);
  const open = db.prepare("SELECT symbol, entry_price, last_price FROM positions WHERE status = 'open'").all();
  return [
    'Brief 24 jam',
    `Masuk ${count('open')} · keluar ${count('close')} · dilewati ${count('skip')}`,
    `Trade tertutup ${stats.closed} · menang ${stats.wins} · kalah ${stats.losses} · PnL ${stats.pnlSol >= 0 ? '+' : ''}${stats.pnlSol.toFixed(4)} SOL`,
    open.length ? `Terbuka: ${open.map((p) => `${p.symbol} ${p.last_price ? ((p.last_price / p.entry_price - 1) * 100).toFixed(1) + '%' : ''}`).join(', ')}` : 'Tidak ada posisi terbuka.',
  ].join('\n');
}
