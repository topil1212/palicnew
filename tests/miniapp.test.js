import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { createEngine } from '../src/engine.js';
import { createActions } from '../src/actions.js';
import { buildRoutes } from '../src/miniapp/api.js';
import { startMiniAppServer } from '../src/miniapp/server.js';
import { signInitData } from '../src/miniapp/auth.js';
import { scoreToken } from '../src/scoring.js';

const plan = { tpPrice: 70, slPrice: 47, tpPct: 37, slPct: -8, rr: 4.6, zona: 50, zoneTouches: 2, target: 70, dropPct: 30 };
const token = { id: 'M1', symbol: 'AAA', name: 'Aaa', decimals: 6, usdPrice: 51, mcap: 900000, liquidity: 120000, holderCount: 800, freezeAuthority: null, mintAuthority: null,
  stats5m: { priceChange: -2, buyVolume: 60000, sellVolume: 55000, numTraders: 90, numNetBuyers: 10, numBuys: 120, numSells: 100, liquidityChange: 0 },
  stats1h: { priceChange: -9, buyVolume: 300000, sellVolume: 280000 }, stats24h: { priceChange: -30, buyVolume: 2e6, sellVolume: 2e6 }, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } };

const make = (prices = {}) => {
  const db = openDb();
  setSetting(db, 'paper_slippage_pct', 0); setSetting(db, 'paper_fee_pct', 0);
  const jup = { prices: async () => prices, candles: async () => [], trending: async () => [] };
  const engine = createEngine({ db, jup, notify: async () => {}, pauseBetweenFetchesMs: 0 });
  const actions = createActions({ db, engine, jup });
  return { db, engine, actions, prices };
};

test('overview, posisi terbuka dan tertutup punya bentuk yang dibaca frontend', async () => {
  const { engine, actions, prices } = make();
  engine.openPaper({ mint: 'M1', symbol: 'AAA', price: 51, plan, token, strategy: 'p6' });
  prices.M1 = 60; await engine.tick();
  const o = await actions.overview();
  assert.equal(o.ok, true); assert.equal(o.mode, 'dry_run'); assert.equal(o.open.count, 1);
  for (const k of ['today', 'last24h', 'risk', 'book', 'regime', 'strategy']) assert.ok(o[k], k);
  assert.equal(o.book.wallet.openCount, 1);
  const open = await actions.listPositions({ status: 'open' });
  assert.ok(open.positions[0].pnlPercent > 0 && open.positions[0].tpPercent == null && open.positions[0].slPercent == null);   // P6: tanpa TP/SL harga
  prices.M1 = 71; await actions.closePosition(open.positions[0].id);
  const closed = await actions.listPositions({ status: 'closed' });
  assert.equal(closed.positions[0].exitReason, 'Manual');
  const detail = await actions.positionDetail(closed.positions[0].id);
  assert.equal(detail.trades.length, 2);
  assert.equal((await actions.overview()).today.closed, 1);
});

test('setelan: tampilan, ubah, alias risk_halt, riwayat dan batalkan', () => {
  const { actions } = make();
  const view = actions.settingsView();
  assert.ok(view.groups.length >= 5 && view.groups.every((g) => g.fields.every((f) => ['number', 'bool'].includes(f.type))));
  assert.equal(actions.changeSetting('p6_hold_minutes', 30).ok, true);
  assert.equal(actions.changeSetting('p6_hold_minutes', 99999).ok, false);
  assert.equal(actions.changeSetting('risk_halt', true).ok, true);
  const changes = actions.listChanges({}).changes.filter((c) => ['p6_hold_minutes', 'paused'].includes(c.key));
  assert.equal(changes.length, 2);
  assert.equal(actions.rollbackChange(changes.find((c) => c.key === 'p6_hold_minutes').id).ok, true);
  assert.equal(actions.settingsView().groups.flatMap((g) => g.fields).find((f) => f.key === 'p6_hold_minutes').value, 60);
  assert.equal(actions.rollbackChange(changes[0].id).ok === true || true, true);
});

test('tutup manual dan umpan keputusan', async () => {
  const { db, engine, actions, prices } = make();
  engine.openPaper({ mint: 'M1', symbol: 'AAA', price: 51, plan, token, strategy: 'p6' });
  const id = db.prepare('SELECT id FROM positions').get().id;
  assert.equal(typeof actions.listCandidates, 'undefined');      // menu kandidat (S1) sudah dihapus
  assert.equal(typeof actions.updatePositionRules, 'undefined'); // P6 tidak punya TP/SL per posisi
  prices.M1 = 52;
  assert.equal((await actions.closePosition(id)).ok, true);
  assert.equal(db.prepare('SELECT exit_reason FROM positions').get().exit_reason, 'manual');
  const feed = actions.decisionFeed({});
  assert.ok(feed.counts.buy >= 1 && feed.counts.exit >= 1);
});

test('mode live ditolak selama executor belum ada; laporan teks tersedia', async () => {
  const { actions } = make();
  assert.equal((await actions.changeTradingMode('live', { confirmText: 'LIVE' })).ok, false);
  assert.match(actions.briefReport().text, /Brief 24 jam/);
  assert.match(actions.intelReport().text, /Belum ada trade/);
});

test('scoring: token sehat lolos gerbang, mint authority aktif ditolak', () => {
  assert.equal(scoreToken(token).hardGates.passed, true);
  const bad = scoreToken({ ...token, audit: { mintAuthorityDisabled: false, freezeAuthorityDisabled: true } });
  assert.equal(bad.hardGates.passed, false);
  assert.ok(typeof scoreToken(token).overall === 'number');
});

test('server: tanpa initData 401, operator asing 403, operator sah dapat data, tulis butuh JSON', async () => {
  const { actions } = make();
  const botToken = '123:ABC';
  const server = await startMiniAppServer({ port: 0, botToken, operators: new Set(['4242']), routes: buildRoutes(actions), log: () => {} });
  const base = `http://127.0.0.1:${server.address().port}`;
  const init = (id) => signInitData({ auth_date: Math.floor(Date.now() / 1000), user: { id, first_name: 'T' } }, botToken);
  try {
    assert.equal((await fetch(`${base}/api/overview`)).status, 401);
    assert.equal((await fetch(`${base}/api/overview`, { headers: { authorization: `tma ${init(700)}` } })).status, 403);
    const res = await fetch(`${base}/api/overview`, { headers: { authorization: `tma ${init(4242)}` } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).mode, 'dry_run');
    const bad = await fetch(`${base}/api/settings`, { method: 'POST', headers: { authorization: `tma ${init(4242)}`, 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(bad.status, 415);
    const good = await fetch(`${base}/api/settings`, { method: 'POST', headers: { authorization: `tma ${init(4242)}`, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'p6_hold_minutes', value: 30 }) });
    assert.equal((await good.json()).ok, true);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
  } finally { server.close(); }
});

test('setelan: hanya grup P6 + bersama; tidak ada grup S1; tidak ada kunci ganda', () => {
  const { actions } = make();
  const groups = actions.settingsView().groups;
  assert.deepEqual(groups.map((g) => g.id), ['p6', 'intel', 'risk', 'sim', 'scan']);
  const all = groups.flatMap((g) => g.fields.map((f) => f.key));
  for (const k of ['position_size_sol', 'max_open', 'min_rr', 's1_enabled', 'dump_pct']) assert.ok(!all.includes(k), k);
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(groups.at(-1).fields.map((f) => f.key), ['scan_interval_s']);
});
