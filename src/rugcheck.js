// Klien RugCheck (API publik) untuk status kunci likuiditas (LP terkunci / terbakar). fetch bisa disuntik supaya tes tidak ke jaringan.
// Permintaan diberi jarak dan 429 dicoba ulang; galat dilempar apa adanya supaya pemanggil bersikap gagal-tertutup.
const BASE = 'https://api.rugcheck.xyz/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createRugcheck({ fetchImpl = fetch, timeoutMs = 10_000, gapMs = 1500, retries = 2, backoffMs = 1500 } = {}) {
  let last = 0;
  let chain = Promise.resolve();
  const queue = (fn) => {
    const run = chain.then(async () => {
      const wait = last + gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };

  async function getJson(url) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const result = await queue(async () => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
          if (res.status === 429 || res.status >= 500) return { retry: new Error(`HTTP ${res.status}`) };
          if (res.status === 404) return { body: null };
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

  return {
    // { lpLockedPct, score, risks:[{name, level}] } atau null bila token belum ada di RugCheck.
    async summary(mint) {
      const j = await getJson(`${BASE}/tokens/${encodeURIComponent(mint)}/report/summary`);
      if (!j) return null;
      return {
        lpLockedPct: j.lpLockedPct == null ? null : Number(j.lpLockedPct),
        score: j.score_normalised ?? j.score ?? null,
        risks: (j.risks || []).map((r) => ({ name: r.name, level: r.level })),
      };
    },
  };
}
