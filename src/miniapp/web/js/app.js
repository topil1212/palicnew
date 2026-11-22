// Palic Mini App — the control panel. Vanilla JS, no build step.
//
// Every API call carries Telegram's signed initData (Authorization: tma …); the
// server verifies it and decides. Nothing in this file is a security boundary.
// Token names and reasons come from the outside world, so all data is written
// with textContent — never innerHTML.

const tg = window.Telegram?.WebApp;
const initData = tg?.initData || '';

// ── tiny DOM helper ─────────────────────────────────────────────────────────
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
const $ = sel => document.querySelector(sel);

// ── formatting ──────────────────────────────────────────────────────────────
const isNum = v => typeof v === 'number' && Number.isFinite(v);
// Semua jumlah disimpan dalam SOL; layar menampilkan dolar memakai harga SOL yang
// dikirim server di setiap jawaban (PRICE). Tanpa harga, angka SOL jadi cadangan.
let PRICE = null;
function dollars(v, signed = false) {
  const a = Math.abs(v);
  const body = a >= 1000 ? a.toLocaleString('en-US', { maximumFractionDigits: 0 }) : a >= 1 ? a.toFixed(2) : a >= 0.01 ? a.toFixed(2) : a === 0 ? '0.00' : a.toFixed(4);
  return `${signed ? (v >= 0 ? '+' : '-') : (v < 0 ? '-' : '')}$${body}`;
}
const sol = (v, digits = 4) => (!isNum(v) ? '–' : PRICE ? dollars(v * PRICE) : `${v.toFixed(digits)} SOL`);
const signedSol = v => (!isNum(v) ? '–' : PRICE ? dollars(v * PRICE, true) : `${v >= 0 ? '+' : ''}${v.toFixed(4)} SOL`);
const pct = (v, digits = 1) => (isNum(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%` : '–');
const plainPct = v => (isNum(v) ? `${v.toFixed(0)}%` : '–');
const usd = v => {
  if (!isNum(v)) return '–';
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (Math.abs(v) >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
};
const clamp01 = v => Math.max(0, Math.min(1, Number(v) || 0));
const tone = v => (isNum(v) ? (v > 0 ? 'good' : v < 0 ? 'bad' : '') : '');
function ago(ms) {
  if (!isNum(ms)) return '–';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return `${Math.floor(s)} dtk lalu`;
  if (s < 3600) return `${Math.floor(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
}
const clock = ms => (isNum(ms) ? new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '');
const dateTime = ms => (isNum(ms) ? new Date(ms).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const shortMint = m => (m ? `${m.slice(0, 4)}…${m.slice(-4)}` : '');
const MODE_LABEL = { dry_run: 'PAPER', confirm: 'KONFIRMASI', live: 'LIVE' };

// ── feedback ────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(text, bad = false) {
  const el = $('#toast');
  el.textContent = text;
  el.className = `toast${bad ? ' bad' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 4200 : 2400);
  try { tg?.HapticFeedback?.notificationOccurred(bad ? 'error' : 'success'); } catch { /* not in Telegram */ }
}

function ask(message) {
  return new Promise(resolve => {
    if (tg?.showConfirm && tg.isVersionAtLeast?.('6.2')) tg.showConfirm(message, ok => resolve(Boolean(ok)));
    else resolve(window.confirm(message));
  });
}

// A small dialog with a text field: used where the operator must type a word.
function askTyped({ title, message, expected, danger = true }) {
  return new Promise(resolve => {
    const input = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', placeholder: expected, class: 'typed' });
    let overlay = null;
    const close = value => { overlay?.remove(); resolve(value); };
    const go = h('button', { type: 'button', class: `btn ${danger ? 'danger' : ''}`, disabled: true, onclick: () => close(input.value.trim()) }, 'Lanjutkan');
    input.addEventListener('input', () => { go.disabled = input.value.trim() !== expected; });
    overlay = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-box' },
        h('h3', { text: title }),
        h('p', { text: message }),
        h('p', { class: 'small muted' }, 'Ketik ', h('b', { text: expected }), ' untuk melanjutkan.'),
        input,
        h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn secondary', onclick: () => close(null) }, 'Batal'), go)));
    document.body.append(overlay);
    input.focus();
  });
}

// ── API ─────────────────────────────────────────────────────────────────────
class ApiError extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { authorization: `tma ${initData}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('Tidak bisa menghubungi server. Cek koneksi atau status bot.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (data && isNum(data.solUsd) && data.solUsd > 0) PRICE = data.solUsd;
  if (res.status === 401) {
    showFatal(data?.reason === 'expired'
      ? 'Sesi Mini App kedaluwarsa. Tutup lalu buka lagi Palic dari Telegram.'
      : 'Tidak terautentikasi. Buka lewat tombol menu Palic di chat bot Telegram.');
    throw new ApiError('unauthorized');
  }
  if (res.status === 403 && data?.reason === 'not_an_operator') {
    showFatal('Akun Telegram ini tidak terdaftar sebagai operator. Tambahkan ID kamu ke TELEGRAM_ADMIN_IDS di server (palic config).');
    throw new ApiError('forbidden');
  }
  if (!res.ok) throw new ApiError(data?.error || `Server menjawab ${res.status}`);
  return data || { ok: false, error: 'Jawaban server tidak terbaca.' };
}

// Runs a write and reports the outcome. Returns the result or null.
async function act(path, body = {}, { success } = {}) {
  try {
    const result = await api(path, { method: 'POST', body });
    if (!result.ok) { toast(result.error || 'Ditolak.', true); return result; }
    if (success !== false) toast(success || result.message || 'Tersimpan.');
    return result;
  } catch (err) {
    if (!(err.message === 'unauthorized' || err.message === 'forbidden')) toast(err.message, true);
    return null;
  }
}

function showFatal(message) {
  const view = $('#view');
  view.replaceChildren(h('div', { class: 'banner bad' }, message));
  stopTimers();
}

// ── navigation ──────────────────────────────────────────────────────────────
const state = { tab: 'home', param: null, renderId: 0 };
let timers = [];
function stopTimers() { for (const t of timers) clearInterval(t); timers = []; }
function every(ms, fn) { timers.push(setInterval(() => { if (!document.hidden) fn(); }, ms)); }

function go(tab, param = null, { push = true } = {}) {
  if (push && (state.tab !== tab || state.param !== param)) history.pushState({ tab, param }, '');
  state.tab = tab;
  state.param = param;
  render();
}
window.addEventListener('popstate', e => {
  const s = e.state || { tab: 'home', param: null };
  go(s.tab, s.param, { push: false });
});

function updateChrome() {
  // Rincian posisi tetap di bawah Status; rincian kandidat di bawah Screening.
  const active = state.tab === 'positions' ? 'home' : state.tab;
  for (const button of document.querySelectorAll('.tabs button')) button.classList.toggle('on', button.dataset.tab === active);
  const nested = Boolean(state.param);
  if (tg?.BackButton) { if (nested) tg.BackButton.show(); else tg.BackButton.hide(); }
}

const SCREENS = { home: statusView, positions: positionsView, settings: settingsView, wallet: walletView, more: moreView };

async function render() {
  stopTimers();
  $('#toast').hidden = true;
  updateChrome();
  const id = ++state.renderId;
  const view = $('#view');
  view.replaceChildren(h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }));
  window.scrollTo(0, 0);
  try {
    const content = await (SCREENS[state.tab] || statusView)(state.param, id);
    if (id !== state.renderId || !content) return;   // a newer screen took over
    view.replaceChildren(content);
    markSynced();
  } catch (err) {
    if (id !== state.renderId || err.message === 'unauthorized' || err.message === 'forbidden') return;
    view.replaceChildren(h('div', { class: 'banner bad' }, err.message), h('button', { class: 'btn secondary', type: 'button', onclick: render }, 'Coba lagi'));
  }
}

// Re-renders the current screen in place (keeps scroll), used by timers and after actions.
// id 0 tidak pernah sama dengan renderId, jadi layar tidak mendaftarkan timer baru setiap kali.
async function refreshInPlace() {
  const id = state.renderId;
  try {
    const content = await (SCREENS[state.tab] || statusView)(state.param, 0);
    if (id === state.renderId && content) { $('#view').replaceChildren(content); markSynced(); }
  } catch { /* the next tick or a manual refresh will try again */ }
}

// ── sync chip & pull-to-refresh (no refresh button) ─────────────────────────
// The chip shows how old the data on screen is; tapping it, or pulling the page
// down from the top, reloads the current screen in place.
let lastSyncAt = 0;
function markSynced() { lastSyncAt = Date.now(); paintSync(); }
function paintSync() {
  const chip = $('#sync'), label = $('#sync-age');
  if (!chip || chip.classList.contains('busy')) return;
  const s = lastSyncAt ? Math.floor((Date.now() - lastSyncAt) / 1000) : null;
  label.textContent = s == null ? '—' : s < 5 ? 'live' : s < 60 ? `${s}d` : `${Math.floor(s / 60)}m`;
  chip.classList.toggle('stale', s != null && s >= 60);
}
async function manualRefresh() {
  const chip = $('#sync');
  if (chip.classList.contains('busy')) return;
  chip.classList.add('busy'); $('#sync-age').textContent = 'sync';
  try { tg?.HapticFeedback?.impactOccurred('light'); } catch { /* not in Telegram */ }
  try { await refreshInPlace(); } finally { chip.classList.remove('busy'); paintSync(); }
}
function setupPullToRefresh() {
  const bar = $('#ptr'), line = bar.querySelector('span'), need = 70;
  let y0 = null, dy = 0;
  window.addEventListener('touchstart', e => { y0 = window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    line.style.width = `${Math.min(100, (dy / need) * 100)}%`;
    bar.classList.toggle('armed', dy >= need);
  }, { passive: true });
  window.addEventListener('touchend', () => {
    if (y0 != null && dy >= need) manualRefresh();
    y0 = null; dy = 0; line.style.width = '0'; bar.classList.remove('armed');
  }, { passive: true });
}

function setModePill(mode) {
  const pill = $('#mode-pill');
  pill.hidden = !mode || state.tab === 'home';   // di Status mode sudah tampil di papan
  pill.className = `pill ${mode}`;
  pill.textContent = MODE_LABEL[mode] || mode;
}

// ── shared pieces ───────────────────────────────────────────────────────────
const section = title => h('div', { class: 'section-title', text: title });
const empty = text => h('div', { class: 'empty', text });
function row({ title, sub, end, endClass = '', onclick }) {
  return h('div', { class: `row${onclick ? ' tap' : ''}`, onclick },
    h('div', { class: 'main' }, h('div', { class: 'title' }, title), sub ? h('div', { class: 'sub' }, sub) : null),
    end !== undefined ? h('div', { class: `end ${endClass}` }, end) : null,
    onclick ? h('span', { class: 'chev', text: '›' }) : null);
}
const verdictBadge = v => (v ? h('span', { class: `badge ${String(v).toLowerCase()}`, text: v }) : null);

// Saklar on/off per strategi. Mematikan hanya menghentikan entry baru; posisi yang terbuka tetap dikelola sampai selesai.
function strategyToggles(list, { title = true } = {}) {
  return h('div', {},
    title ? section('Strategi') : null,
    h('div', { class: 'list strat-list' }, list.map(s => {
      const input = h('input', { type: 'checkbox', checked: Boolean(s.enabled) });
      input.addEventListener('change', async () => {
        const want = input.checked;
        if (!want && !(await ask(`Matikan ${s.name}? Tidak ada entry baru dari strategi ini; posisi yang sedang terbuka tetap dikelola sampai selesai.`))) { input.checked = true; return; }
        const res = await act('/api/strategy', { id: s.id, enabled: want }, { success: false });
        if (res?.ok) { toast(`${s.name} ${want ? 'ON' : 'OFF'}.`); refreshInPlace(); } else input.checked = !want;
      });
      return h('div', { class: 'row strat-row' },
        h('div', { class: 'main' },
          h('div', { class: 'title' }, s.name, ' ', h('span', { class: `badge ${s.enabled ? 'buy' : ''}`, text: s.enabled ? 'ON' : 'OFF' })),
          isNum(s.openCount) ? h('div', { class: 'sub', text: `${s.openCount}${isNum(s.maxOpen) ? `/${s.maxOpen}` : ''} posisi terbuka` }) : null),
        h('label', { class: 'switch' }, input, h('span')));
    })));
}

// ── Status (layar utama) ────────────────────────────────────────────────────
// Papan kinerja di atas, lalu sub-tab: posisi terbuka, riwayat, screening, aktivitas.
// ── dry run (satu portfolio) ────────────────────────────────────────────────
// Dulu ada dua buku (tanpa KOL / KOL). Sistem KOL sudah dihapus; tinggal satu buku 'main' (server: db/books.js).
const BOOK_LABEL = { main: 'Dry run' };
const book = 'main';
function bookSwitch() { return null; }
async function bookResults() { return {}; }

function boardView(o) {
  const halted = !o.agentEnabled || (o.risk.enabled && !o.risk.allowed);
  const statusText = !o.agentEnabled ? 'Agen nonaktif' : (o.risk.enabled && !o.risk.allowed ? 'Entry dijeda' : 'Agen aktif');
  const bookMax = o.book ? o.book.maxOpenPositions : o.strategy.maxOpenPositions;
  const maxPos = isNum(bookMax) ? bookMax : 0;
  const fill = (v, max) => h('div', { class: 'meter' }, h('span', { style: `width:${max > 0 ? clamp01(v / max) * 100 : 0}%` }));
  const today = o.today;
  const pnlPct = isNum(today.pnlSol) && isNum(o.strategy.positionSizeSol) && o.strategy.positionSizeSol > 0 && today.closed
    ? (today.pnlSol / (o.strategy.positionSizeSol * today.closed)) * 100 : null;
  return h('section', { class: 'pboard' },
    h('div', { class: 'pb-top' },
      h('div', { class: 'pb-title' }, 'Hari ini · Dry run', h('span', { class: 'pb-date', text: new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) })),
      h('div', { class: 'pb-chips' },
        h('span', { class: `pb-chip ${halted ? 'warn' : 'ok'}` }, h('i'), statusText),
        h('span', { class: `pb-chip mode ${o.mode}`, text: MODE_LABEL[o.mode] || o.mode }))),
    h('div', { class: 'pb-hero' },
      h('div', {},
        h('div', { class: 'pb-label', text: 'PnL direalisasi' }),
        h('div', { class: `pb-big ${tone(today.pnlSol)}` }, signedSol(today.pnlSol))),
      h('div', { class: 'pb-side' },
        pnlPct !== null ? h('div', { class: `pb-delta ${tone(pnlPct)}`, text: `${pnlPct >= 0 ? '▲' : '▼'} ${Math.abs(pnlPct).toFixed(1)}% / trade` }) : null,
        h('div', { class: 'pb-label', text: `24 jam ${signedSol(o.last24h.pnlSol)}` }))),
    h('div', { class: 'pb-kpis' },
      h('div', { class: 'kpi' }, h('div', { class: 'pb-label', text: 'Mengambang' }), h('div', { class: `kv-num ${tone(o.open.pnlSol)}`, text: o.open.count ? signedSol(o.open.pnlSol) : '0' })),
      h('div', { class: 'kpi' }, h('div', { class: 'pb-label', text: 'Posisi' }), h('div', { class: 'kv-num', text: `${o.open.count}/${maxPos || '–'}` }), fill(o.open.count, maxPos)),
      h('div', { class: 'kpi' }, h('div', { class: 'pb-label', text: 'Win rate' }), h('div', { class: 'kv-num', text: today.closed ? plainPct(today.winRate) : '–' }), fill(today.closed ? today.winRate : 0, 100)),
      h('div', { class: 'kpi' }, h('div', { class: 'pb-label', text: 'Trade' }), h('div', { class: 'kv-num', text: `${today.closed}` }), h('div', { class: 'kpi-sub', text: `${today.wins}M · ${today.losses}K` }))),
    h('div', { class: 'pb-foot' },
      h('span', {}, h('i', { class: 'pulse' }), `Sinyal terakhir ${ago(o.lastSignalAtMs)}`),
      h('span', { text: `${o.strategy.name || o.strategy.id} · aturan` })));
}
function riskCard(o) {
  const r = o.risk;
  const lim = (v, u = null) => (isNum(v) && v > 0 ? (u === null ? sol(v) : `${v}${u}`) : 'mati');
  return h('div', {},
    h('div', { class: 'card' }, h('div', { class: 'kv' },
      h('span', { class: 'k', text: 'Status' }), h('span', { class: `v ${r.enabled ? (r.allowed ? 'good' : 'bad') : 'warn'}`, text: r.enabled ? (r.allowed ? 'Entry diizinkan' : 'Entry dijeda') : 'Nonaktif' }),
      r.blockedBy ? h('span', { class: 'k', text: 'Alasan' }) : null, r.blockedBy ? h('span', { class: 'v', text: r.blockedBy }) : null,
      h('span', { class: 'k', text: 'Rugi hari ini' }), h('span', { class: 'v', text: `${signedSol(r.dailyPnlSol)} / batas ${lim(r.maxDailyLossSol)}` }),
      h('span', { class: 'k', text: `Drawdown ${r.drawdownWindowDays ?? ''} hari` }), h('span', { class: 'v', text: `${sol(r.drawdownSol)} / ${lim(r.maxDrawdownSol)}` }),
      h('span', { class: 'k', text: 'Rugi beruntun' }), h('span', { class: 'v', text: `${r.consecutiveLosses ?? '–'} / ${lim(r.maxConsecutiveLosses, '')}` }),
      h('span', { class: 'k', text: 'Eksposur' }), h('span', { class: 'v', text: `${sol(r.exposureSol)} / ${lim(r.maxExposureSol)}` }),
      h('span', { class: 'k', text: 'Pasar' }), h('span', { class: 'v', text: !o.regime.name || o.regime.name === 'unknown' ? 'belum ada data' : o.regime.name })),
    h('div', { class: 'btns' },
      h('button', { type: 'button', class: `btn ${r.halted ? '' : 'secondary'}`, onclick: async () => {
        if (!r.halted && !(await ask('Jeda semua entry baru sekarang? Posisi terbuka tetap dipantau.'))) return;
        const res = await act('/api/settings', { key: 'risk_halt', value: !r.halted }, { success: r.halted ? 'Jeda dicabut.' : 'Entry dijeda.' });
        if (res?.ok) refreshInPlace();
      } }, r.halted ? 'Cabut jeda manual' : 'Jeda semua entry'))));
}

const STATUS_SUBS = [['open', 'Posisi open'], ['history', 'History'], ['activity', 'Aktivitas']];
let statusSub = 'open';

// Semua posisi berasal dari bot sendiri sejak sistem KOL dihapus, jadi tidak ada lencana sumber.
function sourceBadge() { return null; }

const EXIT_ICON = { 'TP target': 'TP', 'Stop loss': 'SL', Breakeven: 'BE', 'Waktu tahan selesai': 'WAKTU', 'Dead-exit': 'DEAD', Trailing: 'TRAIL', 'Harga hilang': 'HILANG', 'Likuiditas anjlok': 'LIKUID', Manual: 'MANUAL' };
const durationText = ms => {
  if (!isNum(ms) || ms < 0) return '–';
  const m = Math.round(ms / 60000);
  return m < 90 ? `${m} mnt` : m < 2880 ? `${(m / 60).toFixed(1)} jam` : `${Math.round(m / 1440)} hari`;
};

// Kartu besar: simbol + PnL di atas, lalu rincian (ukuran, mcap, TP/SL, MFE/MAE, durasi) tanpa perlu membuka rincian.
function positionCard(p) {
  const open = p.status === 'open';
  const stat = (label, value, cls = '') => h('div', { class: 'pc-stat' }, h('div', { class: 'pc-k', text: label }), h('div', { class: `pc-v ${cls}`, text: value }));
  return h('div', { class: `pcard ${isNum(p.pnlPercent) ? (p.pnlPercent > 0 ? 'up' : p.pnlPercent < 0 ? 'down' : '') : ''}`, onclick: () => go('positions', String(p.id)) },
    h('div', { class: 'pc-top' },
      h('div', { class: 'pc-sym' },
        h('span', { class: 'pc-name', text: p.symbol || shortMint(p.mint) }),
        p.mode === 'live' ? h('span', { class: 'badge live', text: 'LIVE' }) : null,
        h('span', { class: 'pc-tag strat', text: p.strategyName || p.strategy }),
        h('span', { class: 'pc-tag', text: open ? 'OPEN' : (EXIT_ICON[p.exitReason] || p.exitReason || 'TUTUP') }),
        open && p.valuationStatus === 'blind' ? h('span', { class: 'pc-tag warn', text: 'HARGA BASI' }) : null),
      h('div', { class: 'pc-pnl' }, h('div', { class: `pc-pct ${tone(p.pnlPercent)}`, text: pct(p.pnlPercent) }), h('div', { class: 'small muted', text: signedSol(p.pnlSol) }))),
    h('div', { class: 'pc-grid' },
      stat('Ukuran', sol(p.sizeSol, 3)),
      stat('Mcap masuk', usd(p.entryMcap)),
      stat(open ? 'Mcap puncak' : 'Mcap keluar', usd(open ? p.highMcap : p.exitMcap)),
      stat('Tahan', isNum(p.holdMs) ? `${Math.round(p.holdMs / 60000)} mnt` : '–'),
      isNum(p.trailPct) ? stat('Trailing', p.trailActive ? `AKTIF · stop ${pct(p.trailStopPct, 0)}` : `aktif di ${pct(p.trailArmPct, 0)}`, p.trailActive ? 'good' : '') : stat('Dead-exit', isNum(p.deadExitMs) ? `${Math.round(p.deadExitMs / 60000)} mnt/+${p.deadExitPct}%` : '–', 'bad'),
      stat('MFE / MAE', `${pct(p.mfePercent, 1)} / ${pct(p.maePercent, 1)}`)),
    h('div', { class: 'pc-foot' },
      h('span', { text: open ? `dibuka ${ago(p.openedAtMs)}` : `${dateTime(p.closedAtMs)} · tahan ${durationText(p.closedAtMs - p.openedAtMs)}` }),
      h('span', { class: 'pc-links' }, tokenLinks(p.mint), h('span', { class: 'chev', text: 'Rincian ›' }))));
}

async function positionRows(status) {
  const data = await api(`/api/positions?status=${status}${status === 'closed' ? '&limit=100' : '&limit=50'}&book=${book}`);
  if (!data.ok) throw new ApiError(data.error);
  if (!data.positions.length) return empty(status === 'open' ? 'Tidak ada posisi terbuka.' : 'Belum ada posisi yang ditutup.');
  const wins = data.positions.filter(p => isNum(p.pnlSol) && p.pnlSol > 0).length;
  const total = data.positions.reduce((s, p) => s + (isNum(p.pnlSol) ? p.pnlSol : 0), 0);
  return h('div', {},
    status === 'closed' ? h('div', { class: 'pc-sum' },
      h('span', { text: `${data.positions.length} trade` }), h('span', { text: `menang ${wins}` }), h('span', { text: `kalah ${data.positions.length - wins}` }),
      h('span', { class: tone(total), text: signedSol(total) })) : null,
    data.positions.map(positionCard));
}

const OUTCOME_TAG = { buy: 'BUY', skip: 'SKIP', exit: 'EXIT', pending: 'PROSES' };
const STAGE_TEXT = { screening: 'ditolak di screening', eksekusi: 'dibatalkan saat eksekusi', keputusan: 'di keputusan' };

function decisionCard(d) {
  const key = `${d.outcome}:${d.mint}:${d.atMs}`;
  const open = activityOpen.has(key);
  const shown = open ? d.reasons : d.reasons.slice(0, 3);
  const hidden = d.reasons.length - shown.length;
  const target = d.positionId ? () => go('positions', String(d.positionId)) : undefined;
  return h('div', { class: `act ${d.outcome}${target ? ' tap' : ''}`, onclick: target },
    h('div', { class: 'a-top' },
      h('span', { class: 'a-sym', text: d.symbol || shortMint(d.mint) || '–' }),
      h('span', { class: `a-tag ${d.outcome}`, text: OUTCOME_TAG[d.outcome] || d.outcome }),
      d.strategy ? h('span', { class: 'a-stage', text: d.strategy }) : null,
      d.stage && d.outcome === 'skip' ? h('span', { class: 'a-stage', text: STAGE_TEXT[d.stage] || d.stage }) : null,
      h('span', { class: 'a-time', text: ago(d.atMs) }),
      tokenLinks(d.mint)),
    h('ul', { class: 'a-reasons' }, shown.map(r => h('li', { text: r }))),
    d.moreReasons ? h('div', { class: 'small muted', text: `+${d.moreReasons} alasan lain` }) : null,
    d.reasons.length > 3 ? h('button', {
      type: 'button', class: 'a-more',
      onclick: event => { event.stopPropagation(); if (open) activityOpen.delete(key); else activityOpen.add(key); refreshInPlace(); },
    }, open ? 'Sembunyikan' : `+${hidden} alasan lagi`) : null);
}

async function activityRows() {
  const data = await api(`/api/decisions?limit=60${activityFilter === 'all' ? '' : `&outcome=${activityFilter}`}`);
  if (!data.ok) throw new ApiError(data.error);
  const c = data.counts || {};
  const total = (c.buy || 0) + (c.skip || 0) + (c.exit || 0) + (c.pending || 0);
  const filters = [['all', 'SEMUA', total], ['buy', 'BUY', c.buy || 0], ['skip', 'SKIP', c.skip || 0], ['exit', 'EXIT', c.exit || 0]];
  const list = data.decisions;   // sudah difilter di server
  return h('div', {},
    h('div', { class: 'fchips' }, filters.map(([key, label, n]) => h('button', {
      type: 'button', class: activityFilter === key ? 'on' : '',
      onclick: () => { activityFilter = key; refreshInPlace(); },
    }, `${label} ${n}`))),
    list.length ? list.map(decisionCard) : empty('Belum ada keputusan bot dalam beberapa jam terakhir.'),
    h('p', { class: 'act-note', text: `Alasan diambil dari catatan bot dalam ${data.windowHours} jam terakhir. Token yang dilewati sebelum screening (mis. batas posisi penuh atau risk engine menjeda entry) tidak dicatat per token.` }));
}

async function statusBody(sub) {
  try {
    if (sub === 'history') return await positionRows('closed');
    if (sub === 'activity') return await activityRows();
    return await positionRows('open');
  } catch (err) {
    if (err.message === 'unauthorized' || err.message === 'forbidden') throw err;
    return h('div', { class: 'banner bad' }, err.message);
  }
}

async function statusView(_, id) {
  const [overview, intents, results] = await Promise.all([api(`/api/overview?book=${book}`), api('/api/intents').catch(() => ({ ok: false })), bookResults()]);
  if (!overview.ok) throw new ApiError(overview.error);
  setModePill(overview.mode);
  const pending = intents.ok ? intents.intents : [];
  const wallet = overview.mode === 'dry_run' ? (overview.book?.wallet || null) : null;
  const body = await statusBody(statusSub);
  if (id === state.renderId) {
    every(15_000, refreshInPlace);
    every(20_000, updateIntentBadge);
    updateIntentBadge();
  }
  return h('div', {},
    boardView(overview),
    wallet ? h('div', { class: 'list' }, row({
      title: 'Wallet dry run',
      sub: `Modal ${sol(wallet.capitalSol, 3)} · tersedia ${sol(wallet.availableSol, 3)}`,
      end: h('div', { class: tone(wallet.equitySol - wallet.capitalSol), text: sol(wallet.equitySol, 3) }),
      onclick: () => go('wallet'),
    })) : null,
    overview.strategies?.length ? strategyToggles(overview.strategies, { title: false }) : null,
    pending.length ? [section(`Menunggu konfirmasi (${pending.length})`), pending.map(intentCard)] : null,
    h('div', { class: 'subtabs' }, STATUS_SUBS.map(([key, label]) => h('button', {
      type: 'button', class: statusSub === key ? 'on' : '',
      onclick: () => { statusSub = key; refreshInPlace(); },
    }, label))),
    body);
}

// Jumlah konfirmasi yang menunggu, sebagai badge di tab Status.
async function updateIntentBadge() {
  try {
    const data = await api('/api/intents');
    const n = data.ok ? data.intents.length : 0;
    const tab = document.querySelector('.tabs button[data-tab=home]');
    let badge = tab.querySelector('.dot');
    if (!n) { badge?.remove(); return; }
    if (!badge) { badge = h('span', { class: 'dot' }); tab.append(badge); }
    badge.textContent = String(n);
  } catch { /* ignore */ }
}

function intentCard(intent) {
  const expires = isNum(intent.expiresAtMs) ? Math.max(0, Math.round((intent.expiresAtMs - Date.now()) / 60000)) : null;
  return h('div', { class: 'card' },
    h('div', { class: 'row', style: 'padding:0;border:0;min-height:0' },
      h('div', { class: 'main' },
        h('div', { class: 'title' }, intent.symbol || shortMint(intent.mint), ' ', h('span', { class: 'muted small', text: `#${intent.id}` })),
        h('div', { class: 'sub', text: `${sol(intent.sizeSol, 3)} · confidence ${plainPct(intent.confidence)}${expires !== null ? ` · kedaluwarsa ${expires} mnt` : ''}` }))),
    intent.reason ? h('p', { class: 'small', text: intent.reason }) : null,
    h('div', { class: 'btns' },
      h('button', { type: 'button', class: 'btn secondary', onclick: async () => {
        const res = await act(`/api/intents/${intent.id}/reject`, {});
        if (res?.ok) refreshInPlace();
      } }, 'Tolak'),
      h('button', { type: 'button', class: 'btn danger', onclick: async event => {
        if (!(await ask(`Beli ${intent.symbol || shortMint(intent.mint)} sebesar ${sol(intent.sizeSol, 3)} dengan dana sungguhan?`))) return;
        event.target.disabled = true;
        event.target.textContent = 'Mengeksekusi…';
        const res = await act(`/api/intents/${intent.id}/confirm`, {});
        if (res) refreshInPlace(); else event.target.disabled = false;
      } }, 'Konfirmasi beli')));
}

// ── Posisi ──────────────────────────────────────────────────────────────────
// Daftar posisi kini sub-tab di Status; rincian satu posisi tetap layar sendiri.
async function positionsView(param, id) {
  if (param) return positionDetailView(param);
  statusSub = 'open';
  return statusView(null, id);
}

async function positionDetailView(positionId) {
  const data = await api(`/api/positions/${encodeURIComponent(positionId)}`);
  if (!data.ok) throw new ApiError(data.error);
  const p = data.position;
  const open = p.status === 'open';
  const out = [];
  out.push(h('div', { class: 'card' },
    h('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:8px' },
      h('div', { style: 'flex:1' }, h('div', { style: 'font-weight:800;font-size:18px', text: p.symbol || shortMint(p.mint) }), h('div', { class: 'mono muted', text: p.mint })),
      h('div', { style: 'text-align:right' }, h('div', { class: tone(p.pnlPercent), style: 'font-weight:800;font-size:20px', text: pct(p.pnlPercent) }), h('div', { class: 'small muted', text: signedSol(p.pnlSol) }))),
    p.valuationStatus === 'blind' ? h('div', { class: 'banner warn' }, 'Tidak ada quote/harga saat ini — nilai terakhir yang diketahui.') : null,
    p.estimate ? h('div', { class: 'banner warn' }, `PnL ini estimasi (${p.exitValuation}), bukan hasil fill.`) : null,
    h('div', { class: 'kv' },
      h('span', { class: 'k', text: 'Status' }), h('span', { class: 'v', text: `${open ? 'Terbuka' : 'Ditutup'} · ${p.mode === 'live' ? 'LIVE' : 'paper'}` }),
      h('span', { class: 'k', text: 'Strategi' }), h('span', { class: 'v', text: p.strategyName || p.strategy || '–' }),
      h('span', { class: 'k', text: 'Ukuran' }), h('span', { class: 'v', text: sol(p.sizeSol, 3) }),
      h('span', { class: 'k', text: 'Mcap entry' }), h('span', { class: 'v', text: usd(p.entryMcap) }),
      h('span', { class: 'k', text: 'Mcap tertinggi' }), h('span', { class: 'v', text: usd(p.highMcap) }),
      !open ? h('span', { class: 'k', text: 'Mcap exit' }) : null, !open ? h('span', { class: 'v', text: usd(p.exitMcap) }) : null,
      h('span', { class: 'k', text: 'MFE / MAE' }), h('span', { class: 'v', text: `${pct(p.mfePercent)} / ${pct(p.maePercent)}` }),
      h('span', { class: 'k', text: 'Dibuka' }), h('span', { class: 'v', text: dateTime(p.openedAtMs) }),
      !open ? h('span', { class: 'k', text: 'Exit' }) : null, !open ? h('span', { class: 'v', text: `${p.exitReason} · ${dateTime(p.closedAtMs)}` }) : null),
    h('div', { class: 'btns' },
      h('a', { class: 'btn small secondary', href: `https://gmgn.ai/sol/token/${encodeURIComponent(p.mint)}`, target: '_blank', rel: 'noopener', onclick: openExternal }, 'GMGN'),
      h('button', { type: 'button', class: 'btn small secondary', onclick: event => copyCa(event, p.mint) }, 'CA'),
      p.entrySignature ? h('a', { class: 'btn small secondary', href: `https://solscan.io/tx/${encodeURIComponent(p.entrySignature)}`, target: '_blank', rel: 'noopener', onclick: openExternal }, 'Tx entry') : null,
      p.exitSignature ? h('a', { class: 'btn small secondary', href: `https://solscan.io/tx/${encodeURIComponent(p.exitSignature)}`, target: '_blank', rel: 'noopener', onclick: openExternal }, 'Tx exit') : null)));

  if (open) {
    out.push(section('Aturan exit'));
    out.push(h('div', { class: 'card' }, h('div', { class: 'small', text: `P6: tanpa TP/SL harga. Dijual semua setelah ${Math.round((p.holdMs || 0) / 60000)} menit; dead-exit bila dalam ${Math.round((p.deadExitMs || 0) / 60000)} menit pertama harga belum pernah naik +${p.deadExitPct}% dari harga masuk.${isNum(p.trailPct) ? ` Trailing ${p.trailPct}% dari puncak, baru aktif setelah naik +${p.trailArmPct}%${p.trailActive ? ` (sudah aktif, stop sekarang ${pct(p.trailStopPct, 0)} dari harga masuk).` : '.'}` : ''}` })));
    out.push(h('button', { type: 'button', class: 'btn danger', onclick: async event => {
      if (!(await ask(`Tutup posisi ${p.mode === 'live' ? 'LIVE' : 'paper'} ${p.symbol || ''} sekarang?`))) return;
      event.target.disabled = true;
      const res = await act(`/api/positions/${p.id}/close`, {}, { success: 'Posisi ditutup.' });
      if (res?.ok) refreshInPlace(); else event.target.disabled = false;
    } }, p.mode === 'live' ? 'Jual sekarang' : 'Tutup posisi'));
  }

  if (data.trades.length) {
    out.push(section('Transaksi'));
    out.push(h('div', { class: 'list' }, data.trades.map(t => row({
      title: `${t.side === 'buy' ? 'Beli' : 'Jual'}${t.reason ? ` · ${t.reason}` : ''}`,
      sub: dateTime(t.atMs), end: `${usd(t.mcap)}`, endClass: 'small muted',
    }))));
  }
  return h('div', {}, out);
}

