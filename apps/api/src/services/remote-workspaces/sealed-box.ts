/**
 * libsodium's sealed box (`crypto_box_seal`), which GitHub's REST API wants
 * secrets encrypted with ("Encrypting secrets for the REST API"): an
 * ephemeral X25519 key pair, the nonce BLAKE2b-192(ephemeral pk ‖ recipient
 * pk), and NaCl's crypto_box (X25519 + HSalsa20 → XSalsa20-Poly1305) —
 * `ephemeral pk ‖ tag ‖ ciphertext`.
 *
 * Node's crypto has X25519 but neither XSalsa20 nor Poly1305 nor a
 * variable-length BLAKE2b, so those three are here, from their
 * specifications (Salsa20 and HSalsa20: Bernstein, "Extending the Salsa20
 * nonce"; Poly1305: RFC 8439 §2.5; BLAKE2b: RFC 7693). The tests check them
 * against published vectors and a sealed box made with another
 * implementation.
 */
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync } from "node:crypto";

// ── Salsa20 / HSalsa20 ──────────────────────────────────────────────────────

const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]); // "expand 32-byte k"

function rotl(v: number, c: number): number {
  return ((v << c) | (v >>> (32 - c))) >>> 0;
}

function u32le(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
}

/** The 16-word Salsa20 input for a 32-byte key and a 16-byte nonce‖counter (or HSalsa20's 16-byte input). */
function salsaState(key: Uint8Array, input16: Uint8Array): Uint32Array {
  const x = new Uint32Array(16);
  x[0] = SIGMA[0];
  x[5] = SIGMA[1];
  x[10] = SIGMA[2];
  x[15] = SIGMA[3];
  for (let i = 0; i < 4; i++) x[1 + i] = u32le(key, i * 4);
  for (let i = 0; i < 4; i++) x[11 + i] = u32le(key, 16 + i * 4);
  for (let i = 0; i < 4; i++) x[6 + i] = u32le(input16, i * 4);
  return x;
}

/** 20 rounds (10 double rounds) over `x`, in place. */
function salsaRounds(x: Uint32Array): void {
  for (let i = 0; i < 10; i++) {
    // columns
    x[4] ^= rotl((x[0] + x[12]) >>> 0, 7);
    x[8] ^= rotl((x[4] + x[0]) >>> 0, 9);
    x[12] ^= rotl((x[8] + x[4]) >>> 0, 13);
    x[0] ^= rotl((x[12] + x[8]) >>> 0, 18);
    x[9] ^= rotl((x[5] + x[1]) >>> 0, 7);
    x[13] ^= rotl((x[9] + x[5]) >>> 0, 9);
    x[1] ^= rotl((x[13] + x[9]) >>> 0, 13);
    x[5] ^= rotl((x[1] + x[13]) >>> 0, 18);
    x[14] ^= rotl((x[10] + x[6]) >>> 0, 7);
    x[2] ^= rotl((x[14] + x[10]) >>> 0, 9);
    x[6] ^= rotl((x[2] + x[14]) >>> 0, 13);
    x[10] ^= rotl((x[6] + x[2]) >>> 0, 18);
    x[3] ^= rotl((x[15] + x[11]) >>> 0, 7);
    x[7] ^= rotl((x[3] + x[15]) >>> 0, 9);
    x[11] ^= rotl((x[7] + x[3]) >>> 0, 13);
    x[15] ^= rotl((x[11] + x[7]) >>> 0, 18);
    // rows
    x[1] ^= rotl((x[0] + x[3]) >>> 0, 7);
    x[2] ^= rotl((x[1] + x[0]) >>> 0, 9);
    x[3] ^= rotl((x[2] + x[1]) >>> 0, 13);
    x[0] ^= rotl((x[3] + x[2]) >>> 0, 18);
    x[6] ^= rotl((x[5] + x[4]) >>> 0, 7);
    x[7] ^= rotl((x[6] + x[5]) >>> 0, 9);
    x[4] ^= rotl((x[7] + x[6]) >>> 0, 13);
    x[5] ^= rotl((x[4] + x[7]) >>> 0, 18);
    x[11] ^= rotl((x[10] + x[9]) >>> 0, 7);
    x[8] ^= rotl((x[11] + x[10]) >>> 0, 9);
    x[9] ^= rotl((x[8] + x[11]) >>> 0, 13);
    x[10] ^= rotl((x[9] + x[8]) >>> 0, 18);
    x[12] ^= rotl((x[15] + x[14]) >>> 0, 7);
    x[13] ^= rotl((x[12] + x[15]) >>> 0, 9);
    x[14] ^= rotl((x[13] + x[12]) >>> 0, 13);
    x[15] ^= rotl((x[14] + x[13]) >>> 0, 18);
  }
}

