import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { blake2b, openSealedBox, poly1305, sealedBox, x25519Public } from "./sealed-box.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

describe("BLAKE2b", () => {
  // Digests from Python's hashlib.blake2b (an independent implementation).
  it("matches the reference digests at 24, 32 and 64 bytes", () => {
    const abc = new TextEncoder().encode("abc");
    expect(hex(blake2b(abc, 64))).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1" +
        "7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
    expect(hex(blake2b(abc, 24))).toBe("56a17e38cc371a46b12c32f18e0c61de2a84e9c2555b114e");
    expect(hex(blake2b(new Uint8Array(0), 24))).toBe(
      "ab3b5331a7135ed50d0f182d026e60abdb3646fd51bcf8a3",
    );
    const data = new Uint8Array(300).map((_, i) => i & 0xff);
    expect(hex(blake2b(data.subarray(0, 128), 24))).toBe(
      "2f5f6c3d92c87ec6916cd0034fea92dfd83b28dc91485d41",
    );
    expect(hex(blake2b(data, 32))).toBe(
      "3a486e3fe3ee414853000269ac020030aeef748cb05cd62ba85939ec298ef25c",
    );
  });

  it("agrees with node's BLAKE2b-512 on assorted lengths", () => {
    for (const n of [1, 63, 64, 127, 128, 129, 256, 1000]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + n) & 0xff);
      expect(hex(blake2b(data, 64))).toBe(createHash("blake2b512").update(data).digest("hex"));
    }
  });
});

describe("Poly1305", () => {
  it("matches RFC 8439 §2.5.2", () => {
    const key = bytes("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b");
    const msg = new TextEncoder().encode("Cryptographic Forum Research Group");
    expect(hex(poly1305(msg, key))).toBe("a8061dc1305136c6c22b8baf0c0127a9");
  });
});

describe("sealedBox (crypto_box_seal)", () => {
  // Made with tweetnacl's nacl.box and Python's BLAKE2b nonce: the box
  // GitHub's libsodium opens.
  const esk = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff);
  const rsk = new Uint8Array(32).map((_, i) => (i * 13 + 5) & 0xff);
  const rpk = bytes("c25e8b84378b21071d603dfce3f947b162b6e715240344db0a18d99259a6de23");
  const message = new TextEncoder().encode("export OPTIO_TOKEN='optio_pat_x'\n");

  it("derives the X25519 public key", () => {
    expect(hex(x25519Public(rsk))).toBe(hex(rpk));
    expect(hex(x25519Public(esk))).toBe(
      "c8feca81be196cdf2cadeabf13c4903d7632dce4955aa68b6e5d9adef54e2616",
    );
  });

  it("produces libsodium's layout byte for byte", () => {
    expect(hex(sealedBox(message, rpk, esk))).toBe(
      "c8feca81be196cdf2cadeabf13c4903d7632dce4955aa68b6e5d9adef54e2616" +
        "f96a0acd0abffdc1ca35fa76599c5a2172cc7b89321a255790078a7d8f5928df" +
        "1005cb397b2ba10f9802670dd96cb12bc1",
    );
  });

  it("opens with the recipient's key, with a fresh ephemeral key each time", () => {
    const a = sealedBox(message, rpk);
    const b = sealedBox(message, rpk);
    expect(hex(a)).not.toBe(hex(b));
    expect(new TextDecoder().decode(openSealedBox(a, rpk, rsk)!)).toBe(
      "export OPTIO_TOKEN='optio_pat_x'\n",
    );
    const tampered = new Uint8Array(a);
    tampered[60] ^= 1;
    expect(openSealedBox(tampered, rpk, rsk)).toBeNull();
  });
});
