import { normalizeGatewayBaseUrl } from "@optio/shared";
import type { ModelProviderRow } from "./model-provider-service.js";

/**
 * The consent a gateway token is stored with: the one gateway it was given
 * for and the exact URLs it may be sent to (the gateway's base URL and the
 * URL its management reads use). Every reader checks it
 * (`hasGatewayTokenConsent`), so a token never follows a later change of
 * the gateway's URL: after one, the person (or an admin, for the
 * organization's) enters it again.
 */
export interface GatewayTokenConsent {
  providerId: string;
  baseUrl: string;
  syncUrl: string;
}

export function gatewayTokenConsent(
  row: Pick<ModelProviderRow, "id" | "baseUrl" | "syncUrl">,
): GatewayTokenConsent {
  const baseUrl = normalizeGatewayBaseUrl(row.baseUrl ?? "");
  return {
    providerId: row.id,
    baseUrl,
    syncUrl: row.syncUrl ? normalizeGatewayBaseUrl(row.syncUrl) : baseUrl,
  };
}

/** Whether `consent` was given for this gateway at its current URLs. */
export function hasGatewayTokenConsent(
  consent: unknown,
  row: Pick<ModelProviderRow, "id" | "baseUrl" | "syncUrl">,
): boolean {
  if (!consent || typeof consent !== "object") return false;
  const c = consent as Partial<GatewayTokenConsent>;
  if (!row.baseUrl) return false;
  const expected = gatewayTokenConsent(row);
  return (
    c.providerId === expected.providerId &&
    c.baseUrl === expected.baseUrl &&
    c.syncUrl === expected.syncUrl
  );
}

/**
 * The consent shape an earlier build of this feature stored
 * (`{ providerId, origins }`, the origins of the base and sync URLs):
 * whether it still matches the gateway, so `migrateLegacyGatewayTokens` can
 * carry the token over with a consent in today's shape.
 */
export function legacyConsentMatches(
  consent: unknown,
  row: Pick<ModelProviderRow, "id" | "baseUrl" | "syncUrl">,
): boolean {
  if (!consent || typeof consent !== "object") return false;
  const c = consent as { providerId?: unknown; origins?: unknown };
  if (c.providerId !== row.id || !Array.isArray(c.origins)) return false;
  try {
    const expected = [
      ...new Set([row.baseUrl, row.syncUrl || row.baseUrl].map((url) => new URL(url || "").origin)),
    ].sort();
    const given = [...(c.origins as unknown[])].map(String).sort();
    return given.length === expected.length && given.every((o, i) => o === expected[i]);
  } catch {
    return false;
  }
}
