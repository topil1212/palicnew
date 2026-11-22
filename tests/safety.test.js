import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { setSetting } from '../src/settings.js';
import { createEngine } from '../src/engine.js';
import { sellabilityCheck } from '../src/safety.js';

const CLASSIC = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOL = 'So11111111111111111111111111111111111111112';
const tok = (extra = {}) => ({ id: 'M1', symbol: 'TT', liquidity: 50000, tokenProgram: CLASSIC, ...extra });

// quote palsu: beli 0.05 SOL -> 1000 token; jual 1000 token -> ratio * 0.05 SOL
const quotes = ({ ratio = 0.97, sellRoute = true, buyRoute = true } = {}) => {
  const calls = [];
  const quote = async (inMint, outMint, amount) => {
    calls.push([inMint === SOL ? 'beli' : 'jual', amount]);
    if (inMint === SOL) { if (!buyRoute) throw new Error('HTTP 400 · No routes found'); return { outAmount: '1000' }; }
    if (!sellRoute) throw new Error('HTTP 400 · No routes found');
    return { outAmount: String(Math.round(0.05e9 * ratio)) };
  };
  return { quote, calls };
};

test('sellabilityCheck: token sehat lolos dan jumlah quote benar', async () => {
  const q = quotes();
  const r = await sellabilityCheck({ jup: q, mint: 'M1', token: tok(), sizeSol: 0.05 });
  assert.equal(r.ok, true); assert.equal(r.roundTripPct, 97);
  assert.deepEqual(q.calls, [['beli', 50_000_000], ['jual', '1000']]);
});

test('sellabilityCheck: tanpa rute jual = honeypot; tanpa rute beli; rugi round-trip besar; likuiditas 0; Token-2022', async () => {
  const sizeSol = 0.05;
  assert.match((await sellabilityCheck({ jup: quotes({ sellRoute: false }), mint: 'M1', token: tok(), sizeSol })).reason, /TIDAK ADA RUTE JUAL/);
  assert.match((await sellabilityCheck({ jup: quotes({ buyRoute: false }), mint: 'M1', token: tok(), sizeSol })).reason, /tidak ada rute beli/);
  assert.match((await sellabilityCheck({ jup: quotes({ ratio: 0.6 }), mint: 'M1', token: tok(), sizeSol })).reason, /rugi 40%/);
  const noCalls = quotes();
  assert.match((await sellabilityCheck({ jup: noCalls, mint: 'M1', token: tok({ liquidity: 0 }), sizeSol })).reason, /likuiditas hampir 0/);
  assert.match((await sellabilityCheck({ jup: noCalls, mint: 'M1', token: tok({ liquidity: 0.002 }), sizeSol })).reason, /likuiditas hampir 0/);   // residu 0,002 USD bukan likuiditas
  assert.match((await sellabilityCheck({ jup: noCalls, mint: 'M1', token: tok({ tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }), sizeSol })).reason, /Token-2022/);
  assert.equal(noCalls.calls.length, 0);                                    // ditolak sebelum memanggil quote
  assert.equal((await sellabilityCheck({ jup: quotes(), mint: 'M1', token: tok({ tokenProgram: 'TokenzQd...' }), sizeSol, chain: { inspectMint: async () => ({ risks: [] }) } })).ok, true);   // Token-2022 aman (diperiksa on-chain) lolos
  assert.match((await sellabilityCheck({ jup: quotes(), mint: 'M1', token: tok({ tokenProgram: 'TokenzQd...' }), sizeSol })).reason, /tidak bisa diperiksa/);   // tanpa RPC: gagal-tertutup
  assert.equal((await sellabilityCheck({ jup: { quote: async () => { throw new Error('HTTP 429'); } }, mint: 'M1', token: tok(), sizeSol })).ok, false);   // gagal-tertutup
});

