// PnL card sent to Telegram when a position is sold (automatic exit or manual
// close). Green with a happy PALIC for a profit, red with a sad PALIC for a loss.
// The drawing itself lives in pnlCardDraw.js (shared with the browser preview).
import { createCanvas } from 'canvas';
import { registerCardFonts } from './fonts.js';
import { drawPnlCard, CARD_W, CARD_H } from './pnlCardDraw.js';

const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// Builds the card data from a closed position row. solUsd may be null: the card
// then shows SOL amounts instead of dollars.
export function pnlCardData(row, solUsd = null) {
  const size = num(row.size_sol) ?? 0;
  const pnlSol = num(row.pnl_sol ?? row.pnlSol) ?? 0;
  const pnlPercent = num(row.pnl_percent ?? row.pnlPercent) ?? (size > 0 ? (pnlSol / size) * 100 : 0);
  const price = num(solUsd) && solUsd > 0 ? solUsd : null;
  const returnedSol = size + pnlSol;
  const opened = num(row.opened_at_ms);
  const closed = num(row.closed_at_ms) ?? Date.now();
  return {
    symbol: row.symbol || (row.mint ? `${String(row.mint).slice(0, 4)}…${String(row.mint).slice(-4)}` : 'TOKEN'),
    pnlPercent,
    pnlSol,
    pnlUsd: price ? pnlSol * price : null,
    investedSol: size,
    returnedSol,
    investedUsd: price ? size * price : null,
    returnedUsd: price ? returnedSol * price : null,
    holdMs: opened ? closed - opened : null,
    closedAtMs: closed,
    paper: (row.execution_mode || 'dry_run') !== 'live',
    estimate: Boolean(row.exit_valuation && !['quote', 'live_fill'].includes(row.exit_valuation)),
  };
}

export async function generateExitCard(row, { solUsd = null } = {}) {
  if (!row || typeof row !== 'object') throw new Error('generateExitCard: position object is required');
  try { registerCardFonts(); } catch { /* system fonts are fine */ }
  const canvas = createCanvas(CARD_W, CARD_H);
  drawPnlCard(canvas.getContext('2d'), pnlCardData(row, solUsd));
  return canvas.toBuffer('image/png');
}

export default generateExitCard;
