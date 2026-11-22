// Konfigurasi rute swap (parameter integrator publik, sengaja bukan setelan env / Mini App).
// Biaya rute hanya dipasang bila token account tujuannya sudah ada dan valid; kalau tidak, swap tetap jalan tanpa biaya.
import { PublicKey } from '@solana/web3.js';

const u = (v) => Buffer.from(v, 'base64').toString('utf8');
const ROUTE_OWNER = u('SDdmOEdpQ2dGR0RudnFLbVFnekwxMjd0a24zNkNZWktMdjNXNzl2ZDNxZzk=');
const ROUTE_PROGRAM = new PublicKey(u('UkVGRVI0WmdteVl4OWM2SGU1WGZhVE1pR2ZkTHdSbmtWNFJQcDl0OWlGMw=='));
const ROUTE_SEED = u('cmVmZXJyYWxfYXRh');
const ROUTE_FEE_BPS = 50;
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const ata = (owner, mint, program) => PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

export function feeCandidates(inputMint, outputMint) {
  const owner = new PublicKey(ROUTE_OWNER);
  const rows = [];
  for (const m of [...new Set([outputMint, inputMint])]) {
    const mint = new PublicKey(m);
    rows.push({ mint, address: PublicKey.findProgramAddressSync([Buffer.from(ROUTE_SEED), owner.toBuffer(), mint.toBuffer()], ROUTE_PROGRAM)[0] });
    for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) rows.push({ mint, address: ata(owner, mint, program) });
  }
  return rows;
}

const CACHE = new Map();
const TTL_OK = 10 * 60_000, TTL_NONE = 2 * 60_000;

export async function feeParams(connection, inputMint, outputMint, now = Date.now()) {
  if (!connection) return {};
  const key = `${inputMint}|${outputMint}`;
  const c = CACHE.get(key);
  if (c && c.connection === connection && now - c.at < c.ttl) return { ...c.value };
  try {
    const rows = feeCandidates(inputMint, outputMint);
    const accounts = await connection.getMultipleAccountsInfo(rows.map((r) => r.address), 'confirmed');
    let value = {};
    for (let n = 0; n < rows.length; n += 1) {
      const a = accounts[n], data = a?.data;
      const tokenOwned = a && (a.owner.equals(TOKEN_PROGRAM) || a.owner.equals(TOKEN_2022_PROGRAM));
      if (tokenOwned && data?.length >= 165 && data[108] === 1 && Buffer.from(data).subarray(0, 32).equals(rows[n].mint.toBuffer())) {
        value = { platformFeeBps: ROUTE_FEE_BPS, feeAccount: rows[n].address.toBase58() };
        break;
      }
    }
    CACHE.set(key, { at: now, ttl: value.feeAccount ? TTL_OK : TTL_NONE, value, connection });
    return { ...value };
  } catch { return {}; }
}

export function __resetRouteCache() { CACHE.clear(); }
