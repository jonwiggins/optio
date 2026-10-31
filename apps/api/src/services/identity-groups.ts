import { createHash } from "node:crypto";
import { qualifiedGroupParts } from "@optio/shared";

/** Configuration changes to an authority must invalidate its old group assertions. */
export function groupAuthority(provider: string, settings: unknown): string {
  const s = (settings ?? {}) as Record<string, unknown>;
  const authority = JSON.stringify([
    provider,
    s.issuerUrl,
    s.url,
    s.userBaseDn,
    s.baseUrl,
    s.idpEntityId ?? s.metadataUrl ?? s.metadataXml ?? s.entryPoint,
  ]);
  return `${provider}:${createHash("sha256").update(authority).digest("hex")}`;
}

export function qualifyGroups(provider: string, settings: unknown, groups: string[]): string[] {
  const prefix = `sso:${groupAuthority(provider, settings)}:`;
  return [...new Set(groups.map((name) => name.trim().toLowerCase()).filter(Boolean))].map(
    (name) => prefix + name,
  );
}

export function replaceProviderGroups(
  previous: string[],
  provider: string,
  settings: unknown,
  groups: string[],
): string[] {
  return [
    ...previous.filter((g) => {
      const parsed = qualifiedGroupParts(g);
      return parsed && parsed.provider !== provider;
    }),
    ...qualifyGroups(provider, settings, groups),
  ];
}
