// Tombol token untuk Telegram: GMGN (buka halaman token) dan CA (salin alamat kontrak ke clipboard lewat copy_text).
export const gmgnUrl = (mint) => `https://gmgn.ai/sol/token/${mint}`;

// Satu baris tombol untuk satu token: [GMGN] [CA]
export const tokenButtons = (mint) => [
  { text: 'GMGN', url: gmgnUrl(mint) },
  { text: 'CA', copy_text: { text: String(mint) } },
];

// Satu baris per token dengan nama token di label, untuk balasan daftar (/posisi, /watch, /history).
// Token yang sama hanya muncul sekali; dibatasi supaya tidak melewati batas tombol Telegram.
export function tokenRows(items, limit = 20) {
  const seen = new Set();
  const rows = [];
  for (const item of items) {
    if (!item?.mint || seen.has(item.mint)) continue;
    seen.add(item.mint);
    const name = String(item.symbol || String(item.mint).slice(0, 6)).slice(0, 14);
    rows.push([{ text: `GMGN ${name}`, url: gmgnUrl(item.mint) }, { text: `CA ${name}`, copy_text: { text: String(item.mint) } }]);
    if (rows.length >= limit) break;
  }
  return rows;
}
