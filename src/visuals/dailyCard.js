// Daily / periodic report card (1000 px wide, height follows the number of trades): a page of the cash book.
// Same Logbook identity as the other cards (theme.js): paper, rubber stamp, tide board, tickets, ruled ledger.
import { createCanvas } from 'canvas';
import { registerCardFonts } from './fonts.js';
import { C, FONT, finite, fmtPct, fmtSol, paper, frame, logoMark, wave, stamp, ticket, tag, spaced, spacedWidth, fitFont, truncate, hashStr } from './theme.js';

const W = 1000;
const MAX_ROWS = 14;
const ROW_H = 62;

const EXIT_LABEL = {
  TP: 'TAKE PROFIT', SL: 'STOP LOSS', TRAILING_TP: 'TRAILING', MAX_HOLD: 'MAX HOLD', MANUAL: 'MANUAL',
  PARTIAL_TP: 'PARTIAL TP', SIDEWAYS_TIMEOUT: 'SIDEWAYS',
};

function normalizeReport(report = {}) {
  const best = report.bestTrade || report.best || null;
  const worst = report.worstTrade || report.worst || null;
  const positions = Array.isArray(report.positions) ? report.positions
    : Array.isArray(report.rows) ? report.rows : [];
  const mode = String(report.mode || '').toLowerCase();
  const trade = t => (t ? { symbol: String(t.symbol || 'N/A').replace(/^\$/, ''), pnlPercent: Number(t.pnlPercent || 0) } : null);
  return {
    totalTrades: Number(report.totalTrades || positions.length || 0),
    wins: Number(report.wins || 0),
    losses: Number(report.losses || 0),
    winRate: Number(report.winRate || 0),
    pnlSol: Number(report.pnlSol || 0),
    pnlPercent: Number(report.pnlPercent || 0),
    bestTrade: trade(best),
    worstTrade: trade(worst),
    avgWin: Number(report.avgWin || 0),
    avgLoss: Number(report.avgLoss || 0),
    riskReward: Number(report.riskReward || 0),
    strategy: String(report.strategy || 'SNIPER').toUpperCase(),
    positions: positions.map(p => ({
      symbol: String(p.symbol || 'TOKEN').replace(/^\$/, ''),
      pnlPercent: Number(p.pnlPercent || 0),
      pnlSol: Number(p.pnlSol || 0),
      exitReason: String(p.exitReason || p.exit_reason || '').toUpperCase(),
    })),
    // Overridable captions so the same card renders weekly / monthly reports too
    badge: String(report.badge || 'DAILY REPORT'),
    pill: String(report.pill || (mode ? (mode === 'dry_run' ? 'PAPER' : mode.toUpperCase()) : '')),
    dateLabel: String(report.dateLabel || `${new Date().toISOString().slice(0, 10)} WIB`),
  };
}

function verdict(pnlSol) {
  if (pnlSol > 0) return { word: 'PROFIT', color: C.teal, deep: C.tealDeep };
  if (pnlSol < 0) return { word: 'LOSS', color: C.clay, deep: C.clayDeep };
  return { word: 'EVEN', color: C.water, deep: C.waterDeep };
}

