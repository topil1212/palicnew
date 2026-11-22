import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createEngine } from '../src/engine.js';
import { createCommands } from '../src/commands.js';
import { createTelegram } from '../src/telegram.js';
import { getSetting } from '../src/settings.js';

const setup = () => {
  const db = openDb();
  const jup = { prices: async () => ({}), candles: async () => [], trending: async () => [] };
  const engine = createEngine({ db, jup, pauseBetweenFetchesMs: 0 });
  return { db, handle: createCommands({ db, engine, jup }) };
};

test('perintah dasar menjawab dan tidak melempar', async () => {
  const { handle } = setup();
  for (const c of ['/help', '/status', '/posisi', '/history', '/settings', '/scan']) assert.equal(typeof (await handle(c)), 'string');
});

test('/set memvalidasi, mengaudit, dan /pause /resume bekerja', async () => {
  const { db, handle } = setup();
  assert.match(await handle('/set p6_hold_minutes 30'), /60 → 30/);
  assert.equal(getSetting(db, 'p6_hold_minutes'), 30);
  assert.match(await handle('/set p6_hold_minutes 99999'), /Ditolak/);
  assert.match(await handle('/set nama_ngawur 1'), /Ditolak/);
  await handle('/pause'); assert.equal(getSetting(db, 'paused'), true);
  await handle('/resume'); assert.equal(getSetting(db, 'paused'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM changes').get().n, 3);
  assert.match(await handle('/hapus_semua'), /tidak dikenal/);
  assert.match(await handle('/constructor'), /tidak dikenal/);
});

test('telegram: chat tidak terdaftar diabaikan, chat terdaftar dilayani, /start tanpa chat id membalas ID', async () => {
  const sent = [];
  let polls = 0;
  const tgFetch = (updates) => async (url, init) => {
    const method = url.split('/').pop();
    if (method === 'sendMessage') { sent.push(JSON.parse(init.body)); return { json: async () => ({ ok: true, result: {} }) }; }
    polls += 1;
    if (polls > 1) await new Promise((r) => setTimeout(r, 10));   // long polling asli menunggu; tanpa jeda loop menguasai event loop
    return { json: async () => ({ ok: true, result: polls === 1 ? updates : [] }) };
  };
  const run = async (chatId, updates) => {
    sent.length = 0; polls = 0;
    const tg = createTelegram({ token: 't', chatId, fetchImpl: tgFetch(updates), log: () => {} });
    const p = tg.poll(async (text) => `ok:${text}`);
    await new Promise((r) => setTimeout(r, 30)); tg.stop(); await Promise.race([p, new Promise((r) => setTimeout(r, 100))]);
  };
  await run('42', [{ update_id: 1, message: { chat: { id: 99 }, text: '/status' } }]);
  assert.equal(sent.length, 0);
  await run('42', [{ update_id: 2, message: { chat: { id: 42 }, text: '/status' } }]);
  assert.equal(sent[0].text, 'ok:/status');
  await run('', [{ update_id: 3, message: { chat: { id: 77 }, text: '/start' } }]);
  assert.match(sent[0].text, /Chat ID kamu: 77/);
  await run('', [{ update_id: 4, message: { chat: { id: 77 }, text: '/status' } }]);
  assert.equal(sent.length, 0);
});