function openExternal(event) {
  if (!tg?.openLink) return;
  event.preventDefault();
  tg.openLink(event.currentTarget.href);
}

// Menyalin teks ke clipboard (Clipboard API, lalu cadangan lewat textarea untuk WebView yang membatasinya).
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* lanjut ke cadangan */ }
  try {
    const area = h('textarea', { style: 'position:fixed;top:-1000px;opacity:0', readonly: true });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch { return false; }
}

async function copyCa(event, mint) {
  event.stopPropagation();
  event.preventDefault();
  toast((await copyText(mint)) ? 'CA disalin.' : 'Gagal menyalin CA.', false);
}

// Tombol GMGN + CA untuk satu token. Dipakai di setiap tempat yang menyebut token; klik tidak ikut membuka rincian kartunya.
function tokenLinks(mint) {
  if (!mint) return null;
  return h('span', { class: 'tok-links' },
    h('a', { class: 'btn small secondary gmgn', href: `https://gmgn.ai/sol/token/${encodeURIComponent(mint)}`, target: '_blank', rel: 'noopener', onclick: event => { event.stopPropagation(); openExternal(event); } }, 'GMGN'),
    h('button', { type: 'button', class: 'btn small secondary ca', onclick: event => copyCa(event, mint) }, 'CA'));
}

