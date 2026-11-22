// Entry card (1200 × 630): a boarding-pass style "entry ticket" for a freshly opened position.
// Same Logbook identity as the PnL card (theme.js). The barcode on the stub is generated from the token address,
// so every token gets its own.
import { createCanvas } from 'canvas';
import { registerCardFonts } from './fonts.js';
import { formatWib } from './pnlCardDraw.js';
import { C, FONT, finite, fmtUsd, paper, frame, logoMark, wave, ticket, tag, spaced, fitFont, truncate, rng, hashStr } from './theme.js';

const W = 1200;
const H = 630;

function parseSnapshot(position) {
  try { return JSON.parse(position.snapshot_json || '{}') || {}; } catch { return {}; }
}

function barcode(ctx, x, y, w, h, seedText) {
  const r = rng(hashStr(seedText || 'palic'));
  ctx.fillStyle = C.ink;
  let cx = x;
  while (cx < x + w - 2) {
    const bw = 2 + Math.floor(r() * 4);
    if (cx + bw > x + w) break;
    ctx.fillRect(cx, y, bw, h);
    cx += bw + 2 + Math.floor(r() * 3);
  }
}

export async function generateEntryCard(position) {
  if (!position || typeof position !== 'object') {
    throw new Error('generateEntryCard: position object is required');
  }
  try { registerCardFonts(); } catch { /* system fonts are fine */ }
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const snap = parseSnapshot(position);
  const cand = snap.candidate || {};
  const metrics = cand.metrics || {};
  const signals = cand.signals || {};
  const symbol = String(position.symbol || cand.token?.symbol || String(position.mint || 'TOKEN').slice(0, 6)).replace(/^\$/, '').toUpperCase();
  const live = position.execution_mode === 'live';
  const mint = String(position.mint || '');

  paper(ctx, W, H, hashStr(symbol) % 991);
  frame(ctx, W, H, 22);

  // ── ticket body ───────────────────────────────────────────────────────────
  const tx = 62, ty = 56, tw = W - 124, th = 478, split = 830;
  ticket(ctx, tx, ty, tw, th, { fill: 'rgba(250,244,230,0.55)', notch: 16 });
  ctx.save();
  ctx.setLineDash([4, 7]);
  ctx.strokeStyle = C.inkSoft;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(split, ty + 14); ctx.lineTo(split, ty + th - 14); ctx.stroke();
  ctx.restore();

  // header row
  logoMark(ctx, tx + 28, ty + 30, 68);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = C.ink;
  ctx.font = FONT.monoBold(21);
  spaced(ctx, 'ENTRY TICKET', tx + 112, ty + 62, 6);
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.mono(16);
  spaced(ctx, 'PALIC · TRADING LOGBOOK', tx + 112, ty + 86, 3);

  // ticker + price line
  const tSize = fitFont(ctx, FONT.serif, symbol, 104, split - tx - 90, 44);
  ctx.font = FONT.serif(tSize);
  ctx.fillStyle = C.ink;
  ctx.fillText(symbol, tx + 50, ty + 214);
  wave(ctx, tx + 52, ty + 238, Math.min(split - tx - 110, ctx.measureText(symbol).width), 4, 34, C.water, 3);

  const mcap = fmtUsd(position.entry_mcap || metrics.marketCapUsd, { compact: true });
  const price = fmtUsd(position.entry_price || metrics.priceUsd, { compact: true });
  ctx.font = FONT.mono(25);
  ctx.fillStyle = C.inkSoft;
  let px = tx + 50;
  const y2 = ty + 284;
  for (const [label, value] of [['mcap', mcap], ['price', price]]) {
    ctx.fillStyle = C.inkSoft;
    ctx.font = FONT.mono(21);
    ctx.fillText(label, px, y2);
    px += ctx.measureText(label).width + 12;
    ctx.fillStyle = C.ink;
    ctx.font = FONT.monoBold(27);
    ctx.fillText(value, px, y2);
    px += ctx.measureText(value).width + 38;
  }

  // field grid (3 × 2)
  const size = finite(position.size_sol) ? `${Number(position.size_sol).toFixed(4)} SOL` : '—';
  const tp = finite(position.tp_percent) && position.tp_percent ? `+${position.tp_percent}%` : '—';
  const sl = finite(position.sl_percent) && position.sl_percent ? `−${Math.abs(position.sl_percent)}%` : '—';
  const route = String(signals.route || 'trenches');
  const holders = finite(metrics.holderCount) ? Number(metrics.holderCount).toLocaleString('en-US') : '—';
  const cells = [
    ['LIQUIDITY', fmtUsd(metrics.liquidityUsd, { compact: true }), C.ink],
    ['HOLDERS', holders, C.ink],
    ['SIZE', size, C.ink],
    ['TAKE PROFIT', tp, C.teal],
    ['STOP LOSS', sl, C.clay],
    ['ROUTE', route, C.ink],
  ];
  const colW = 246, gx = tx + 50, gy = ty + 326;
  cells.forEach(([label, value, color], i) => {
    const cx = gx + (i % 3) * colW, cy = gy + Math.floor(i / 3) * 84;
    ctx.fillStyle = C.inkSoft;
    ctx.font = FONT.monoBold(15);
    spaced(ctx, label, cx, cy, 4);
    ctx.fillStyle = color;
    const s = fitFont(ctx, FONT.serif, value, 38, colW - 26, 22);
    ctx.font = FONT.serif(s);
    ctx.fillText(truncate(ctx, value, colW - 26), cx, cy + 38);
  });

  // ── stub ──────────────────────────────────────────────────────────────────
  const sx = split + 44, sw = tx + tw - split - 74;
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.monoBold(15);
  spaced(ctx, 'MODE', sx, ty + 70, 5);
  tag(ctx, live ? 'LIVE' : 'PAPER', sx, ty + 112, { color: live ? C.clay : C.water, size: 26, spacing: 6, pad: 16 });

  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.monoBold(15);
  spaced(ctx, 'OPENED', sx, ty + 196, 5);
  const wib = formatWib(position.opened_at_ms);
  const [dPart, tPart] = wib ? [wib.replace(/ \d\d:\d\d WIB$/, ''), (wib.match(/(\d\d:\d\d) WIB$/) || [])[1] || ''] : ['—', ''];
  ctx.fillStyle = C.ink;
  ctx.font = FONT.serif(40);
  ctx.fillText(tPart ? `${tPart} WIB` : '—', sx, ty + 244);
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.mono(19);
  ctx.fillText(dPart, sx, ty + 274);

  barcode(ctx, sx, ty + 322, sw, 70, mint || symbol);
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.mono(15);
  ctx.textAlign = 'left';
  const shortMint = mint ? `${mint.slice(0, 6)}…${mint.slice(-4)}` : '—';
  spaced(ctx, shortMint, sx, ty + 418, 2);
  if (position.id != null) {
    ctx.textAlign = 'right';
    ctx.fillText(`#${position.id}`, sx + sw, ty + 418);
  }

  // ── footer ────────────────────────────────────────────────────────────────
  ctx.textAlign = 'left';
  ctx.fillStyle = C.inkSoft;
  ctx.font = FONT.mono(16);
  ctx.fillText(live ? 'live trade · not financial advice' : 'paper simulation · not real money · not financial advice', tx + 4, H - 44);
  ctx.textAlign = 'right';
  ctx.fillText('palic', tx + tw - 4, H - 44);

  return canvas.toBuffer('image/png');
}

export default generateEntryCard;
