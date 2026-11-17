/**
 * Crypto-agility: Signer / Verifier interfaces and concrete implementations.
 *
 * Today only RSA-SHA256 (for GitHub App JWTs) and HMAC-SHA256 (for webhooks)
 * are wired in. The interface is designed so that adding ML-DSA-65 or a hybrid
 * scheme later is a single-file change.
 */
import { createHmac, createPrivateKey, createSign, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignerKty = "rsa-sha256" | "hmac-sha256" | "ml-dsa-65" | "hybrid-rsa-mldsa";

export interface Signer {
  readonly kty: SignerKty;
  /** JWT `alg` header value, e.g. "RS256". Undefined for MAC-only signers. */
  readonly jwtAlg?: string;
  sign(message: Buffer): Promise<Buffer>;
}

interface Verifier {
  readonly kty: SignerKty;
  /** MUST use timingSafeEqual for MAC-based verification. */
  verify(message: Buffer, signature: Buffer): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// RSA-SHA256 (GitHub App JWT)
// ---------------------------------------------------------------------------

export class Rs256Signer implements Signer {
  readonly kty: SignerKty = "rsa-sha256";
  readonly jwtAlg = "RS256";

  private readonly key: ReturnType<typeof createPrivateKey>;

  constructor(privateKey: string | Buffer) {
    this.key = createPrivateKey(privateKey);
  }

  async sign(message: Buffer): Promise<Buffer> {
    const signer = createSign("RSA-SHA256");
    signer.update(message);
    return signer.sign(this.key);
  }
}

// ---------------------------------------------------------------------------
// HMAC-SHA256 (webhooks)
// ---------------------------------------------------------------------------

export class HmacSha256Signer implements Signer {
  readonly kty: SignerKty = "hmac-sha256";
  readonly jwtAlg = undefined;

  constructor(private readonly secret: string | Buffer) {}

  async sign(message: Buffer): Promise<Buffer> {
    return createHmac("sha256", this.secret).update(message).digest();
  }
}

export class HmacSha256Verifier implements Verifier {
  readonly kty: SignerKty = "hmac-sha256";

  constructor(private readonly secret: string | Buffer) {}

  async verify(message: Buffer, signature: Buffer): Promise<boolean> {
    const expected = createHmac("sha256", this.secret).update(message).digest();
    if (expected.length !== signature.length) return false;
    return timingSafeEqual(expected, signature);
  }
}

// ---------------------------------------------------------------------------
// ML-DSA-65 stub (not yet available in Node's crypto)
// ---------------------------------------------------------------------------

export class NotImplementedError extends Error {
  constructor(algorithm: string) {
    super(`${algorithm} is not yet supported — waiting for Node.js crypto support`);
    this.name = "NotImplementedError";
  }
}

export class MlDsa65Signer implements Signer {
  readonly kty: SignerKty = "ml-dsa-65";
  readonly jwtAlg = "ML-DSA-65";

  async sign(_message: Buffer): Promise<Buffer> {
    throw new NotImplementedError("ML-DSA-65");
  }
}
