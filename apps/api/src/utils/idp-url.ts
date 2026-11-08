import { envBool } from "./env-bool.js";

/** Identity-provider credentials require TLS; only literal local development may use HTTP. */
export function secureIdentityProviderUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return (
      url.protocol === "https:" ||
      (process.env.NODE_ENV !== "production" &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}
export const insecureIdentityProviderTlsAllowed = () =>
  process.env.OPTIO_IDP_ALLOW_INSECURE_TLS === "true";

/**
 * `OPTIO_LDAP_REQUIRE_TLS=true` (or `1` / `yes`, like every other sign-in
 * switch — `envBool`): LDAP sign-in must be encrypted, so the
 * directory's passwords never cross the network in the clear. A plain
 * `ldap://` URL without STARTTLS is refused when saved, tested and used.
 */
export const ldapTlsRequired = () => envBool("OPTIO_LDAP_REQUIRE_TLS") === true;

export const LDAP_TLS_REQUIRED_MESSAGE =
  "This deployment requires TLS for LDAP (OPTIO_LDAP_REQUIRE_TLS=true): use an ldaps:// URL or turn on STARTTLS";

/** Whether the deployment's policy refuses this LDAP transport (plain ldap:// without STARTTLS). */
export function ldapPlainTransportRefused(settings: { url: string; startTls?: boolean }): boolean {
  return ldapTlsRequired() && /^ldap:\/\//i.test(settings.url.trim()) && !settings.startTls;
}
