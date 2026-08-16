import { createHmac, timingSafeEqual } from "node:crypto";
import { getOrDeriveCredentialSecret } from "./credential-secret-service.js";

/**
 * HMAC-based authentication for internal API endpoints.
 *
 * Instead of sending the raw credential secret as a Bearer token, agent pods
 * compute an HMAC-SHA256 signature over a timestamp and request path, then
 * send the signature in the X-Optio-Signature header.
 *
 * This provides:
 * - Authentication (only someone with the secret can produce valid signatures)
 * - Replay protection (timestamps expire after MAX_AGE_SECONDS)
 * - The raw secret never crosses the wire
 *
 * Header format: X-Optio-Signature: t=<unix_seconds>,sig=<hex_hmac>
 * Signed payload: "{timestamp}.{path}" where path includes the query string.
 */

const SIGNATURE_HEADER = "x-optio-signature";
const MAX_AGE_SECONDS = 300; // 5 minutes

export interface SignatureComponents {
  timestamp: number;
  signature: string;
}

/**
 * Parse the X-Optio-Signature header.
 * Format: t=<unix_seconds>,sig=<hex_hmac>
 */
export function parseSignatureHeader(header: string): SignatureComponents | null {
  const parts: Record<string, string> = {};
  for (const part of header.split(",")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (key) parts[key] = value;
  }
  const timestamp = parseInt(parts.t, 10);
  const signature = parts.sig;
  if (isNaN(timestamp) || !signature) return null;
  return { timestamp, signature };
}

/**
 * Compute the HMAC-SHA256 signature for a request.
 */
export function computeSignature(secret: string, timestamp: number, path: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${path}`).digest("hex");
}

/**
 * Verify an internal request's HMAC signature.
 *
 * Legacy Bearer token support is disabled by default. It can be re-enabled
 * temporarily with OPTIO_ALLOW_LEGACY_INTERNAL_BEARER=1 during a controlled
 * agent-image rollout.
 *
 * Returns null if valid, or an error string if invalid.
 */
export function verifyInternalRequest(
  headers: Record<string, string | string[] | undefined>,
  requestPath: string,
): { error: string; status: number } | null {
  const secret = getOrDeriveCredentialSecret();
  if (!secret) {
    return { error: "Credential secret not configured", status: 503 };
  }

  // Prefer HMAC signature header
  const sigHeader = headers[SIGNATURE_HEADER] as string | undefined;
  if (sigHeader) {
    return verifyHmacSignature(sigHeader, requestPath, secret);
  }

  // Fall back to legacy Bearer token for backward compatibility
  const authHeader = (headers.authorization ?? "") as string;
  if (authHeader.startsWith("Bearer ")) {
    if (process.env.OPTIO_ALLOW_LEGACY_INTERNAL_BEARER !== "1") {
      return { error: "Legacy bearer authentication disabled", status: 401 };
    }
    return verifyBearerToken(authHeader, secret);
  }

  return { error: "Missing authentication", status: 401 };
}

function verifyHmacSignature(
  sigHeader: string,
  requestPath: string,
  secret: string,
): { error: string; status: number } | null {
  const parsed = parseSignatureHeader(sigHeader);
  if (!parsed) {
    return { error: "Malformed signature header", status: 401 };
  }

  // Replay protection: reject timestamps outside the allowed window
  const now = Math.floor(Date.now() / 1000);
  const age = Math.abs(now - parsed.timestamp);
  if (age > MAX_AGE_SECONDS) {
    return { error: "Signature expired", status: 401 };
  }

  const expected = computeSignature(secret, parsed.timestamp, requestPath);

  const sigBuf = Buffer.from(parsed.signature, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");

  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return { error: "Invalid signature", status: 401 };
  }

  return null; // Valid
}

function verifyBearerToken(
  authHeader: string,
  secret: string,
): { error: string; status: number } | null {
  const expected = `Bearer ${secret}`;

  if (authHeader.length !== expected.length) {
    return { error: "Unauthorized", status: 401 };
  }

  const isValid = timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));

  if (!isValid) {
    return { error: "Unauthorized", status: 401 };
  }

  return null; // Valid
}

export { SIGNATURE_HEADER, MAX_AGE_SECONDS };
