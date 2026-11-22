// Palic visual identity: "Logbook" (ship's log / ledger).
// Warm paper, deep-teal ink, the Mini App logo mark (amber cut-corner square with a P), a rubber result stamp, a tide gauge for PnL and
// perforated tickets for figures. Every card (entry, PnL, daily) is drawn from these pieces, so they read as one family.
// Only the standard Canvas 2D API is used (plus createCanvas for the worn-stamp layer).
import { createCanvas } from 'canvas';

export const C = {
  paper: '#F2EBDC',
  paperDeep: '#E8DEC8',
  ink: '#15302E',
  inkSoft: '#56706B',
  rule: '#C7B998',
  teal: '#1B7868',
  tealDeep: '#0E5548',
  clay: '#BF4F38',
  clayDeep: '#8C3322',
  sun: '#D8A02A',
  water: '#37699B',
  waterDeep: '#244B73',
};

export const FONT = {
  serif: px => `${px}px "PalicSerif", "DejaVu Serif", serif`,
  mono: px => `500 ${px}px "PalicMono", "DejaVu Sans Mono", monospace`,
  monoBold: px => `600 ${px}px "PalicMono", "DejaVu Sans Mono", monospace`,
};

// ── numbers ─────────────────────────────────────────────────────────────────
export const finite = v => v != null && Number.isFinite(Number(v));
export function fmtPct(v, dec = 2, signed = true) {
  if (!finite(v)) return '—';
  const n = Number(v);
  return `${signed ? (n > 0 ? '+' : n < 0 ? '−' : '') : ''}${Math.abs(n).toFixed(dec)}%`;
}
export function fmtSol(v, dec = 4, signed = true) {
  if (!finite(v)) return '—';
  const n = Number(v);
  return `${signed ? (n > 0 ? '+' : n < 0 ? '−' : '') : ''}${Math.abs(n).toFixed(dec)}`;
}
export function fmtUsd(v, { signed = false, compact = false } = {}) {
  if (!finite(v)) return '—';
  const n = Number(v);
  const sign = signed ? (n > 0 ? '+' : n < 0 ? '−' : '') : (n < 0 ? '−' : '');
  const a = Math.abs(n);
  if (compact) {
    if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
    if (a >= 1) return `${sign}$${a.toFixed(2)}`;
    if (a === 0) return '$0';
    if (a >= 0.001) return `${sign}$${a.toFixed(4)}`;
    return `${sign}$${a.toExponential(2)}`;
  }
  return `${sign}$${a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── deterministic noise (cards must render the same for the same data) ──────
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) {
  let h = 2166136261;
  for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// ── text ────────────────────────────────────────────────────────────────────
// Letter-spaced text (manual, so it does not depend on ctx.letterSpacing support).
export function spaced(ctx, text, x, y, spacing = 0, align = 'left') {
  const chars = [...String(text)];
  const widths = chars.map(ch => ctx.measureText(ch).width);
  const total = widths.reduce((s, w) => s + w, 0) + spacing * Math.max(0, chars.length - 1);
  let cx = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
  const prev = ctx.textAlign;
  ctx.textAlign = 'left';
  chars.forEach((ch, i) => { ctx.fillText(ch, cx, y); cx += widths[i] + spacing; });
  ctx.textAlign = prev;
  return total;
}
export function spacedWidth(ctx, text, spacing = 0) {
  const chars = [...String(text)];
  return chars.reduce((s, ch) => s + ctx.measureText(ch).width, 0) + spacing * Math.max(0, chars.length - 1);
}
// Largest font size (from `px` down to `min`) at which `text` fits `maxW`.
export function fitFont(ctx, fontFn, text, px, maxW, min = 20) {
  let size = px;
  ctx.font = fontFn(size);
  while (size > min && ctx.measureText(text).width > maxW) { size -= 2; ctx.font = fontFn(size); }
  return size;
}
export function truncate(ctx, text, maxW) {
  let t = String(text);
  if (ctx.measureText(t).width <= maxW) return t;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

// ── paper, frame ────────────────────────────────────────────────────────────
export function paper(ctx, w, h, seed = 7) {
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, w, h);
  const r = rng(seed);
  // soft light falloff towards the edges, like an old sheet
  const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75);
  vg.addColorStop(0, 'rgba(255,250,235,0.0)');
  vg.addColorStop(1, 'rgba(150,115,60,0.16)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, w, h);
  // river-map contour lines
  ctx.lineWidth = 1.4;
  const lines = Math.max(8, Math.round(h / 70));
  for (let i = 0; i < lines; i++) {
    const base = ((i + 0.5) / lines) * h;
    const a1 = 8 + r() * 14, a2 = 3 + r() * 6, p1 = r() * 6.28, p2 = r() * 6.28, f1 = 0.004 + r() * 0.004, f2 = 0.013 + r() * 0.01;
    ctx.strokeStyle = i % 4 === 0 ? 'rgba(55,105,155,0.10)' : 'rgba(21,48,46,0.055)';
    ctx.beginPath();
    for (let x = -10; x <= w + 10; x += 8) {
      const y = base + Math.sin(x * f1 + p1) * a1 + Math.sin(x * f2 + p2) * a2;
      if (x === -10) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // paper fibres and specks
  for (let i = 0; i < Math.round((w * h) / 520); i++) {
    const x = r() * w, y = r() * h, len = 5 + r() * 14, ang = r() * 6.28;
    ctx.strokeStyle = `rgba(110,80,40,${(0.04 + r() * 0.07).toFixed(3)})`;
    ctx.lineWidth = 0.6 + r() * 0.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  for (let i = 0; i < Math.round((w * h) / 2600); i++) {
    ctx.fillStyle = `rgba(90,65,30,${(0.05 + r() * 0.08).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(r() * w, r() * h, 0.5 + r() * 1.2, 0, 6.28);
    ctx.fill();
  }
}

export function frame(ctx, w, h, m = 28, color = C.ink) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.strokeRect(m, m, w - 2 * m, h - 2 * m);
  ctx.lineWidth = 1;
  ctx.strokeRect(m + 9, m + 9, w - 2 * m - 18, h - 2 * m - 18);
  ctx.fillStyle = color;
  for (const [x, y] of [[m, m], [w - m, m], [m, h - m], [w - m, h - m]]) {
    ctx.beginPath();
    ctx.arc(x, y, 6.5, 0, 6.28);
    ctx.fillStyle = C.paper;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, 6.28);
    ctx.fillStyle = color;
    ctx.fill();
  }
  ctx.restore();
}