/** HSalsa20: a 32-byte subkey from a 32-byte key and a 16-byte input. */
export function hsalsa20(key: Uint8Array, input16: Uint8Array): Uint8Array {
  const x = salsaState(key, input16);
  salsaRounds(x);
  const out = new Uint8Array(32);
  const words = [x[0], x[5], x[10], x[15], x[6], x[7], x[8], x[9]];
  const view = new DataView(out.buffer);
  words.forEach((w, i) => view.setUint32(i * 4, w, true));
  return out;
}

/** `length` bytes of the Salsa20 keystream for a 32-byte key and an 8-byte nonce, from block 0. */
export function salsa20Stream(key: Uint8Array, nonce8: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  const input = new Uint8Array(16);
  input.set(nonce8, 0);
  const block = new Uint8Array(64);
  const blockView = new DataView(block.buffer);
  for (let counter = 0, off = 0; off < length; counter++, off += 64) {
    // the 64-bit little-endian block counter
    new DataView(input.buffer).setUint32(8, counter >>> 0, true);
    new DataView(input.buffer).setUint32(12, Math.floor(counter / 2 ** 32), true);
    const init = salsaState(key, input);
    const x = new Uint32Array(init);
    salsaRounds(x);
    for (let i = 0; i < 16; i++) blockView.setUint32(i * 4, (x[i] + init[i]) >>> 0, true);
    out.set(block.subarray(0, Math.min(64, length - off)), off);
  }
  return out;
}

// ── Poly1305 (RFC 8439 §2.5) ────────────────────────────────────────────────

const P1305 = (1n << 130n) - 5n;

function leBig(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}

export function poly1305(message: Uint8Array, key32: Uint8Array): Uint8Array {
  const r = leBig(key32.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = leBig(key32.subarray(16, 32));
  let acc = 0n;
  for (let i = 0; i < message.length; i += 16) {
    const chunk = message.subarray(i, i + 16);
    const n = leBig(chunk) + (1n << BigInt(8 * chunk.length));
    acc = ((acc + n) * r) % P1305;
  }
  acc = (acc + s) & ((1n << 128n) - 1n);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) tag[i] = Number((acc >> BigInt(8 * i)) & 0xffn);
  return tag;
}

// ── BLAKE2b (RFC 7693) ──────────────────────────────────────────────────────

const MASK64 = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];
const SIGMA_B = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr64 = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK64;

function compress(h: bigint[], block: Uint8Array, t: bigint, last: boolean): void {
  const m: bigint[] = [];
  for (let i = 0; i < 16; i++) m.push(leBig(block.subarray(i * 8, i * 8 + 8)));
  const v = [...h, ...IV];
  v[12] ^= t & MASK64;
  v[13] ^= (t >> 64n) & MASK64;
  if (last) v[14] ^= MASK64;
  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint) => {
    v[a] = (v[a] + v[b] + x) & MASK64;
    v[d] = rotr64(v[d] ^ v[a], 32n);
    v[c] = (v[c] + v[d]) & MASK64;
    v[b] = rotr64(v[b] ^ v[c], 24n);
    v[a] = (v[a] + v[b] + y) & MASK64;
    v[d] = rotr64(v[d] ^ v[a], 16n);
    v[c] = (v[c] + v[d]) & MASK64;
    v[b] = rotr64(v[b] ^ v[c], 63n);
  };
  for (let i = 0; i < 12; i++) {
    const s = SIGMA_B[i % 10];
    g(0, 4, 8, 12, m[s[0]], m[s[1]]);
    g(1, 5, 9, 13, m[s[2]], m[s[3]]);
    g(2, 6, 10, 14, m[s[4]], m[s[5]]);
    g(3, 7, 11, 15, m[s[6]], m[s[7]]);
    g(0, 5, 10, 15, m[s[8]], m[s[9]]);
    g(1, 6, 11, 12, m[s[10]], m[s[11]]);
    g(2, 7, 8, 13, m[s[12]], m[s[13]]);
    g(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
}

/** Unkeyed BLAKE2b with an `outLength`-byte digest (1–64). */
export function blake2b(input: Uint8Array, outLength: number): Uint8Array {
  if (outLength < 1 || outLength > 64) throw new RangeError("BLAKE2b digests are 1 to 64 bytes");
  const h = [...IV];
  h[0] ^= 0x01010000n ^ BigInt(outLength);
  let t = 0n;
  let off = 0;
  // Every block but the last is compressed as it fills; the last (possibly
  // empty, for an empty input) is padded with zeros.
  while (input.length - off > 128) {
    t += 128n;
    compress(h, input.subarray(off, off + 128), t, false);
    off += 128;
  }
  const last = new Uint8Array(128);
  last.set(input.subarray(off));
  t += BigInt(input.length - off);
  compress(h, last, t, true);
  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((h[i] >> BigInt(8 * j)) & 0xffn);
  }
  return out.slice(0, outLength);
}

