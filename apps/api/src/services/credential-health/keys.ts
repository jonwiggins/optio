/**
 * Credential health (docs/credential-health.md): the keys and labels a
 * credential is recorded under, shared by the worker's inventory and the
 * run pre-flight (which must not pull in every service the inventory
 * reads). A key names the credential, not its value, so a replaced token
 * keeps its row.
 */
import type { ModelProviderRow } from "../model-provider-service.js";

export type CredentialKind = "github" | "gitlab" | "gateway" | "jira" | "remote_workspace";
export type CredentialScope = "organization" | "team" | "person";

export type GatewayHolder =
  | { kind: "stored"; userId: string | null }
  | { kind: "org" }
  | { kind: "team"; teamId: string }
  | { kind: "user"; userId: string };

export function gatewayKey(providerId: string, holder: GatewayHolder): string {
  switch (holder.kind) {
    case "stored":
      return `gateway:${providerId}:stored`;
    case "org":
      return `gateway:${providerId}:org`;
    case "team":
      return `gateway:${providerId}:team:${holder.teamId}`;
    case "user":
      return `gateway:${providerId}:user:${holder.userId}`;
  }
}

export function gatewayLabel(row: Pick<ModelProviderRow, "name" | "tokenSource">): string {
  return row.tokenSource === "stored"
    ? `Gateway token · ${row.name} (shared)`
    : `Gateway token · ${row.name}`;
}

/** Where a gateway token is replaced, by whose it is. */
export function gatewayFixAt(holder: GatewayHolder, teamName: string | null): string {
  switch (holder.kind) {
    case "user":
      return "Settings → My tokens";
    case "team":
      return `Teams → ${teamName ?? "the team"} → Tokens`;
    default:
      return "Settings → Model gateway";
  }
}

/** Whose a gateway token is, in the row's terms. */
export function gatewayScope(holder: GatewayHolder): {
  scope: CredentialScope;
  userId: string | null;
  teamId: string | null;
} {
  if (holder.kind === "team") return { scope: "team", userId: null, teamId: holder.teamId };
  if (holder.kind === "user") return { scope: "person", userId: holder.userId, teamId: null };
  if (holder.kind === "stored" && holder.userId) {
    return { scope: "person", userId: holder.userId, teamId: null };
  }
  return { scope: "organization", userId: null, teamId: null };
}