// ── logo: the Mini App mark (amber square with the top-right corner cut off, bold "P" inside) ──
// Same geometry and colours as the SVG in src/miniapp/web/index.html (viewBox 0 0 24 24).
export const LOGO = { amber: '#f5b83d', ink: '#1a1204' };
export function logoMark(ctx, x, y, size) {
  const k = size / 24;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.fillStyle = LOGO.amber;
  ctx.beginPath();
  ctx.moveTo(3, 3); ctx.lineTo(15, 3); ctx.lineTo(21, 9); ctx.lineTo(21, 21); ctx.lineTo(3, 21);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = LOGO.ink;
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  ctx.miterLimit = 10;
  ctx.beginPath();
  ctx.moveTo(8.5, 18); ctx.lineTo(8.5, 7.5); ctx.lineTo(13.5, 7.5);
  ctx.arc(13.5, 10.75, 3.25, -Math.PI / 2, Math.PI / 2, false);
  ctx.lineTo(8.5, 14);
  ctx.stroke();
  ctx.restore();
}

// wavy "tide line" underline
export function wave(ctx, x, y, w, amp = 6, period = 46, color = C.ink, lw = 4) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i <= w; i += 3) {
    const yy = y + Math.sin((i / period) * 6.28) * amp;
    if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x + i, yy);
  }
  ctx.stroke();
  ctx.restore();
}

// ── rubber stamp (drawn on its own layer so the "worn ink" can be knocked out) ─
function arcText(g, text, cx, cy, rad, centre, spacing, bottom) {
  const chars = [...text];
  const widths = chars.map(ch => g.measureText(ch).width);
  const total = widths.reduce((s, w) => s + w, 0) + spacing * (chars.length - 1);
  const span = total / rad;
  let a = bottom ? centre + span / 2 : centre - span / 2;
  chars.forEach((ch, i) => {
    const wa = (widths[i] + (i < chars.length - 1 ? spacing : 0)) / rad;
    const mid = bottom ? a - widths[i] / rad / 2 : a + widths[i] / rad / 2;
    g.save();
    g.translate(cx + Math.cos(mid) * rad, cy + Math.sin(mid) * rad);
    g.rotate(bottom ? mid - Math.PI / 2 : mid + Math.PI / 2);
    g.textAlign = 'center';
    g.fillText(ch, 0, bottom ? 0 : 0);
    g.restore();
    a = bottom ? a - wa : a + wa;
  });
}