// ── X25519 through node:crypto ──────────────────────────────────────────────

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

function x25519(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const pub = createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: b64url(publicKey) },
    format: "jwk",
  });
  // A JWK private key needs its public half: derive it from the secret.
  const priv = createPrivateKey({
    key: { kty: "OKP", crv: "X25519", d: b64url(secretKey), x: b64url(x25519Public(secretKey)) },
    format: "jwk",
  });
  return new Uint8Array(diffieHellman({ privateKey: priv, publicKey: pub }));
}

/** The X25519 public key of a 32-byte secret key. */
export function x25519Public(secretKey: Uint8Array): Uint8Array {
  // PKCS#8 for X25519 is a fixed 16-byte prefix and the raw key.
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b656e04220420", "hex"),
    Buffer.from(secretKey),
  ]);
  const jwk = createPublicKey(createPrivateKey({ key: der, format: "der", type: "pkcs8" })).export({
    format: "jwk",
  });
  return new Uint8Array(Buffer.from(String(jwk.x), "base64url"));
}

function randomSecretKey(): Uint8Array {
  const jwk = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
  return new Uint8Array(Buffer.from(String(jwk.d), "base64url"));
}

// ── crypto_box and crypto_box_seal ──────────────────────────────────────────

/** NaCl crypto_box (the "easy" layout): tag ‖ ciphertext. */
export function cryptoBox(
  message: Uint8Array,
  nonce24: Uint8Array,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array,
): Uint8Array {
  const shared = x25519(senderSecretKey, recipientPublicKey);
  const k = hsalsa20(shared, new Uint8Array(16));
  const subkey = hsalsa20(k, nonce24.subarray(0, 16));
  const stream = salsa20Stream(subkey, nonce24.subarray(16, 24), 32 + message.length);
  const ciphertext = new Uint8Array(message.length);
  for (let i = 0; i < message.length; i++) ciphertext[i] = message[i] ^ stream[32 + i];
  const tag = poly1305(ciphertext, stream.subarray(0, 32));
  const out = new Uint8Array(16 + ciphertext.length);
  out.set(tag, 0);
  out.set(ciphertext, 16);
  return out;
}

/**
 * crypto_box_seal: what GitHub's `encrypted_value` is (base64 of it).
 * `ephemeralSecretKey` is for tests; a fresh one is made otherwise.
 */
export function sealedBox(
  message: Uint8Array,
  recipientPublicKey: Uint8Array,
  ephemeralSecretKey: Uint8Array = randomSecretKey(),
): Uint8Array {
  if (recipientPublicKey.length !== 32) throw new RangeError("An X25519 public key is 32 bytes");
  const epk = x25519Public(ephemeralSecretKey);
  const nonceInput = new Uint8Array(64);
  nonceInput.set(epk, 0);
  nonceInput.set(recipientPublicKey, 32);
  const nonce = blake2b(nonceInput, 24);
  const boxed = cryptoBox(message, nonce, recipientPublicKey, ephemeralSecretKey);
  const out = new Uint8Array(32 + boxed.length);
  out.set(epk, 0);
  out.set(boxed, 32);
  return out;
}

/** crypto_box_seal_open, for the tests (and nothing else): null when it doesn't open. */
export function openSealedBox(
  sealed: Uint8Array,
  recipientPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array,
): Uint8Array | null {
  if (sealed.length < 48) return null;
  const epk = sealed.subarray(0, 32);
  const tag = sealed.subarray(32, 48);
  const ciphertext = sealed.subarray(48);
  const nonceInput = new Uint8Array(64);
  nonceInput.set(epk, 0);
  nonceInput.set(recipientPublicKey, 32);
  const nonce = blake2b(nonceInput, 24);
  const shared = x25519(recipientSecretKey, epk);
  const k = hsalsa20(shared, new Uint8Array(16));
  const subkey = hsalsa20(k, nonce.subarray(0, 16));
  const stream = salsa20Stream(subkey, nonce.subarray(16, 24), 32 + ciphertext.length);
  const expected = poly1305(ciphertext, stream.subarray(0, 32));
  if (!Buffer.from(expected).equals(Buffer.from(tag))) return null;
  const out = new Uint8Array(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i++) out[i] = ciphertext[i] ^ stream[32 + i];
  return out;
}
