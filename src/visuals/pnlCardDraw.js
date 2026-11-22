// PALIC PnL card (1600 × 900), "Logbook" identity (see theme.js): a page of the trading log with a rubber result
// stamp, a tide gauge showing where the PnL sits, and three perforated tickets for the money.
//
// data = {
//   symbol, pnlPercent, pnlSol, pnlUsd|null, investedUsd|null, returnedUsd|null,
//   investedSol, returnedSol, holdMs, closedAtMs, paper, estimate
// }
import { C, FONT, finite, fmtPct, fmtSol, fmtUsd, paper, frame, logoMark, wave, stamp, tideBar, ticket, tag, spaced, fitFont, hashStr } from './theme.js';

export const CARD_W = 1600;
export const CARD_H = 900;

const isNum = v => typeof v === 'number' && Number.isFinite(v);

export function formatHold(ms) {
  if (!isNum(ms) || ms <= 0) return '—';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} sec`;
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h}h ${r}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
export function formatWib(ms) {
  if (!isNum(ms)) return '';
  const d = new Date(ms + 7 * 3600_000);   // WIB = UTC+7, tanpa bergantung zona waktu server
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} WIB`;
}
function verdict(pct) {
  if (pct > 0.05) return { word: 'PROFIT', color: C.teal, deep: C.tealDeep, key: 'win' };
  if (pct < -0.05) return { word: 'LOSS', color: C.clay, deep: C.clayDeep, key: 'loss' };
  return { word: 'EVEN', color: C.water, deep: C.waterDeep, key: 'flat' };
}

export function drawPnlCard(ctx, data) {
  const W = CARD_W, H = CARD_H;
  const pct = isNum(data.pnlPercent) ? data.pnlPercent : 0;
  const v = verdict(pct);
  const symbol = String(data.symbol || 'TOKEN').replace(/^\$/, '').toUpperCase();
  const seed = hashStr(`${symbol}${Math.round(pct * 100)}${data.closedAtMs || 0}`);

  paper(ctx, W, H, seed % 997);
  frame(ctx, W, H, 30);

  // ── header ────────────────────────────────────────────────────────────────
  logoMark(ctx, 70, 66, 88);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = C.ink;
  ctx.font = FONT.serif(58);
  ctx.fillText('Palic', 180, 112);
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.mono(17);
  spaced(ctx, 'TRADING LOGBOOK', 182, 142, 5);

  const mode = data.paper ? 'PAPER' : 'LIVE';
  let rightX = W - 90;
  const modeW = tag(ctx, mode, rightX, 104, { color: data.paper ? C.water : C.clay, size: 22, align: 'right' });
  const wib = formatWib(data.closedAtMs);
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.mono(21);
  ctx.textAlign = 'right';
  ctx.fillText(wib, rightX, 152);
  if (data.estimate) tag(ctx, 'ESTIMATE', rightX - modeW - 16, 104, { color: C.sun, size: 22, align: 'right' });

  // ── ticker + the big number ────────────────────────────────────────────────
  ctx.textAlign = 'left';
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.monoBold(21);
  spaced(ctx, 'CLOSED POSITION', 96, 226, 7);

  const tSize = fitFont(ctx, FONT.serif, symbol, 80, 900, 40);
  ctx.font = FONT.serif(tSize);
  ctx.fillStyle = C.ink;
  ctx.fillText(symbol, 92, 226 + tSize * 0.92);

  const pctText = fmtPct(pct, 2);
  const bigSize = fitFont(ctx, FONT.serif, pctText, 204, 1010, 90);
  const bigY = 226 + tSize * 0.92 + 22 + bigSize * 0.78;
  ctx.font = FONT.serif(bigSize);
  ctx.fillStyle = v.color;
  ctx.fillText(pctText, 86, bigY);
  const bigW = Math.min(1010, ctx.measureText(pctText).width);
  wave(ctx, 96, bigY + 24, bigW, 6, 46, v.color, 4);

  // amounts
  const solText = `${fmtSol(data.pnlSol)} SOL`;
  ctx.font = FONT.monoBold(40);
  ctx.fillStyle = v.deep;
  ctx.fillText(solText, 96, bigY + 84);
  if (finite(data.pnlUsd)) {
    const w1 = ctx.measureText(solText).width;
    ctx.font = FONT.mono(40);
    ctx.fillStyle = C.inkSoft;
    ctx.fillText(`·  ${fmtUsd(data.pnlUsd, { signed: true })}`, 96 + w1 + 22, bigY + 84);
  }

  // ── tide gauge ─────────────────────────────────────────────────────────────
  tideBar(ctx, { x: 98, y: 656, w: 900, pct, color: v.color });
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.mono(17);
  ctx.textAlign = 'left';
  spaced(ctx, 'PNL GAUGE (%)', 98, 604, 4);

  // ── result stamp ───────────────────────────────────────────────────────────
  stamp(ctx, {
    cx: 1325, cy: 385, r: 176, word: v.word, color: v.color, rot: v.key === 'loss' ? 0.12 : -0.13,
    top: 'PALIC · LOGBOOK', bottom: formatWib(data.closedAtMs).replace(' WIB', ''), seed: seed % 9973,
  });

  // ── money tickets ──────────────────────────────────────────────────────────
  const ty = 726, th = 96, tw = 452, gap = 30;
  const left = 96;
  const money = (usd, sol) => (finite(usd) ? fmtUsd(usd) : `${fmtSol(sol, 4, false)} SOL`);
  const sub = (usd, sol) => (finite(usd) && finite(sol) ? `${fmtSol(sol, 4, false)} SOL` : '');
  const tickets = [
    ['INVESTED', money(data.investedUsd, data.investedSol), sub(data.investedUsd, data.investedSol)],
    ['RETURNED', money(data.returnedUsd, data.returnedSol), sub(data.returnedUsd, data.returnedSol)],
    ['HOLD TIME', formatHold(data.holdMs), ''],
  ];
  tickets.forEach(([label, value, small], i) => {
    const x = left + i * (tw + gap);
    ticket(ctx, x, ty, tw, th);
    ctx.fillStyle = C.inkSoft;
    ctx.font = FONT.monoBold(17);
    ctx.textAlign = 'left';
    spaced(ctx, label, x + 30, ty + 30, 5);
    ctx.fillStyle = C.ink;
    const size = fitFont(ctx, FONT.serif, value, 52, tw - 60 - (small ? 150 : 0), 30);
    ctx.font = FONT.serif(size);
    ctx.fillText(value, x + 30, ty + 78);
    if (small) {
      ctx.fillStyle = C.inkSoft;
      ctx.font = FONT.mono(19);
      ctx.textAlign = 'right';
      ctx.fillText(small, x + tw - 30, ty + 78);
    }
  });

  // ── footer ─────────────────────────────────────────────────────────────────
  ctx.textAlign = 'left';
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.mono(17);
  ctx.fillText(data.paper ? 'paper simulation · not real money · not financial advice' : 'live trade · not financial advice', 98, 852);
  ctx.textAlign = 'right';
  ctx.fillText('palic', W - 98, 852);
}
