/**
 * Postgres cannot store a NUL: a U+0000 in a `text` column fails the insert
 * with 22021 ("invalid byte sequence for encoding UTF8: 0x00"), and one
 * inside any string of a `jsonb` value with 22P05 ("unsupported Unicode
 * escape sequence"). Agent output carries them now and then (a binary file
 * echoed, a tool's raw bytes), and one such line used to fail the whole
 * run: the insert threw, the attach loop replayed the same line on every
 * re-attach, and the third failure failed the task. Every text sink that
 * stores agent output passes through here first; the NUL becomes U+FFFD,
 * the replacement character, so the line still reads as what it was.
 */

const NUL = "\u0000";
const EVERY_NUL = /\u0000/g;
const REPLACEMENT = "�";

/** `s` with every NUL replaced by U+FFFD; the same string when it has none. */
export function stripNul(s: string): string {
  return s.includes(NUL) ? s.replace(EVERY_NUL, REPLACEMENT) : s;
}

/**
 * `value` with `stripNul` applied to every string in it, however deep:
 * strings, arrays, and plain objects are walked; anything else (numbers,
 * booleans, null, a Date) is returned as is. A value without a NUL anywhere
 * comes back as the same reference — the common case costs one pass.
 */
export function sanitizeJson<T>(value: T): T {
  if (typeof value === "string") return stripNul(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const clean = sanitizeJson(item);
      if (clean !== item) changed = true;
      return clean;
    });
    return (changed ? out : value) as T;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const cleanKey = stripNul(key);
      const clean = sanitizeJson(item);
      if (clean !== item || cleanKey !== key) changed = true;
      out[cleanKey] = clean;
    }
    return (changed ? out : value) as T;
  }
  return value;
}