export async function generateDailyCard(rawReport = {}) {
  try { registerCardFonts(); } catch { /* system fonts are fine */ }
  const r = normalizeReport(rawReport);
  const v = verdict(r.pnlSol);

  const shown = r.positions.slice(0, MAX_ROWS);
  const more = r.positions.length - shown.length;
  const ledgerRows = Math.max(1, shown.length);
  const ledgerTop = 806;
  const H = ledgerTop + 96 + ledgerRows * ROW_H + (more > 0 ? 40 : 0) + (r.worstTrade ? 56 : 0) + 96;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  paper(ctx, W, H, hashStr(r.dateLabel + r.pnlSol) % 983);
  frame(ctx, W, H, 26);
  ctx.textBaseline = 'alphabetic';

  // ── header ────────────────────────────────────────────────────────────────
  logoMark(ctx, 60, 62, 76);
  ctx.textAlign = 'left';
  ctx.fillStyle = C.ink;
  ctx.font = FONT.serif(52);
  ctx.fillText('Palic', 152, 106);
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.mono(15);
  spaced(ctx, r.badge.toUpperCase(), 154, 134, 5);
  if (r.pill) tag(ctx, r.pill, W - 84, 92, { color: r.pill === 'LIVE' ? C.clay : C.water, size: 18, align: 'right' });
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.mono(18);
  ctx.textAlign = 'right';
  ctx.fillText(r.dateLabel, W - 84, 134);

  // ── hero: net result + stamp ──────────────────────────────────────────────
  ctx.textAlign = 'left';
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.monoBold(18);
  spaced(ctx, `NET RESULT · ${r.strategy}`, 84, 214, 6);
  const solText = `${fmtSol(r.pnlSol)}`;
  const size = fitFont(ctx, FONT.serif, solText, 138, 560, 70);
  ctx.font = FONT.serif(size);
  ctx.fillStyle = v.color;
  const baseY = 214 + 30 + size * 0.78;
  ctx.fillText(solText, 80, baseY);
  const sw = ctx.measureText(solText).width;
  ctx.font = FONT.serif(Math.round(size * 0.34));
  ctx.fillStyle = v.deep;
  ctx.fillText('SOL', 80 + sw + 16, baseY);
  wave(ctx, 86, baseY + 26, Math.min(560, sw + 90), 5, 40, v.color, 4);
  ctx.fillStyle = C.ink;
  ctx.font = FONT.monoBold(28);
  ctx.fillText(`${fmtPct(r.pnlPercent)} average per trade`, 84, baseY + 84);

  stamp(ctx, { cx: 808, cy: 318, r: 118, word: v.word, color: v.color, rot: r.pnlSol < 0 ? 0.1 : -0.12,
    top: 'PALIC · LOGBOOK', bottom: r.dateLabel.replace(/ WIB$/, ''), seed: hashStr(r.dateLabel) % 9973 });

  // ── tide board: wins vs losses ────────────────────────────────────────────
  const bx = 84, bw = W - 168;
  let by = 506;
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.monoBold(17);
  ctx.textAlign = 'left';
  spaced(ctx, 'TIDE BOARD · WINS / LOSSES', bx, by, 5);
  by += 30;
  const total = r.wins + r.losses;
  const winW = total ? Math.round((r.wins / total) * bw) : Math.round(bw / 2);
  ctx.fillStyle = 'rgba(21,48,46,0.08)';
  ctx.fillRect(bx, by, bw, 30);
  if (total) {
    ctx.fillStyle = C.teal;
    ctx.fillRect(bx, by, winW, 30);
    ctx.fillStyle = C.clay;
    ctx.fillRect(bx + winW, by, bw - winW, 30);
  }
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, bw, 30);
  ctx.fillStyle = C.ink;
  ctx.font = FONT.serif(34);
  ctx.textAlign = 'left';
  ctx.fillText(`${r.wins} ${r.wins === 1 ? 'win' : 'wins'}`, bx, by + 74);
  ctx.textAlign = 'right';
  ctx.fillText(`${r.losses} ${r.losses === 1 ? 'loss' : 'losses'}`, bx + bw, by + 74);
  ctx.textAlign = 'center';
  ctx.font = FONT.monoBold(24);
  ctx.fillStyle = v.deep;
  ctx.fillText(`${r.winRate.toFixed(1)}% win rate`, bx + bw / 2, by + 72);

  // ── KPI tickets ───────────────────────────────────────────────────────────
  const ky = 628, kh = 92, gap = 18, kw = (bw - gap * 3) / 4;
  const rr = r.riskReward > 0 ? `1 : ${r.riskReward.toFixed(2)}` : '—';
  const kpis = [
    ['RISK / REWARD', rr, C.ink],
    ['AVG WIN', fmtPct(r.avgWin), C.teal],
    ['AVG LOSS', fmtPct(r.avgLoss), C.clay],
    ['BEST', r.bestTrade ? `$${r.bestTrade.symbol}` : '—', C.ink],
  ];
  // shift the whole row down a little so it clears the board's captions
  kpis.forEach(([label, value, color], i) => {
    const x = bx + i * (kw + gap);
    const y = ky + 40;
    ticket(ctx, x, y, kw, kh, { notch: 10 });
    ctx.textAlign = 'left';
    ctx.fillStyle = C.inkSoft;
    ctx.font = FONT.monoBold(13);
    spaced(ctx, label, x + 18, y + 28, 3);
    ctx.fillStyle = color;
    const s = fitFont(ctx, FONT.serif, value, 36, kw - 34, 20);
    ctx.font = FONT.serif(s);
    ctx.fillText(truncate(ctx, value, kw - 34), x + 18, y + 70);
    if (i === 3 && r.bestTrade) {
      ctx.textAlign = 'right';
      ctx.fillStyle = C.teal;
      ctx.font = FONT.monoBold(15);
      ctx.fillText(fmtPct(r.bestTrade.pnlPercent), x + kw - 16, y + 28);
    }
  });

  // ── ledger ────────────────────────────────────────────────────────────────
  let ly = ledgerTop + 30;
  ctx.textAlign = 'left';
  ctx.fillStyle = C.ink;
  ctx.font = FONT.serif(40);
  ctx.fillText('Cash Book', bx, ly + 14);
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.mono(16);
  ctx.textAlign = 'right';
  ctx.fillText(`${r.totalTrades} closed ${r.totalTrades === 1 ? 'trade' : 'trades'}`, bx + bw, ly + 12);
  ly += 36;
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(bx, ly); ctx.lineTo(bx + bw, ly); ctx.stroke();
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.monoBold(14);
  ctx.textAlign = 'left';
  spaced(ctx, 'NO', bx + 6, ly + 26, 3);
  spaced(ctx, 'TOKEN', bx + 64, ly + 26, 3);
  spaced(ctx, 'EXIT REASON', bx + 300, ly + 26, 3);
  spaced(ctx, 'SOL', bx + 590, ly + 26, 3, 'right');
  spaced(ctx, 'RESULT', bx + bw - 6, ly + 26, 3, 'right');
  ly += 38;
  ctx.setLineDash([2, 5]);
  ctx.strokeStyle = C.rule;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(bx, ly); ctx.lineTo(bx + bw, ly); ctx.stroke();

  if (!shown.length) {
    ctx.setLineDash([]);
    ctx.fillStyle = C.inkSoft;
    ctx.font = FONT.serif(30);
    ctx.textAlign = 'left';
    ctx.fillText('No closed trades in this period.', bx + 6, ly + 42);
  }
  shown.forEach((p, i) => {
    const y = ly + i * ROW_H;
    const win = p.pnlSol >= 0;
    const col = win ? C.teal : C.clay;
    ctx.setLineDash([]);
    ctx.textAlign = 'left';
    ctx.fillStyle = C.inkSoft;
    ctx.font = FONT.mono(18);
    ctx.fillText(String(i + 1).padStart(2, '0'), bx + 6, y + 40);
    ctx.fillStyle = C.ink;
    ctx.font = FONT.serif(30);
    ctx.fillText(truncate(ctx, `$${p.symbol}`, 220), bx + 64, y + 42);
    ctx.fillStyle = C.inkSoft;
    ctx.font = FONT.mono(17);
    ctx.fillText(EXIT_LABEL[p.exitReason] || (p.exitReason || '—'), bx + 300, y + 40);
    ctx.fillStyle = col;
    ctx.font = FONT.monoBold(22);
    ctx.textAlign = 'right';
    ctx.fillText(fmtSol(p.pnlSol), bx + 590, y + 40);
    ctx.font = FONT.serif(34);
    ctx.fillText(fmtPct(p.pnlPercent), bx + bw - 6, y + 42);
    ctx.setLineDash([2, 5]);
    ctx.strokeStyle = C.rule;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(bx, y + ROW_H); ctx.lineTo(bx + bw, y + ROW_H); ctx.stroke();
  });
  ctx.setLineDash([]);
  let endY = ly + ledgerRows * ROW_H;
  if (more > 0) {
    ctx.fillStyle = C.inkSoft;
    ctx.font = FONT.mono(17);
    ctx.textAlign = 'left';
    ctx.fillText(`… and ${more} more ${more === 1 ? 'trade' : 'trades'}`, bx + 6, endY + 30);
    endY += 40;
  }
  if (r.worstTrade) {
    ctx.textAlign = 'left';
    ctx.fillStyle = C.inkSoft;
    ctx.font = FONT.monoBold(15);
    spaced(ctx, 'WORST', bx + 6, endY + 42, 4);
    ctx.fillStyle = C.clay;
    ctx.font = FONT.serif(26);
    const lab = `$${r.worstTrade.symbol}  ${fmtPct(r.worstTrade.pnlPercent)}`;
    ctx.fillText(lab, bx + 6 + spacedWidth(ctx, 'WORST', 4) + 34, endY + 44);
    void finite;
  }

  // ── footer ────────────────────────────────────────────────────────────────
  ctx.textAlign = 'left';
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.mono(15);
  ctx.fillText(r.pill === 'LIVE' ? 'live trade · not financial advice' : 'paper simulation · not real money · not financial advice', 84, H - 46);
  ctx.textAlign = 'right';
  ctx.fillText('palic', W - 84, H - 46);

  return canvas.toBuffer('image/png');
}

export default generateDailyCard;
