// Telegram Mini App authentication. Pure — no DB, no network.
//
// Every API request carries the initData string Telegram hands to the Mini App.
// Telegram signs it with a key derived from the bot token, so only a session that
// Telegram itself opened for a given user can produce a valid one. The server:
//   1. recomputes the HMAC (constant-time compare),
//   2. rejects data older than maxAgeS,
//   3. requires the Telegram user id to be an operator.
// There is no cookie and no session store: nothing to steal with a cross-site request.

import crypto from 'node:crypto';

export const DEFAULT_MAX_AGE_S = 12 * 3600;   // an open Mini App is re-opened at least twice a day

function idList(raw) {
  return String(raw ?? '').split(/[,\s]+/).map(part => part.trim()).filter(part => /^\d{3,20}$/.test(part));
}

// Operators = TELEGRAM_ADMIN_IDS, plus TELEGRAM_CHAT_ID when it is a private chat
// (a positive id is the user's own id). A group id never authorizes anyone.
export function operatorIds({ adminIds = '', chatId = '' } = {}) {
  const ids = new Set(idList(adminIds));
  const chat = String(chatId ?? '').trim();
  if (/^\d{3,20}$/.test(chat)) ids.add(chat);
  return ids;
}

function dataCheckString(params) {
  return [...params.entries()].map(([key, value]) => `${key}=${value}`).sort().join('\n');
}

function secretKey(botToken) {
  return crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
}

// Test/helper: builds initData exactly as Telegram does.
export function signInitData(fields, botToken) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  const hash = crypto.createHmac('sha256', secretKey(botToken)).update(dataCheckString(params)).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

/**
 * @returns {{ok: true, user: {id, username, firstName}, authDate: number} | {ok: false, reason: string}}
 */
export function verifyInitData(initData, { botToken, operators, nowMs = Date.now(), maxAgeS = DEFAULT_MAX_AGE_S } = {}) {
  if (!botToken) return { ok: false, reason: 'server_not_configured' };
  if (typeof initData !== 'string' || initData.length < 20 || initData.length > 8192) return { ok: false, reason: 'missing' };
  let params;
  try { params = new URLSearchParams(initData); } catch { return { ok: false, reason: 'malformed' }; }
  const hash = params.get('hash') || '';
  if (!/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: 'malformed' };
  params.delete('hash');
  const expected = crypto.createHmac('sha256', secretKey(botToken)).update(dataCheckString(params)).digest();
  const given = Buffer.from(hash.toLowerCase(), 'hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' };

  const authDate = Number(params.get('auth_date'));
  const ageS = nowMs / 1000 - authDate;
  if (!Number.isFinite(authDate) || authDate <= 0 || ageS < -120 || ageS > maxAgeS) return { ok: false, reason: 'expired' };

  let user;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { user = null; }
  const id = user && typeof user === 'object' ? String(user.id ?? '') : '';
  if (!/^\d{3,20}$/.test(id)) return { ok: false, reason: 'no_user' };
  const allowed = operators instanceof Set ? operators : new Set();
  if (allowed.size === 0) return { ok: false, reason: 'no_operators_configured' };
  if (!allowed.has(id)) return { ok: false, reason: 'not_an_operator' };
  return { ok: true, authDate, user: { id, username: String(user.username || '').slice(0, 64), firstName: String(user.first_name || '').slice(0, 64) } };
}

// Sliding-window limiter, in memory. Keyed by operator id (or remote address
// before authentication).
export function makeRateLimiter({ limit = 120, windowMs = 60_000, clock = Date.now } = {}) {
  const hits = new Map();
  return key => {
    const at = clock();
    const list = (hits.get(key) || []).filter(t => at - t < windowMs);
    if (list.length >= limit) { hits.set(key, list); return false; }
    list.push(at);
    hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}