// ── Setelan ─────────────────────────────────────────────────────────────────
const openGroups = new Set(['p6']);

function msToMinutes(field) {
  return field.unit === 'ms';
}

function fieldControl(field) {
  const save = async (value, revert) => {
    const res = await act('/api/settings', { key: field.key, value }, { success: `${field.label} disimpan.` });
    if (!res?.ok) revert();
  };
  if (field.type === 'bool') {
    const input = h('input', { type: 'checkbox', checked: Boolean(field.value) });
    input.addEventListener('change', () => save(input.checked, () => { input.checked = !input.checked; }));
    return h('label', { class: 'switch' }, input, h('span'));
  }
  if (field.type === 'enum') {
    const select = h('select', {}, field.options.map(option => h('option', { value: option, selected: option === field.value }, option)));
    let previous = select.value;
    select.addEventListener('change', () => save(select.value, () => { select.value = previous; }).then(() => { previous = select.value; }));
    return select;
  }
  const minutes = msToMinutes(field);
  const inDollars = field.unit === 'SOL' && PRICE > 0;   // disimpan dalam SOL, diisi dalam dolar
  const shown = v => (v === null || v === undefined || v === '' ? '' : minutes ? +(Number(v) / 60000).toFixed(3) : inDollars ? +(Number(v) * PRICE).toFixed(2) : v);
  const input = h('input', {
    type: field.type === 'number' ? 'number' : 'text',
    inputmode: field.type === 'number' ? 'decimal' : 'text',
    step: field.integer && !minutes && !inDollars ? '1' : 'any',
    value: shown(field.value),
  });
  let committed = input.value;
  const commit = () => {
    if (input.value === committed || input.value.trim() === '') { input.value = committed; input.classList.remove('dirty'); return; }
    const raw = input.value.trim();
    const value = minutes ? Math.round(Number(raw) * 60000) : inDollars ? +(Number(raw) / PRICE).toFixed(6) : (field.type === 'number' ? Number(raw) : raw);
    input.classList.remove('dirty');
    const before = committed;
    committed = input.value;
    save(value, () => { input.value = before; committed = before; });
  };
  input.addEventListener('input', () => input.classList.toggle('dirty', input.value !== committed));
  input.addEventListener('change', commit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
  return input;
}

function boundsHint(field) {
  if (field.type !== 'number' || !isNum(field.min) || !isNum(field.max)) return '';
  const f = v => (msToMinutes(field) ? +(v / 60000).toFixed(2) : field.unit === 'SOL' && PRICE ? dollars(v * PRICE) : v);
  return `${f(field.min)} – ${f(field.max)}`;
}

async function settingsView() {
  const data = await api('/api/settings');
  if (!data.ok) throw new ApiError(data.error);
  setModePill(data.mode);
  const out = [];

  out.push(h('div', { class: 'banner info', style: 'margin:0 0 10px' }, 'Fee pembuat bot: 0,5% per swap LIVE (Jupiter). Mode PAPER tanpa fee.'));
  out.push(strategyToggles(data.strategies.map(x => ({ ...x, openCount: null }))));
  out.push(h('div', { class: 'small muted', style: 'margin:0 6px 6px' }, 'Beberapa strategi bisa aktif bersamaan. Setiap posisi, notifikasi, dan riwayat diberi label strateginya.'));

  for (const group of data.groups) {
    const body = h('div', { class: 'list' }, group.fields.map(field => h('div', { class: 'field' },
      h('div', { class: 'label' }, field.label, (field.hint || boundsHint(field)) ? h('div', { class: 'hint', text: [field.hint, boundsHint(field)].filter(Boolean).join(' · ') }) : null),
      fieldControl(field),
      field.type === 'number' ? h('span', { class: 'unit', text: field.unit === 'ms' ? 'mnt' : field.unit === 'SOL' && PRICE ? '$' : field.unit }) : null)));
    body.hidden = !openGroups.has(group.id);
    const arrow = h('span', { text: body.hidden ? '▸' : '▾' });
    const head = h('div', { class: 'section-title', style: 'cursor:pointer;display:flex', onclick: () => {
      body.hidden = !body.hidden;
      if (body.hidden) openGroups.delete(group.id); else openGroups.add(group.id);
      arrow.textContent = body.hidden ? '▸' : '▾';
    } }, h('span', { style: 'flex:1', text: group.title }), arrow);
    out.push(head, body);
  }
  out.push(h('div', { class: 'small muted', style: 'margin:12px 6px' }, 'Setiap perubahan dicatat dan bisa dibatalkan di Screening → Lainnya → Riwayat perubahan.'));
  return h('div', {}, out);
}

// Pemilih mode (Paper / Live). Dipakai di tab Wallet; data = jawaban API yang memuat mode dan walletConfigured.
function modeCard(data) {
  return h('div', {},
    section('Mode trading'),
    // Konfirmasi tidak ditawarkan lagi; hanya tampil bila bot kebetulan masih di mode itu, supaya bisa keluar darinya.
    h('div', { class: 'seg' }, (data.mode === 'confirm' ? ['dry_run', 'confirm', 'live'] : ['dry_run', 'live']).map(mode => h('button', {
      type: 'button', class: data.mode === mode ? 'on' : '',
      onclick: () => changeMode(mode, data),
    }, { dry_run: 'Paper', confirm: 'Konfirmasi', live: 'Live' }[mode]))),
    h('div', { class: 'small muted', style: 'margin:0 6px 10px' },
      data.mode === 'dry_run' ? 'Simulasi: tidak ada transaksi sungguhan.'
        : data.mode === 'confirm' ? 'Setiap entry menunggu konfirmasimu, lalu dieksekusi dengan dana sungguhan.'
          : 'Entry dan exit dieksekusi otomatis dengan dana sungguhan.',
      data.walletConfigured ? '' : ' Wallet belum diisi di server — mode sungguhan belum bisa dipakai.'));
}

async function changeMode(mode, data) {
  if (mode === data.mode) return;
  let confirmText = '';
  if (mode !== 'dry_run') {
    if (!data.walletConfigured) { toast('Wallet belum diisi di server. Jalankan "palic config" di VPS.', true); return; }
    const expected = mode === 'live' ? 'LIVE' : 'CONFIRM';
    confirmText = await askTyped({
      title: mode === 'live' ? 'Aktifkan mode LIVE?' : 'Aktifkan mode konfirmasi?',
      message: mode === 'live'
        ? 'Bot akan membeli dan menjual sendiri dengan dana sungguhan dari wallet bot, tanpa bertanya.'
        : 'Setiap entry akan menunggu konfirmasimu, lalu dieksekusi dengan dana sungguhan.',
      expected,
    });
    if (!confirmText) return;
  }
  const res = await act('/api/mode', { value: mode, confirmText }, { success: `Mode: ${MODE_LABEL[mode]}` });
  if (res?.ok) refreshInPlace();
}

// ── Wallet ──────────────────────────────────────────────────────────────────
// Dompet dry run (virtual) dengan modal yang bisa diubah, dan status wallet live.
function askCapital({ capitalSol, minSol, maxSol }) {
  return new Promise(resolve => {
    let unit = PRICE ? 'usd' : 'sol';
    const toUnit = v => (unit === 'usd' ? v * PRICE : v);
    const fromUnit = v => (unit === 'usd' ? v / PRICE : v);
    const fmt = v => String(unit === 'usd' ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000);
    const input = h('input', { type: 'number', inputmode: 'decimal', step: 'any', min: '0', autocomplete: 'off', value: fmt(toUnit(capitalSol)) });
    const hint = h('p', { class: 'small muted' });
    const refreshHint = () => {
      const v = Number(input.value);
      hint.textContent = PRICE && Number.isFinite(v) && v > 0 ? (unit === 'usd' ? `≈ ${fromUnit(v).toFixed(4)} SOL` : `≈ ${dollars(v * PRICE)}`) : '';
    };
    input.addEventListener('input', refreshHint);
    let overlay = null;
    const close = value => { overlay?.remove(); resolve(value); };
    const seg = PRICE ? h('div', { class: 'seg' }, ['usd', 'sol'].map(u => h('button', {
      type: 'button', class: u === unit ? 'on' : '', dataset: { u },
      onclick: () => {
        const v = Number(input.value);
        const asSol = Number.isFinite(v) && v > 0 ? fromUnit(v) : capitalSol;
        unit = u;
        input.value = fmt(toUnit(asSol));
        for (const b of seg.children) b.classList.toggle('on', b.dataset.u === unit);
        refreshHint();
      },
    }, u === 'usd' ? 'USD' : 'SOL'))) : null;
    const save = h('button', { type: 'button', class: 'btn', onclick: () => {
      const v = Number(input.value);
      const asSol = Number.isFinite(v) ? fromUnit(v) : NaN;
      if (!(asSol >= minSol && asSol <= maxSol)) { toast(`Modal harus antara ${minSol} dan ${maxSol} SOL.`, true); return; }
      close(asSol);
    } }, 'Simpan');
    overlay = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      h('div', { class: 'modal-box' },
        h('h3', { text: 'Edit modal dry run' }),
        h('p', { class: 'small muted', text: 'Mengubah modal dompet virtual. Hasil trade yang sudah ada tidak dihapus, dan tidak ada uang sungguhan yang bergerak.' }),
        seg,
        input,
        hint,
        h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn secondary', onclick: () => close(null) }, 'Batal'), save)));
    document.body.append(overlay);
    refreshHint();
    input.focus();
    input.select();
  });
}

async function walletView() {
  const [data, results] = await Promise.all([api(`/api/dryrun?book=${book}`), bookResults()]);
  if (!data.ok) throw new ApiError(data.error);
  setModePill(data.mode);
  const w = data.wallet;
  const dryActive = data.mode === 'dry_run';
  const maxPos = isNum(data.maxOpenPositions) ? data.maxOpenPositions : 0;
  const growth = w.capitalSol > 0 ? ((w.equitySol - w.capitalSol) / w.capitalSol) * 100 : null;
  const usedShare = w.capitalSol + w.realizedSol > 0 ? clamp01(w.usedSol / (w.capitalSol + w.realizedSol)) * 100 : 0;
  const edit = async () => {
    const capital = await askCapital({ capitalSol: w.capitalSol, minSol: data.capitalMinSol, maxSol: data.capitalMaxSol });
    if (capital === null) return;
    const res = await act('/api/dryrun/capital', { value: capital, book }, { success: 'Modal dry run diperbarui.' });
    if (res?.ok) refreshInPlace();
  };
  return h('div', {},
    modeCard(data),
    !dryActive ? h('div', { class: 'banner info' }, `Mode sekarang ${MODE_LABEL[data.mode] || data.mode}: dompet dry run di bawah tidak dipakai, kecuali kamu kembali ke mode Paper.`) : null,
    h('section', { class: 'pboard' },
      h('div', { class: 'pb-top' },
        h('div', { class: 'pb-title' }, 'Wallet'),
        h('div', { class: 'pb-chips' }, h('span', { class: `pb-chip mode ${dryActive ? 'dry_run' : ''}`, text: dryActive ? 'PAPER AKTIF' : 'TIDAK DIPAKAI' }))),
      h('div', { class: 'pb-hero' },
        h('div', {},
          h('div', { class: 'pb-label', text: 'Saldo (ekuitas)' }),
          h('div', { class: `pb-big ${tone(w.equitySol - w.capitalSol)}` }, sol(w.equitySol, 3))),
        h('div', { class: 'pb-side' },
          growth !== null ? h('div', { class: `pb-delta ${tone(growth)}`, text: `${growth >= 0 ? '▲' : '▼'} ${Math.abs(growth).toFixed(1)}% dari modal` }) : null,
          h('div', { class: 'pb-label', text: 'dompet virtual' }))),
      h('div', { class: 'pb-kpis grid2' },
        h('div', { class: 'kpi' }, h('div', { class: 'pb-label', text: 'Modal' }), h('div', { class: 'kv-num', text: sol(w.capitalSol, 3) })),
        h('div', { class: 'kpi' }, h('div', { class: 'pb-label', text: 'Tersedia' }), h('div', { class: 'kv-num', text: sol(w.availableSol, 3) })),
        h('div', { class: 'kpi' }, h('div', { class: 'pb-label', text: 'Terpakai' }), h('div', { class: 'kv-num', text: sol(w.usedSol, 3) }), h('div', { class: 'meter' }, h('span', { style: `width:${usedShare}%` }))),
        h('div', { class: 'kpi' }, h('div', { class: 'pb-label', text: 'Posisi' }), h('div', { class: 'kv-num', text: `${w.openCount}/${maxPos || '–'}` }))),
      h('div', { class: 'pb-foot' },
        h('span', { text: `${w.closedCount} trade selesai` }),
        h('span', { text: 'tanpa uang sungguhan' }))),
    h('button', { type: 'button', class: 'btn', onclick: edit }, 'Edit modal'),
    h('div', { class: 'grid', style: 'margin-top:11px' },
      h('div', { class: 'stat' }, h('div', { class: 'k', text: 'PnL direalisasi' }), h('div', { class: `v ${tone(w.realizedSol)}`, text: signedSol(w.realizedSol) })),
      h('div', { class: 'stat' }, h('div', { class: 'k', text: 'PnL mengambang' }), h('div', { class: `v ${tone(w.unrealizedSol)}`, text: signedSol(w.unrealizedSol) }))),
    h('p', { class: 'small muted', style: 'margin:2px 4px 6px', text: 'Saat saldo tersedia tidak cukup untuk ukuran posisi, bot berhenti membuka entry simulasi baru sampai modal ditambah atau posisi ditutup.' }),
    section('Wallet live'),
    h('div', { class: 'card' },
      h('div', { class: 'kv' },
        h('span', { class: 'k', text: 'Wallet di server' }), h('span', { class: `v ${data.walletConfigured ? 'good' : 'warn'}`, text: data.walletConfigured ? 'Terhubung' : 'Belum diisi' }),
        h('span', { class: 'k', text: 'Dipakai di mode' }), h('span', { class: 'v', text: 'Live' })),
      h('p', { class: 'small muted', style: 'margin:10px 0 0', text: 'Dana sungguhan hanya dipakai di mode Live. Mode Paper selalu memakai modal virtual di atas.' })),
    h('div', {}));
}

// ── Screening (menu: Aktivitas, Lainnya) ──────────────────────────────
const SCREENING_SUBS = [['activity', 'Aktivitas'], ['more', 'Lainnya']];
let screeningSub = 'activity';

function otherRows() {
  return h('div', {},
    section('Risiko'),
    h('div', { class: 'list' },
      row({ title: 'Risk engine', sub: 'Batas rugi, drawdown, eksposur — dan jeda semua entry', onclick: () => go('more', 'risk') })),
    section('Laporan'),
    h('div', { class: 'list' },
      row({ title: 'Brief 24 jam', sub: 'Keputusan, trade, risiko', onclick: () => go('more', 'brief') }),
      row({ title: 'Laporan bukti (evidence)', sub: 'Statistik dari trade yang sudah ditutup', onclick: () => go('more', 'intel') }),
      row({ title: 'Kirim laporan harian ke chat', sub: 'Kartu ringkasan hari ini', onclick: async () => { await act('/api/reports/daily', {}); } })),
    section('Lainnya'),
    h('div', { class: 'list' },
      row({ title: 'Riwayat perubahan', sub: 'Siapa mengubah apa — dan batalkan', onclick: () => go('more', 'changes') })),
    h('p', { class: 'small muted', style: 'margin:16px 6px', text: 'Palic v2 · P6. Kontrol penuh lewat Mini App.' }));
}

async function screeningBody(sub) {
  try {
    if (sub === 'more') return otherRows();
    return await activityRows();
  } catch (err) {
    if (err.message === 'unauthorized' || err.message === 'forbidden') throw err;
    return h('div', { class: 'banner bad' }, err.message);
  }
}

// Menu Screening: kandidat, aktivitas bot, dan sisa menu (risiko, laporan, lessons, wallet pantauan, riwayat).
async function moreView(param, id) {
  const sub = {
    brief: () => reportView('/api/reports/brief', 'Brief 24 jam'), intel: intelView, risk: riskView,
    changes: changesView,
  }[param];
  if (sub) return sub();
  const body = await screeningBody(screeningSub);
  if (id === state.renderId && screeningSub !== 'more') every(20_000, refreshInPlace);
  return h('div', {},
    h('div', { class: 'subtabs' }, SCREENING_SUBS.map(([key, label]) => h('button', {
      type: 'button', class: screeningSub === key ? 'on' : '',
      onclick: () => { screeningSub = key; refreshInPlace(); },
    }, label))),
    body);
}

async function riskView() {
  const o = await api('/api/overview');
  if (!o.ok) throw new ApiError(o.error);
  return h('div', {}, section('Risk engine'), riskCard(o));
}

async function reportView(path, title) {
  const data = await api(path);
  if (!data.ok) throw new ApiError(data.error);
  return h('div', {}, section(title), h('pre', { class: 'report', text: data.text }));
}

const intelBook = { book: '' };
async function intelView() {
  const data = await api(`/api/reports/intel${intelBook.book ? `?book=${intelBook.book}` : ''}`);
  if (!data.ok) throw new ApiError(data.error);
  return h('div', {},
    h('div', { class: 'seg' }, ['dry_run', 'live', 'all'].map(book => h('button', {
      type: 'button', class: data.book === book ? 'on' : '', onclick: () => { intelBook.book = book; render(); },
    }, { dry_run: 'Paper', live: 'Live', all: 'Semua' }[book]))),
    h('pre', { class: 'report', text: data.text }));
}

async function lessonsView() {
  const data = await api('/api/lessons');
  if (!data.ok) throw new ApiError(data.error);
  const review = async (lesson, action) => {
    const res = await act(`/api/lessons/${lesson.id}`, { action }, { success: action === 'approve' ? 'Disetujui — masuk ke prompt.' : 'Ditolak.' });
    if (res?.ok) refreshInPlace();
  };
  const windowInput = h('input', { type: 'text', value: '12h', style: 'width:80px' });
  return h('div', {},
    h('div', { class: 'banner info small' }, 'Hanya lesson yang disetujui yang dibaca model keputusan. Lesson tidak pernah mengubah parameter.'),
    data.lessons.length ? data.lessons.map(lesson => h('div', { class: 'card' },
      h('div', {}, h('span', { class: `badge ${lesson.status === 'validated' ? 'buy' : 'watch'}`, text: lesson.status === 'validated' ? 'DIPAKAI' : 'USULAN' }), ' ', h('span', { class: 'small muted', text: `#${lesson.id} · ${dateTime(lesson.atMs)}${lesson.legacy ? ' · lama' : ''}` })),
      h('p', { text: lesson.text }),
      lesson.status !== 'validated'
        ? h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn small secondary', onclick: () => review(lesson, 'reject') }, 'Tolak'), h('button', { type: 'button', class: 'btn small', onclick: () => review(lesson, 'approve') }, 'Setujui'))
        : h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn small secondary', onclick: () => review(lesson, 'reject') }, 'Cabut')))) : empty('Belum ada lesson.'),
    section('Buat lesson baru'),
    h('div', { class: 'card' },
      h('div', { class: 'field', style: 'padding:0;border:0' }, h('div', { class: 'label' }, 'Jendela waktu', h('div', { class: 'hint', text: 'contoh 12h, 3d' })), windowInput),
      h('div', { class: 'btns' }, h('button', { type: 'button', class: 'btn secondary', onclick: async event => {
        event.target.disabled = true; event.target.textContent = 'Menganalisis…';
        const res = await act('/api/learn', { window: windowInput.value.trim() }, { success: false });
        event.target.disabled = false; event.target.textContent = 'Jalankan';
        if (res?.ok) { toast(`${res.proposed} lesson diusulkan.`); refreshInPlace(); }
      } }, 'Jalankan'))));
}

async function walletsView() {
  const data = await api('/api/wallets');
  if (!data.ok) throw new ApiError(data.error);
  const label = h('input', { type: 'text', placeholder: 'Label (mis. whale1)', maxlength: '32' });
  const address = h('input', { type: 'text', placeholder: 'Alamat Solana', autocomplete: 'off', spellcheck: 'false' });
  const pnlBox = h('div');
  return h('div', {},
    data.wallets.length ? h('div', { class: 'list' }, data.wallets.map(w => h('div', { class: 'row' },
      h('div', { class: 'main' }, h('div', { class: 'title', text: w.label }), h('div', { class: 'sub mono', text: w.address })),
      h('button', { type: 'button', class: 'btn small secondary', onclick: async () => {
        if (!(await ask(`Hapus wallet ${w.label}?`))) return;
        const res = await act('/api/wallets/remove', { label: w.label }, { success: 'Wallet dihapus.' });
        if (res?.ok) refreshInPlace();
      } }, 'Hapus')))) : empty('Belum ada wallet pantauan.'),
    section('Tambah wallet'),
    h('div', { class: 'card form' }, label, address, h('button', { type: 'button', class: 'btn', onclick: async () => {
      const res = await act('/api/wallets', { label: label.value.trim(), address: address.value.trim() }, { success: 'Wallet disimpan.' });
      if (res?.ok) refreshInPlace();
    } }, 'Simpan')),
    data.wallets.length ? h('button', { type: 'button', class: 'btn secondary', onclick: async event => {
      event.target.disabled = true; event.target.textContent = 'Mengambil PnL…';
      try {
        const res = await api('/api/wallets/pnl');
        pnlBox.replaceChildren(section('PnL wallet (GMGN)'), h('div', { class: 'list' }, res.wallets.map(w => row({
          title: w.label,
          sub: w.pnl ? `WR ${plainPct(w.pnl.winRate)} · ${w.pnl.totalTrades ?? '–'} trade` : 'tidak ada data',
          end: w.pnl ? (isNum(w.pnl.totalPnlPercent) ? pct(w.pnl.totalPnlPercent) : usd(w.pnl.totalPnlUsd)) : '–',
          endClass: w.pnl ? tone(w.pnl.totalPnlPercent ?? w.pnl.totalPnlUsd) : 'muted',
        }))));
      } catch (err) { toast(err.message, true); }
      event.target.disabled = false; event.target.textContent = 'Lihat PnL wallet';
    } }, 'Lihat PnL wallet') : null,
    pnlBox);
}

async function changesView() {
  const data = await api('/api/changes');
  if (!data.ok) throw new ApiError(data.error);
  if (!data.changes.length) return empty('Belum ada perubahan setelan.');
  return h('div', { class: 'list' }, data.changes.map(c => h('div', { class: 'row' },
    h('div', { class: 'main' },
      h('div', { class: 'title', text: `${c.scope === 'strategy' ? `${c.target}.` : ''}${c.key}` }),
      h('div', { class: 'sub', text: `${c.oldValue ?? '∅'} → ${c.newValue ?? '∅'}` }),
      h('div', { class: 'sub', text: `#${c.id} · ${dateTime(c.atMs)} · ${c.actor}${c.rolledBackBy ? ` · dibatalkan #${c.rolledBackBy}` : ''}` })),
    !c.rolledBackBy && c.key !== 'trading_mode' ? h('button', { type: 'button', class: 'btn small secondary', onclick: async () => {
      if (!(await ask(`Kembalikan ${c.key} ke ${c.oldValue ?? '(kosong)'}?`))) return;
      const res = await act(`/api/changes/${c.id}/rollback`, {}, { success: 'Dibatalkan.' });
      if (res?.ok) refreshInPlace();
    } }, 'Batalkan') : null)));
}

// ── start ───────────────────────────────────────────────────────────────────
function start() {
  if (tg) {
    tg.ready();
    tg.expand();
    // Tema gelap tetap: samakan header & latar Telegram dengan warna aplikasi.
    try { tg.setHeaderColor?.('#0a0d14'); tg.setBackgroundColor?.('#0a0d14'); tg.setBottomBarColor?.('#0a0d14'); } catch {}
    try { tg.disableVerticalSwipes?.(); } catch { /* older clients */ }
    tg.BackButton?.onClick(() => history.back());
  }
  for (const button of document.querySelectorAll('.tabs button')) button.addEventListener('click', () => go(button.dataset.tab));
  $('#sync').addEventListener('click', manualRefresh);
  setupPullToRefresh();
  setInterval(paintSync, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.tab !== 'settings') refreshInPlace(); });

  if (!initData) {
    showFatal('Halaman ini adalah Mini App Telegram. Buka lewat tombol menu Palic di chat bot.');
    return;
  }
  // Deep link from a notification button: ?view=positions/12
  const requested = new URLSearchParams(location.search).get('view') || '';
  const [tab, param] = requested.split('/');
  const tabs = ['home', 'positions', 'settings', 'wallet', 'more', 'intents'];
  const initialTab = tabs.includes(tab) ? (tab === 'intents' ? 'home' : tab) : 'home';
  const initialParam = param && /^[a-z0-9]{1,20}$/i.test(param) ? param : null;
  history.replaceState({ tab: initialTab, param: null }, '');
  if (initialParam) history.pushState({ tab: initialTab, param: initialParam }, '');
  state.tab = initialTab;
  state.param = initialParam;
  render();
}

start();
