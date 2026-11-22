// Klien Telegram minimal lewat Bot API (long polling). Hanya chat yang terdaftar yang dilayani.
export function createTelegram({ token, chatId = '', fetchImpl = fetch, log = console.log }) {
  const api = (method) => `https://api.telegram.org/bot${token}/${method}`;
  let stopped = false;

  async function call(method, body, timeoutMs = 15_000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(api(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) throw new Error(`${method}: ${json.description || res.status}`);
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendTo(id, text, extra = {}) {
    if (!token || !id) return;
    for (let i = 0; i < text.length; i += 3800) {
      await call('sendMessage', { chat_id: id, text: text.slice(i, i + 3800), disable_web_page_preview: true, ...(i === 0 ? extra : {}) });
    }
  }

  async function sendPhotoTo(id, buffer, caption = '', extra = {}) {
    if (!token || !id) return;
    const form = new FormData();
    form.set('chat_id', String(id));
    form.set('caption', caption.slice(0, 1000));
    if (extra.parse_mode) form.set('parse_mode', extra.parse_mode);
    if (extra.reply_markup) form.set('reply_markup', JSON.stringify(extra.reply_markup));
    form.set('photo', new Blob([buffer], { type: 'image/png' }), 'card.png');
    const res = await fetchImpl(api('sendPhoto'), { method: 'POST', body: form });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`sendPhoto: ${json.description || res.status}`);
  }

  return {
    enabled: Boolean(token),
    send: (text, extra) => sendTo(chatId, text, extra),
    sendPhoto: (buffer, caption, extra) => sendPhotoTo(chatId, buffer, caption, extra),
    // Tombol menu bot membuka Mini App; url kosong mengembalikannya ke menu bawaan.
    async setMenuButton(url, text = 'Palic') {
      if (!token) return;
      const menu_button = url ? { type: 'web_app', text, web_app: { url: `${url}/` } } : { type: 'default' };
      const body = { menu_button };
      if (chatId && /^\d+$/.test(String(chatId))) body.chat_id = Number(chatId);
      await call('setChatMenuButton', body);
    },
    async poll(handler) {
      if (!token) return;
      let offset = 0;
      while (!stopped) {
        try {
          const updates = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 35_000);
          for (const update of updates) {
            offset = update.update_id + 1;
            const msg = update.message;
            if (!msg?.text) continue;
            const from = String(msg.chat.id);
            if (!chatId) {
              if (msg.text.startsWith('/start')) await sendTo(from, `Chat ID kamu: ${from}\nIsi TELEGRAM_CHAT_ID=${from} di file .env lalu restart bot.`);
              continue;
            }
            if (from !== String(chatId)) { log(`[telegram] pesan dari chat tidak terdaftar diabaikan: ${from}`); continue; }
            try {
              // Handler boleh mengembalikan teks, atau { text, buttons } (baris tombol inline, mis. GMGN/CA per token).
              const out = await handler(msg.text.trim());
              if (typeof out === 'string') await sendTo(from, out);
              else await sendTo(from, out.text, out.buttons?.length ? { reply_markup: { inline_keyboard: out.buttons } } : {});
            } catch (err) { await sendTo(from, `Error: ${err.message}`); }
          }
        } catch (err) {
          log(`[telegram] polling: ${err.message}`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    },
    stop() { stopped = true; },
  };
}
