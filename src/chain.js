// Membaca akun mint langsung dari blockchain untuk memeriksa ekstensi Token-2022 yang bisa menjebak pemegang.
// Data Jupiter hanya menyebut program token; ekstensi (pajak transfer, delegasi permanen, hook) hanya terlihat di akun mint.
import { Connection, PublicKey } from '@solana/web3.js';

export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ZERO = (buf) => buf.every((b) => b === 0);

const EXT = { TRANSFER_FEE: 1, DEFAULT_STATE: 5, NON_TRANSFERABLE: 8, PERMANENT_DELEGATE: 11, TRANSFER_HOOK: 13 };

// Mem-parse data akun mint Token-2022. Mengembalikan { extensions: [id...], risks: [teks...] }.
export function parseMintExtensions(data, { maxFeeBps = 300 } = {}) {
  const risks = [];
  const extensions = [];
  if (!data || data.length <= 166) return { extensions, risks };           // mint tanpa ekstensi
  if (data[165] !== 1) return { extensions, risks: ['akun bukan mint yang dikenali'] };
  let offset = 166;
  while (offset + 4 <= data.length) {
    const type = data.readUInt16LE(offset);
    const len = data.readUInt16LE(offset + 2);
    if (type === 0 && len === 0) break;
    const value = data.subarray(offset + 4, offset + 4 + len);
    offset += 4 + len;
    extensions.push(type);
    if (type === EXT.TRANSFER_FEE && value.length >= 108) {
      const bps = Math.max(value.readUInt16LE(72 + 16), value.readUInt16LE(90 + 16));   // tarif lama & baru: ambil yang terbesar
      if (bps > maxFeeBps) risks.push(`pajak transfer ${(bps / 100).toFixed(1)}% (batas ${(maxFeeBps / 100).toFixed(1)}%)`);
    } else if (type === EXT.PERMANENT_DELEGATE && value.length >= 32 && !ZERO(value.subarray(0, 32))) {
      risks.push('permanent delegate aktif (pihak lain bisa memindahkan/membakar token pemegang)');
    } else if (type === EXT.TRANSFER_HOOK && value.length >= 64 && !ZERO(value.subarray(32, 64))) {
      risks.push('transfer hook aktif (program lain bisa menolak transfer/jual)');
    } else if (type === EXT.NON_TRANSFERABLE) {
      risks.push('token tidak bisa ditransfer');
    } else if (type === EXT.DEFAULT_STATE && value.length >= 1 && value[0] === 2) {
      risks.push('akun baru dibekukan secara bawaan');
    }
  }
  return { extensions, risks };
}

export function rpcUrl(env = process.env) {
  return env.SOLANA_RPC_URL || (env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : 'https://api.mainnet-beta.solana.com');
}

export function createChain({ env = process.env, connection = null } = {}) {
  const conn = () => connection || (connection = new Connection(rpcUrl(env), 'confirmed'));
  return {
    // { program, extensions, risks }; melempar galat bila akun tidak bisa dibaca (pemanggil memperlakukannya sebagai gagal-tertutup).
    async inspectMint(mint, opts = {}) {
      const info = await conn().getAccountInfo(new PublicKey(mint));
      if (!info) throw new Error('akun mint tidak ditemukan');
      const program = info.owner.toBase58();
      if (program !== TOKEN_2022_PROGRAM) return { program, extensions: [], risks: [] };
      return { program, ...parseMintExtensions(Buffer.from(info.data), opts) };
    },
  };
}
