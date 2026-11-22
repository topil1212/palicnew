// Where the Mini App is reachable from the outside.
//
// Telegram only opens Mini Apps over HTTPS, and the server itself listens on
// loopback. Two ways to be reachable (set up by install.sh):
//   * MINIAPP_PUBLIC_URL  — a domain in front of the server (Caddy + Let's Encrypt)
//   * a Cloudflare quick tunnel, whose https://…trycloudflare.com address changes
//     on every tunnel restart. Read from cloudflared's metrics server
//     (MINIAPP_TUNNEL_METRICS=127.0.0.1:port, endpoint /quicktunnel) or, failing
//     that, from its log (MINIAPP_TUNNEL_LOG).

import fs from 'node:fs';

const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;

export function normalizeUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:') return '';       // Telegram refuses anything else
    if (url.username || url.password) return '';
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function latestTunnelUrl(logText) {
  const matches = String(logText ?? '').match(TUNNEL_URL);
  return matches && matches.length ? matches[matches.length - 1] : '';
}

export function readTunnelUrl(logPath) {
  if (!logPath) return '';
  try {
    const stat = fs.statSync(logPath);
    if (!stat.isFile()) return '';
    // Only the tail matters; the log is truncated on every tunnel start.
    const size = Math.min(stat.size, 256 * 1024);
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
      return latestTunnelUrl(buffer.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

let current = '';
const listeners = new Set();

export function currentPublicUrl() {
  return current;
}

export function setPublicUrl(url) {
  const next = normalizeUrl(url);
  if (next === current) return false;
  current = next;
  for (const listener of listeners) {
    try { listener(current); } catch { /* a listener must not break the watcher */ }
  }
  return true;
}

export function onPublicUrlChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// cloudflared answers GET /quicktunnel with {"hostname":"xyz.trycloudflare.com"}.
export async function fetchTunnelUrl(metricsAddr, { fetchImpl = globalThis.fetch, timeoutMs = 3000 } = {}) {
  const addr = String(metricsAddr || '').trim();
  // Loopback only: this is a local process, never a remote URL from config.
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/.test(addr) || typeof fetchImpl !== 'function') return '';
  try {
    const res = await fetchImpl(`http://${addr}/quicktunnel`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return '';
    const host = String((await res.json())?.hostname || '').toLowerCase();
    return /^[a-z0-9-]+\.trycloudflare\.com$/.test(host) ? `https://${host}` : '';
  } catch {
    return '';
  }
}

// Resolves the URL now and keeps it current. Returns a stop function.
export function watchPublicUrl({ env = process.env, intervalMs = 15_000 } = {}) {
  // A quick-tunnel address left in MINIAPP_PUBLIC_URL is stale by definition
  // (it changes on every tunnel restart): never treat it as a fixed domain.
  const fixed = normalizeUrl(env.MINIAPP_PUBLIC_URL);
  if (fixed && !/\.trycloudflare\.com$/i.test(new URL(fixed).hostname)) { setPublicUrl(fixed); return () => {}; }
  const metrics = env.MINIAPP_TUNNEL_METRICS;
  const logPath = env.MINIAPP_TUNNEL_LOG;
  if (!metrics && !logPath) return () => {};
  const check = async () => {
    const url = (metrics ? await fetchTunnelUrl(metrics) : '') || readTunnelUrl(logPath);
    if (url) setPublicUrl(url);
  };
  check().catch(() => {});
  const timer = setInterval(() => { check().catch(() => {}); }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// A browser sends Origin on every cross-origin request and on same-origin POSTs.
// When present it must be the Mini App's own origin: either the known public URL,
// or the host this very request was addressed to (both proxies pass Host through).
// When absent (same-origin GET, non-browser client) the signed initData is the
// only gate — which it always is: there are no cookies to ride on.
export function originAcceptable(originHeader, publicUrl = current, hostHeader = '') {
  if (originHeader === undefined || originHeader === null || originHeader === '') return true;
  if (typeof originHeader !== 'string' || originHeader === 'null') return false;
  let origin;
  try { origin = new URL(originHeader); } catch { return false; }
  if (publicUrl) {
    try { if (origin.origin === new URL(publicUrl).origin) return true; } catch { /* fall through */ }
  }
  return origin.protocol === 'https:' && Boolean(hostHeader) && origin.host.toLowerCase() === String(hostHeader).toLowerCase();
}
