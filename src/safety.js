// Pengecekan "bisa dijual?" sebelum membuka posisi. Gagal-tertutup: bila tidak bisa dipastikan, tidak masuk.
// Caranya: minta quote beli (SOL -> token) lalu quote jual untuk jumlah token yang sama (token -> SOL). Tidak ada rute jual,
// likuiditas 0, atau kerugian round-trip besar = honeypot / pool kering / terlalu tipis untuk ukuran posisi.
// Batas: ini simulasi lewat quote, bukan jaminan. Pajak/blacklist yang hanya aktif saat transfer bisa lolos; Token-2022 ditolak secara bawaan.
const SOL = 'So11111111111111111111111111111111111111112';
const CLASSIC_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const MIN_LIQUIDITY_USD = 100;   // di bawah ini pool dianggap kosong (sisa residu bukan likuiditas)
const fail = (reason) => ({ ok: false, reason });

// Likuiditas terkunci/terbakar: tidak bisa ditarik pembuat pool. Nilainya = persen LP terkunci x likuiditas pool (USD).
// Gagal-tertutup: tanpa data kunci (RugCheck belum mengindeks token / API mati), token tidak dimasuki.
async function lockedLiquidityFailure({ rugcheck, mint, token, minUsd }) {
  let report;
  try { report = await rugcheck.summary(mint); } catch (err) { return `status kunci likuiditas tidak bisa diperiksa (${err.message})`; }
  if (!report || report.lpLockedPct == null || !Number.isFinite(report.lpLockedPct)) return 'status kunci likuiditas tidak tersedia (token belum dikenal RugCheck)';
  const liquidity = Number(token?.liquidity);
  if (!Number.isFinite(liquidity)) return 'likuiditas pool tidak diketahui, kunci tidak bisa dinilai';
  const lockedUsd = liquidity * report.lpLockedPct / 100;
  if (!(lockedUsd >= minUsd)) return `likuiditas terkunci hanya ${report.lpLockedPct.toFixed(0)}% (sekitar ${Math.round(lockedUsd)} USD, batas ${minUsd} USD): pembuat pool masih bisa menariknya`;
  return null;
}

export async function sellabilityCheck({ jup, mint, token = null, sizeSol, maxLossPct = 15, rejectToken2022 = false, chain = null, maxFeeBps = 300, rugcheck = null, requireLpLock = false, lpLockMinUsd = 5000 }) {
  if (token && token.liquidity != null && !(Number(token.liquidity) >= MIN_LIQUIDITY_USD)) return fail(`likuiditas hampir 0 (${Number(token.liquidity) || 0} USD): tidak akan bisa dijual`);
  if (token?.tokenProgram && token.tokenProgram !== CLASSIC_TOKEN_PROGRAM) {
    if (rejectToken2022) return fail('Token-2022 ditolak oleh setelan');
    // Token-2022: boleh bila akun mint di blockchain tidak punya ekstensi berbahaya. Tidak bisa diperiksa = tidak masuk.
    if (!chain?.inspectMint) return fail('Token-2022 tidak bisa diperiksa (tidak ada koneksi RPC)');
    let info;
    try { info = await chain.inspectMint(mint, { maxFeeBps }); } catch (err) { return fail(`Token-2022 tidak bisa diperiksa (${err.message})`); }
    if (info.risks.length) return fail(`Token-2022 berisiko: ${info.risks.join('; ')}`);
  }
  if (requireLpLock) {
    if (!rugcheck) return fail('kunci likuiditas wajib tetapi tidak ada sumber datanya');
    const lockFail = await lockedLiquidityFailure({ rugcheck, mint, token, minUsd: lpLockMinUsd });
    if (lockFail) return fail(lockFail);
  }
  const lamports = Math.round(sizeSol * 1e9);
  let buy;
  try { buy = await jup.quote(SOL, mint, lamports); } catch (err) { return fail(`tidak ada rute beli (${err.message})`); }
  if (!buy?.outAmount || !(Number(buy.outAmount) > 0)) return fail('quote beli kosong');
  let sell;
  try { sell = await jup.quote(mint, SOL, String(buy.outAmount)); } catch (err) { return fail(`TIDAK ADA RUTE JUAL: kemungkinan honeypot atau pool kering (${err.message})`); }
  const ratio = Number(sell?.outAmount) / lamports;
  if (!(ratio > 0)) return fail('quote jual kosong');
  const loss = (1 - ratio) * 100;
  if (loss > maxLossPct) return fail(`beli lalu jual langsung rugi ${loss.toFixed(0)}% (batas ${maxLossPct}%): terlalu tipis atau ada pajak`);
  return { ok: true, roundTripPct: Number((ratio * 100).toFixed(1)) };
}
