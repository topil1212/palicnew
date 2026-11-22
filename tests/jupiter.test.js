import test from 'node:test';
import assert from 'node:assert/strict';
import { createJupiter } from '../src/jupiter.js';

const res = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const fast = { gapMs: { lite: 0, data: 0 }, backoffMs: 1 };

test('429 dicoba ulang lalu berhasil', async () => {
  let n = 0;
  const jup = createJupiter({ ...fast, fetchImpl: async () => (++n < 3 ? res(429) : res(200, [{ id: 'A' }])) });
  assert.deepEqual(await jup.recent(5), [{ id: 'A' }]);
  assert.equal(n, 3);
});

test('429 terus-menerus: gagal dengan pesan jelas setelah retry habis; 404 tidak diulang', async () => {
  let n = 0;
  const jup = createJupiter({ ...fast, retries: 2, fetchImpl: async () => { n += 1; return res(429); } });
  await assert.rejects(() => jup.trending('1h'), /HTTP 429/);
  assert.equal(n, 3);
  let m = 0;
  const j2 = createJupiter({ ...fast, fetchImpl: async () => { m += 1; return res(404); } });
  await assert.rejects(() => j2.trending('1h'), /HTTP 404/);
  assert.equal(m, 1);
});

test('antrean memberi jarak antar permintaan ke host yang sama dan berjalan satu per satu', async () => {
  const stamps = [];
  const jup = createJupiter({ gapMs: { lite: 40, data: 0 }, backoffMs: 1, fetchImpl: async () => { stamps.push(Date.now()); return res(200, [{ id: 'x' }]); } });
  await Promise.all([jup.recent(), jup.toptraded('5m'), jup.trending('1h')]);
  assert.equal(stamps.length, 3);
  assert.ok(stamps[1] - stamps[0] >= 35 && stamps[2] - stamps[1] >= 35);
});

test('candles menyaring bar rusak dan mengurutkan menaik', async () => {
  const jup = createJupiter({ ...fast, fetchImpl: async () => res(200, { candles: [{ time: 2, open: 1, high: 2, low: 1, close: 2, volume: 5 }, { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }, { time: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 }] }) });
  const c = await jup.candles('M');
  assert.deepEqual(c.map((x) => x.time), [1, 2]);
});

test('daftar kosong (200 []) dicoba ulang; tetap kosong setelah retry habis dikembalikan []', async () => {
  let n = 0;
  const jup = createJupiter({ ...fast, fetchImpl: async () => (++n < 3 ? res(200, []) : res(200, [{ id: 'A' }])) });
  assert.deepEqual(await jup.toptraded('5m'), [{ id: 'A' }]); assert.equal(n, 3);
  let m = 0;
  const j2 = createJupiter({ ...fast, retries: 2, fetchImpl: async () => { m += 1; return res(200, []); } });
  assert.deepEqual(await j2.recent(), []); assert.equal(m, 3);
});
