// Menyalakan server Mini App dan menjaga alamat publiknya (tunnel) tetap terpasang di tombol menu bot.
import { operatorIds } from './auth.js';
import { startMiniAppServer } from './server.js';
import { watchPublicUrl, currentPublicUrl, onPublicUrlChange } from './publicUrl.js';
import { buildRoutes } from './api.js';

export async function startMiniApp({ actions, tg, env = process.env, log = console.log }) {
  if (String(env.MINIAPP_ENABLED ?? 'true').toLowerCase() === 'false') { log('[miniapp] mati (MINIAPP_ENABLED=false)'); return null; }
  const operators = operatorIds({ adminIds: env.TELEGRAM_ADMIN_IDS || '', chatId: env.TELEGRAM_CHAT_ID || '' });
  if (!operators.size) log('[miniapp] tidak ada operator: isi TELEGRAM_ADMIN_IDS dengan ID Telegram kamu');
  try {
    const server = await startMiniAppServer({
      host: env.MINIAPP_HOST || '127.0.0.1', port: Number(env.MINIAPP_PORT || 8787), botToken: env.TELEGRAM_BOT_TOKEN, operators,
      maxAgeS: Number(env.MINIAPP_SESSION_HOURS || 12) * 3600, routes: buildRoutes(actions),
    });
    onPublicUrlChange((url) => { tg.setMenuButton(url).then(() => log(`[miniapp] tombol menu bot -> ${url}`)).catch((err) => log(`[miniapp] tombol menu gagal: ${err.message}`)); });
    watchPublicUrl({ env });
    log(`[miniapp] operator: ${operators.size} · URL publik: ${currentPublicUrl() || 'menunggu tunnel'}`);
    return server;
  } catch (err) {
    log(`[miniapp] gagal start: ${err.message}`);
    return null;
  }
}
