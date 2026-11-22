// Klien data publik Jupiter (tanpa API key). fetch bisa disuntik supaya tes tidak menyentuh jaringan.
const LITE = 'https://lite-api.jup.ag';
const DATA = 'https://datapi.jup.ag';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Antrean per host: permintaan diberi jarak minimum supaya dua pemindai + pemantau harga tidak memicu rate limit (HTTP 429).
function makeQueue(gapMs) {
  let last = 0;
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.then(async () => {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
}

export function createJupiter({ fetchImpl = fetch, timeoutMs = 10_000, gapMs = { lite: 1100, data: 300 }, retries = 3, backoffMs = 1000 } = {}) {
  const queues = { lite: makeQueue(gapMs.lite), data: makeQueue(gapMs.data) };

  async function getJson(url) {
    const queue = queues[url.startsWith(DATA) ? 'data' : 'lite'];
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const result = await queue(async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
          if (res.status === 429 || res.status >= 500) return { retry: new Error(`HTTP ${res.status} ${new URL(url).pathname}`) };
          if (!res.ok) {
            let detail = '';
            try { const b = await res.json(); detail = b?.error || b?.message || ''; } catch { /* tanpa detail */ }
            throw new Error(`HTTP ${res.status} ${new URL(url).pathname}${detail ? ` · ${detail}` : ''}`);
          }
          return { body: await res.json() };
        } finally {
          clearTimeout(timer);
        }
      });
      if (!result.retry) return result.body;
      lastError = result.retry;
      if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
    }
    throw lastError;
  }

  // Daftar trending/pair baru tidak pernah kosong di kenyataan; respons 200 berisi [] adalah gangguan sesaat, jadi dicoba ulang.
  async function getList(url) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const rows = await getJson(url);
      if (Array.isArray(rows) && rows.length) return rows;
      if (attempt < retries) await sleep(backoffMs * (attempt + 1));
    }
    return [];
  }

  return {
    async trending(interval = '6h', limit = 100) {
      return getList(`${LITE}/tokens/v2/toptrending/${interval}?limit=${limit}`);
    },
    // Quote swap (lite-api). Dipakai untuk uji bisa-dijual; 400 'No routes found' dilempar sebagai galat.
    async quote(inputMint, outputMint, amountRaw, slippageBps = 1000) {
      return getJson(`${LITE}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`);
    },
    // Beberapa token sekaligus (maks 100 mint) dalam satu permintaan; token yang tidak ditemukan tidak muncul di hasil.
    async tokens(mints) {
      if (!mints.length) return [];
      const rows = await getJson(`${LITE}/tokens/v2/search?query=${mints.slice(0, 100).join(',')}`);
      return Array.isArray(rows) ? rows : [];
    },
    // Satu token lengkap (bentuk sama dengan daftar trending) lewat pencarian mint; null bila tidak ada.
    // Pair yang baru dibuat (umur biasanya < 1 jam) dan token paling banyak diperdagangkan dalam interval itu.
    async recent(limit = 100) {
      return getList(`${LITE}/tokens/v2/recent?limit=${limit}`);
    },
    async toptraded(interval = '5m', limit = 100) {
      return getList(`${LITE}/tokens/v2/toptraded/${interval}?limit=${limit}`);
    },
    async token(mint) {
      const rows = await getJson(`${LITE}/tokens/v2/search?query=${encodeURIComponent(mint)}`);
      return (Array.isArray(rows) ? rows : []).find((t) => t?.id === mint) || null;
    },
    async prices(mints) {
      const out = {};
      for (let i = 0; i < mints.length; i += 50) {
        const ids = mints.slice(i, i + 50).join(',');
        const body = await getJson(`${LITE}/price/v3?ids=${ids}`);
        for (const [mint, info] of Object.entries(body || {})) {
          const price = Number(info?.usdPrice);
          if (price > 0) out[mint] = price;
        }
      }
      return out;
    },
    async candles(mint, { interval = '1_HOUR', count = 168 } = {}) {
      const body = await getJson(`${DATA}/v2/charts/${mint}?interval=${interval}&to=${Date.now()}&candles=${count}&type=price&quote=usd`);
      const rows = Array.isArray(body?.candles) ? body.candles : [];
      return rows
        .map((c) => ({ time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) }))
        .filter((c) => c.time > 0 && c.high > 0 && c.low > 0 && c.high >= c.low)
        .sort((a, b) => a.time - b.time);
    },
  };
}
