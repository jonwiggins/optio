/**
 * A random URL-safe slug from the browser's CSPRNG.
 *
 * For the default path of a generic webhook trigger (`/api/hooks/<path>`):
 * the path is all that stands between the internet and a trigger with no
 * shared secret, so it must not come from `Math.random()`, whose output is
 * predictable from a few samples. 32 letters a byte each (`& 31`, no modulo
 * bias); 16 of them are 80 bits.
 */
export function randomSlug(length = 16): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b & 31];
  return out;
}