const plan = { ageHours: 0.3, barVolumeUsd: 9000, momentumPct: 12, fresh: true };
const make = (q, extra = {}) => {
  const db = openDb();
  setSetting(db, 'paper_slippage_pct', 0);
  const jup = { prices: async () => ({ M1: 1 }), candles: async () => [], trending: async () => [], recent: async () => [], toptraded: async () => [], quote: q.quote, ...extra };
  const msgs = [];
  const rugcheck = { summary: async () => ({ lpLockedPct: 100, score: 1, risks: [] }) };   // LP terkunci penuh: gerbang kunci lolos
  const engine = createEngine({ db, jup, rugcheck, notify: async (m) => msgs.push(m), pauseBetweenFetchesMs: 0 });
  return { db, engine, msgs };
};
const openP6 = (e, token = tok()) => e.engine.openAny({ mint: 'M1', symbol: 'TT', price: 1, plan, token, strategy: 'p6' });

test('openAny: token yang bisa dijual dibuka; honeypot ditolak tanpa posisi dan alasannya tercatat', async () => {
  const ok = make(quotes());
  assert.equal((await openP6(ok)).opened, true);
  const bad = make(quotes({ sellRoute: false }));
  const r = await openP6(bad);
  assert.equal(r.opened, false); assert.equal(r.unsafe, true); assert.match(r.reason, /ditolak uji bisa-dijual/);
  assert.equal(bad.db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 0);
  const ev = JSON.parse(bad.db.prepare("SELECT detail FROM events WHERE kind = 'skip'").get().detail);
  assert.equal(ev.stage, 'keamanan'); assert.match(ev.reasons[0], /RUTE JUAL/);
});

test('uji bisa-dijual dicache 2 menit, bisa dimatikan, dan berlaku untuk semua entry', async () => {
  const q = quotes({ sellRoute: false });
  const e = make(q);
  await openP6(e); await openP6(e);
  assert.equal(q.calls.length, 2);                          // satu kali uji (beli+jual), bukan dua
  setSetting(e.db, 'honeypot_check', 'false');
  assert.equal((await openP6(make(quotes({ sellRoute: false })))).opened, false);   // mesin baru, cek masih nyala di DB barunya
  const off = make(quotes({ sellRoute: false })); setSetting(off.db, 'honeypot_check', 'false');
  assert.equal((await openP6(off)).opened, true);
  const basePlan = { tpPrice: 70, slPrice: 47, tpPct: 37, slPct: -8, rr: 4, zona: 50, zoneTouches: 2, target: 70, dropPct: 30 };
  const e1 = make(quotes({ sellRoute: false }));
  const r = await e1.engine.openAny({ mint: 'M1', symbol: 'TT', price: 51, plan: basePlan, token: tok(), strategy: 'p6' });
  assert.equal(r.opened, false); assert.equal(r.unsafe, true);
});

test('scanP6 tidak membuka token honeypot meski sinyal P6-nya sempurna', async () => {
  const bars = Array.from({ length: 6 }, (_, i) => ({ time: (Date.UTC(2026, 10, 18, 5, 0, 0) / 1000) - (6 - i) * 300, open: 1, high: i === 5 ? 1.12 : 1, low: 1, close: i === 5 ? 1.1 : 1, volume: i === 5 ? 9000 : 100 }));
  const T = Date.UTC(2026, 10, 18, 5, 0, 30);
  const fresh = { ...tok(), stats5m: { buyVolume: 6000, sellVolume: 4000 }, usdPrice: 1.1, firstPool: { createdAt: new Date(T - 0.4 * 3_600_000).toISOString() }, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true }, decimals: 6, mcap: 2e5, holderCount: 300 };
  const e = make(quotes({ sellRoute: false }), { recent: async () => [fresh], candles: async () => bars, token: async () => fresh });
  const eng = createEngine({ db: e.db, jup: { prices: async () => ({ M1: 1.1 }), candles: async () => bars, trending: async () => [], recent: async () => [fresh], toptraded: async () => [], quote: quotes({ sellRoute: false }).quote, token: async () => fresh }, now: () => T, notify: async () => {}, pauseBetweenFetchesMs: 0 });
  const s = await eng.scanP6();
  assert.equal(s.entries, 0);
  assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM positions').get().n, 0);
});