export function stamp(ctx, { cx, cy, r, word, top = '', bottom = '', color = C.teal, rot = -0.14, seed = 3 }) {
  const size = Math.ceil(r * 2.6);
  const layer = createCanvas(size, size);
  const g = layer.getContext('2d');
  const o = size / 2;
  g.translate(o, o);
  g.rotate(rot);
  g.translate(-o, -o);
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = r * 0.05;
  g.beginPath(); g.arc(o, o, r, 0, 6.28); g.stroke();
  g.lineWidth = r * 0.016;
  g.beginPath(); g.arc(o, o, r * 0.82, 0, 6.28); g.stroke();
  g.lineWidth = r * 0.016;
  g.beginPath(); g.arc(o, o, r * 0.56, 0, 6.28); g.stroke();
  // arc captions live in the band between the outer rings
  g.font = FONT.monoBold(Math.round(r * 0.105));
  g.textBaseline = 'middle';
  const band = r * 0.91;
  if (top) arcText(g, top, o, o, band, -Math.PI / 2, r * 0.045, false);
  if (bottom) arcText(g, bottom, o, o, band, Math.PI / 2, r * 0.045, true);
  // side stars
  for (const a of [Math.PI, 0]) {
    g.beginPath(); g.arc(o + Math.cos(a) * band, o + Math.sin(a) * band, r * 0.028, 0, 6.28); g.fill();
  }
  // the word
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let px = Math.round(r * 0.42);
  g.font = FONT.serif(px);
  while (px > 14 && g.measureText(word).width > r * 1.05) { px -= 2; g.font = FONT.serif(px); }
  g.fillText(word, o, o + px * 0.04);
  // worn ink: knock out specks and a few hairlines
  const q = rng(seed);
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < Math.round(r * 9); i++) {
    const a = q() * 6.28, d = Math.sqrt(q()) * r * 1.02;
    g.fillStyle = `rgba(0,0,0,${(0.25 + q() * 0.55).toFixed(2)})`;
    g.beginPath(); g.arc(o + Math.cos(a) * d, o + Math.sin(a) * d, 0.5 + q() * (r * 0.012), 0, 6.28); g.fill();
  }
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    const x = o - r + q() * 2 * r, y = o - r + q() * 2 * r, a = q() * 6.28, l = r * (0.15 + q() * 0.3);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.93;
  ctx.drawImage(layer, cx - o, cy - o);
  ctx.restore();
}

// ── tide gauge: PnL position on a −50%…+100% scale ──────────────────────────
export function tideBar(ctx, { x, y, w, pct, min = -50, max = 100, color = C.teal }) {
  const at = v => x + ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * w;
  const zero = at(0);
  const p = finite(pct) ? Number(pct) : 0;
  const px = at(p);
  ctx.save();
  // channel
  ctx.fillStyle = 'rgba(21,48,46,0.08)';
  ctx.fillRect(x, y - 9, w, 18);
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y + 9); ctx.lineTo(x + w, y + 9); ctx.stroke();
  // water level (zero -> pnl)
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.92;
  ctx.fillRect(Math.min(zero, px), y - 9, Math.abs(px - zero), 18);
  ctx.globalAlpha = 1;
  // ticks and labels
  ctx.fillStyle = C.inkSoft;
  ctx.strokeStyle = C.inkSoft;
  ctx.font = FONT.mono(17);
  ctx.textAlign = 'center';
  ctx.lineWidth = 1.5;
  for (let v = Math.ceil(min / 25) * 25; v <= max; v += 25) {
    const tx = at(v);
    ctx.beginPath(); ctx.moveTo(tx, y + 9); ctx.lineTo(tx, y + (v === 0 ? 24 : 18)); ctx.stroke();
    ctx.fillText(v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)}`, tx, y + 44);
  }
  // marker (pointing at the level)
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(px, y - 12);
  ctx.lineTo(px - 11, y - 32);
  ctx.lineTo(px + 11, y - 32);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = C.ink;
  ctx.fillRect(px - 1.5, y - 12, 3, 24);
  ctx.restore();
}

// ── perforated ticket (rectangle with a half-round notch on each side) ───────
export function ticket(ctx, x, y, w, h, { fill = 'rgba(232,222,200,0.55)', stroke = C.inkSoft, notch = 13 } = {}) {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h / 2 - notch);
  ctx.arc(x + w, y + h / 2, notch, -Math.PI / 2, Math.PI / 2, true);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + h / 2 + notch);
  ctx.arc(x, y + h / 2, notch, Math.PI / 2, -Math.PI / 2, true);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.setLineDash([9, 6]);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

// small bordered mono label ("PAPER", "LIVE", ...)
export function tag(ctx, text, x, y, { color = C.ink, size = 20, align = 'left', spacing = 4, pad = 14 } = {}) {
  ctx.save();
  ctx.font = FONT.monoBold(size);
  ctx.textBaseline = 'middle';
  const tw = spacedWidth(ctx, text, spacing);
  const w = tw + pad * 2, h = size + 18;
  const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(left, y - h / 2, w, h);
  ctx.fillStyle = color;
  spaced(ctx, text, left + pad, y + 1, spacing, 'left');
  ctx.restore();
  return w;
}
