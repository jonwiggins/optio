/**
 * A boolean environment variable: `true`, `1` or `yes` (trimmed, any case)
 * is true, anything else false, unset or blank undefined. The one rule for
 * every on/off switch the sign-in path reads (`sign-in-env.ts`,
 * `OPTIO_LDAP_REQUIRE_TLS`).
 */
export function envBool(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  return raw === "true" || raw === "1" || raw === "yes";
}
