/**
 * Assert that the runtime OpenSSL version is >= 3.5.0.
 *
 * Node 22+ bundles OpenSSL 3.5.x which negotiates hybrid post-quantum
 * X25519MLKEM768 key agreement by default in TLS 1.3 handshakes.
 * Refusing to start on older versions ensures all outbound fetch() calls
 * (GitHub, Anthropic, Slack, etc.) benefit from PQ key agreement when
 * the upstream supports it.
 */
export function assertMinOpenSSL(version: string): void {
  const [maj, min] = version.split(".").map(Number);
  if (maj < 3 || (maj === 3 && min < 5)) {
    throw new Error(
      `OpenSSL ${version} is too old for post-quantum TLS. Upgrade to Node 22+ with OpenSSL 3.5+.`,
    );
  }
}
