import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMintExtensions, createChain, TOKEN_2022_PROGRAM } from '../src/chain.js';
import { sellabilityCheck } from '../src/safety.js';
import { PublicKey } from '@solana/web3.js';

// Data akun mint Token-2022: 82 byte mint + padding sampai 165, byte 165 = tipe akun (1 = mint), lalu daftar TLV.
function mintData(extensions) {
  const head = Buffer.alloc(166);
  head[165] = 1;
  const parts = extensions.map(([type, value]) => {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(type, 0);
    h.writeUInt16LE(value.length, 2);
    return Buffer.concat([h, value]);
  });
  return Buffer.concat([head, ...parts]);
}
const feeConfig = (bps) => {
  const v = Buffer.alloc(108);
  v.writeUInt16LE(bps, 72 + 16);   // tarif lama
  v.writeUInt16LE(bps, 90 + 16);   // tarif baru
  return v;
};
const key = (fill) => Buffer.alloc(32, fill);

test('mint tanpa ekstensi atau hanya metadata/grup: tidak ada risiko', () => {
  assert.deepEqual(parseMintExtensions(Buffer.alloc(82)).risks, []);
  const meta = mintData([[18, Buffer.alloc(40)], [19, Buffer.alloc(64)]]);
  const r = parseMintExtensions(meta);
  assert.deepEqual(r.extensions, [18, 19]); assert.deepEqual(r.risks, []);
});

test('ekstensi berbahaya terdeteksi: pajak transfer di atas batas, permanent delegate, transfer hook, non-transferable, akun dibekukan', () => {
  assert.match(parseMintExtensions(mintData([[1, feeConfig(500)]]), { maxFeeBps: 300 }).risks[0], /pajak transfer 5\.0%/);
  assert.deepEqual(parseMintExtensions(mintData([[1, feeConfig(200)]]), { maxFeeBps: 300 }).risks, []);      // di bawah batas: boleh
  assert.match(parseMintExtensions(mintData([[11, key(7)]])).risks[0], /permanent delegate/);
  assert.deepEqual(parseMintExtensions(mintData([[11, key(0)]])).risks, []);                                // delegate kosong: aman
  assert.match(parseMintExtensions(mintData([[13, Buffer.concat([key(0), key(9)])]])).risks[0], /transfer hook/);
  assert.deepEqual(parseMintExtensions(mintData([[13, Buffer.concat([key(0), key(0)])]])).risks, []);       // hook tanpa program: aman
  assert.match(parseMintExtensions(mintData([[8, Buffer.alloc(0)]])).risks[0], /tidak bisa ditransfer/);
  assert.match(parseMintExtensions(mintData([[5, Buffer.from([2])]])).risks[0], /dibekukan/);
  assert.deepEqual(parseMintExtensions(mintData([[5, Buffer.from([1])]])).risks, []);                       // bawaan 'initialized': aman
  const many = parseMintExtensions(mintData([[18, Buffer.alloc(8)], [11, key(1)], [8, Buffer.alloc(0)]]));
  assert.equal(many.risks.length, 2);
});

test('inspectMint: akun klasik, akun Token-2022, dan akun tidak ada (gagal-tertutup lewat galat)', async () => {
  const classic = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const t22 = new PublicKey(TOKEN_2022_PROGRAM);
  const mint = new PublicKey(Buffer.alloc(32, 3)).toBase58();
  const mk = (owner, data) => createChain({ connection: { getAccountInfo: async () => (owner ? { owner, data } : null) } });
  assert.deepEqual((await mk(classic, Buffer.alloc(82)).inspectMint(mint)).risks, []);
  const r = await mk(t22, mintData([[11, key(5)]])).inspectMint(mint);
  assert.match(r.risks[0], /permanent delegate/);
  await assert.rejects(() => mk(null).inspectMint(mint), /tidak ditemukan/);
});

const SOL = 'So11111111111111111111111111111111111111112';
const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const goodQuotes = { quote: async (a) => (a === SOL ? { outAmount: '1000' } : { outAmount: String(0.05e9 * 0.97) }) };

test('uji bisa-dijual untuk Token-2022: ekstensi aman lolos, berbahaya ditolak, RPC mati = ditolak, setelan "tolak semua" berlaku', async () => {
  const token = { id: 'M1', liquidity: 20000, tokenProgram: T22 };
  const base = { jup: goodQuotes, mint: 'M1', token, sizeSol: 0.05 };
  assert.equal((await sellabilityCheck({ ...base, chain: { inspectMint: async () => ({ risks: [] }) } })).ok, true);
  const bad = await sellabilityCheck({ ...base, chain: { inspectMint: async () => ({ risks: ['permanent delegate aktif'] }) } });
  assert.equal(bad.ok, false); assert.match(bad.reason, /Token-2022 berisiko: permanent delegate/);
  assert.match((await sellabilityCheck({ ...base, chain: { inspectMint: async () => { throw new Error('RPC 429'); } } })).reason, /tidak bisa diperiksa \(RPC 429\)/);
  assert.match((await sellabilityCheck({ ...base })).reason, /tidak ada koneksi RPC/);
  assert.match((await sellabilityCheck({ ...base, rejectToken2022: true, chain: { inspectMint: async () => ({ risks: [] }) } })).reason, /ditolak oleh setelan/);
});
