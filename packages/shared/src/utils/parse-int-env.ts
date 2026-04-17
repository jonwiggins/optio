/**
 * Safely parse an integer environment variable.
 *
 * Treats empty / whitespace-only strings the same as `undefined` —
 * both fall back to `defaultValue`.  This avoids the common pitfall where
 * `parseInt(process.env.X ?? "default", 10)` still receives `""` (falsy but
 * not nullish) when a Helm template renders a missing value as empty string.
 */
export function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  return raw && raw.trim() !== "" ? parseInt(raw, 10) : defaultValue;
}
