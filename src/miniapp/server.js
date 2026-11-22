// HTTP server behind the Telegram Mini App.
//
// It listens on loopback only. A reverse proxy (Caddy) or a Cloudflare tunnel —
// both set up by install.sh — terminates HTTPS in front of it. Nothing here trusts
// the network position of a caller: every /api request must carry Telegram-signed
// initData for an operator (see auth.js).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyInitData, makeRateLimiter, DEFAULT_MAX_AGE_S } from './auth.js';
import { matchRoute } from './api.js';
import { currentPublicUrl, originAcceptable } from './publicUrl.js';

const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const MAX_BODY_BYTES = 16 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.hdr': 'application/octet-stream', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    // Telegram's web clients show a Mini App in a frame; nothing else may.
    'frame-ancestors https://web.telegram.org https://*.telegram.org',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      // Keep draining a moderately oversized body so the client receives the 413;
      // cut the connection only when it keeps going.
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        if (size > 64 * MAX_BODY_BYTES) req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('body too large'), { status: 413 }));
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function clientKey(req) {
  // Only the local proxy can reach this socket, so its forwarding headers are the
  // best available hint of who is calling. Used for rate limiting only.
  const forwarded = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return String(forwarded || req.socket.remoteAddress || 'unknown').slice(0, 64);
}

function initDataOf(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('tma ') ? header.slice(4) : '';
}

function serveStatic(req, res, pathname) {
  let relative;
  try { relative = decodeURIComponent(pathname); } catch { return send(res, 400, { ok: false, error: 'bad path' }); }
  if (relative === '/' || relative === '') relative = '/index.html';
  if (relative.includes('\0') || relative.split('/').some(part => part.startsWith('.'))) return send(res, 404, { ok: false, error: 'not found' });
  const file = path.normalize(path.join(WEB_ROOT, relative));
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) return send(res, 404, { ok: false, error: 'not found' });
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) return send(res, 404, { ok: false, error: 'not found' });
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, { ok: false, error: 'not found' });
    // Code is small and must never be stale after an update; textures are large and never change.
    const heavy = relative.startsWith('/assets/') || relative.startsWith('/vendor/');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': heavy ? 'public, max-age=604800' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

/**
 * @param {object} options
 *   botToken, operators (Set of Telegram user ids), host, port, maxAgeS,
 *   routes (override for tests), getPublicUrl, log
 */
export function createMiniAppServer({
  botToken,
  operators,
  maxAgeS = DEFAULT_MAX_AGE_S,
  routes = [],
  getPublicUrl = currentPublicUrl,
  log = console.log,
  clock = Date.now,
} = {}) {
  const readLimit = makeRateLimiter({ limit: 240, windowMs: 60_000, clock });
  const writeLimit = makeRateLimiter({ limit: 30, windowMs: 60_000, clock });
  const failLimit = makeRateLimiter({ limit: 20, windowMs: 60_000, clock });

  async function handleApi(req, res, url) {
    const matched = matchRoute(routes, req.method, url.pathname);
    if (!matched) return send(res, 404, { ok: false, error: 'not found' });
    if (matched.methodNotAllowed) return send(res, 405, { ok: false, error: 'method not allowed' });
    const { route, params } = matched;

    if (!originAcceptable(req.headers.origin, getPublicUrl(), req.headers['x-forwarded-host'] || req.headers.host)) return send(res, 403, { ok: false, error: 'origin not allowed' });
    // A write must be a deliberate same-origin fetch: JSON only (a cross-site form
    // cannot send it), and — when the browser says where it comes from — from here.
    // The Authorization header already forces a CORS preflight that this server
    // never approves; these checks are a second layer.
    if (route.write) {
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(res, 415, { ok: false, error: 'JSON required' });
      const site = String(req.headers['sec-fetch-site'] || '');
      if (!req.headers.origin && site && site !== 'same-origin') return send(res, 403, { ok: false, error: 'cross-site request' });
    }

    const key = clientKey(req);
    const auth = verifyInitData(initDataOf(req), { botToken, operators, nowMs: clock(), maxAgeS });
    if (!auth.ok) {
      if (!failLimit(key)) return send(res, 429, { ok: false, error: 'too many attempts' });
      if (auth.reason !== 'missing') log(`[miniapp] denied ${req.method} ${url.pathname}: ${auth.reason}`);
      const status = auth.reason === 'not_an_operator' ? 403 : 401;
      return send(res, status, { ok: false, error: auth.reason === 'expired' ? 'session_expired' : 'unauthorized', reason: auth.reason });
    }
    if (!(route.write ? writeLimit : readLimit)(`${auth.user.id}`)) return send(res, 429, { ok: false, error: 'Terlalu banyak permintaan. Coba lagi sebentar.' });

    let body = {};
    if (route.write) {
      try { body = await readBody(req); } catch (err) { return send(res, err.status || 400, { ok: false, error: err.message }); }
    }
    const actor = `miniapp:${auth.user.id}`;
    try {
      const result = await route.handler({ params, query: url.searchParams, body, actor, user: auth.user });
      if (route.write) log(`[miniapp] ${actor} ${req.method} ${url.pathname} → ${result?.ok ? 'ok' : `refused (${String(result?.error || '').slice(0, 80)})`}`);
      // Refusals are 200 with ok:false — they are answers, not transport errors.
      return send(res, 200, result ?? { ok: false, error: 'no result' });
    } catch (err) {
      log(`[miniapp] ${req.method} ${url.pathname} failed: ${err.message}`);
      return send(res, 500, { ok: false, error: 'Kesalahan di server. Lihat log.' });
    }
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { ok: false, error: 'bad request' }); }
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { ok: false, error: 'method not allowed' });
      return void handleApi(req, res, url).catch(err => {
        log(`[miniapp] unhandled ${err.message}`);
        if (!res.headersSent) send(res, 500, { ok: false, error: 'server error' });
      });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { ok: false, error: 'method not allowed' });
    return serveStatic(req, res, url.pathname);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 60;
  return server;
}

export async function startMiniAppServer({ host = '127.0.0.1', port = 8787, log = console.log, ...options } = {}) {
  // Refuse to listen on a public interface: this server speaks plain HTTP and is
  // meant to sit behind the proxy or tunnel.
  if (!LOOPBACK.has(host)) throw new Error(`MINIAPP_HOST must be loopback (got ${host}); expose the Mini App through the HTTPS proxy or tunnel instead`);
  const server = createMiniAppServer({ log, ...options });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      server.on('error', err => log(`[miniapp] server error ${err.message}`));
      log(`[miniapp] listening on http://${host}:${server.address().port}`);
      resolve(server);
    });
  });
}
