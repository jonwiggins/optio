/**
 * The words every connection row uses — in the "Connected to" picker, the
 * Connections page, the repo card — so a connection reads the same
 * everywhere: a logo, a name, and one subtext line saying whose it is and
 * what it is made of: "Private · tools + credentials · Linear".
 */
import type { ConnectionPart, WorkEnvironmentEntry, WorkEnvironmentEntryKind } from "@optio/shared";

/** The parts in the order the subtext names them. */
const PART_ORDER: ConnectionPart[] = ["tools", "credentials", "env", "note"];
const PART_LABEL: Record<ConnectionPart, string> = {
  tools: "tools",
  credentials: "credentials",
  env: "shell env",
  note: "note",
};

/** "tools + credentials", "credentials only", "nothing yet". */
export function partsLabel(parts: readonly ConnectionPart[]): string {
  const named = PART_ORDER.filter((p) => parts.includes(p)).map((p) => PART_LABEL[p]);
  if (named.length === 0) return "nothing yet";
  if (named.length === 1) return `${named[0]} only`;
  return named.join(" + ");
}

/** What the row is: the provider's name, or the bare kind. */
export function kindLabel(entry: Pick<WorkEnvironmentEntry, "kind" | "providerName">): string {
  if (entry.providerName) return entry.providerName;
  return entry.kind === "secret"
    ? "Secret"
    : entry.kind === "mcpServer"
      ? "MCP server"
      : "Connection";
}

export type EntryOwnerScope = "organization" | "private" | "others";

/**
 * Whose a row is, from the viewer's side. With auth disabled (no viewer id)
 * every private row counts as the viewer's own.
 */
export function entryOwnerScope(
  entry: Pick<WorkEnvironmentEntry, "ownerUserId">,
  viewerId: string | null,
): EntryOwnerScope {
  if (!entry.ownerUserId) return "organization";
  if (viewerId === null || entry.ownerUserId === viewerId) return "private";
  return "others";
}

/** "Organization", "Private", or "Sam's". */
export function ownerWord(
  entry: Pick<WorkEnvironmentEntry, "ownerUserId" | "ownerName">,
  viewerId: string | null,
): string {
  const scope = entryOwnerScope(entry, viewerId);
  if (scope === "organization") return "Organization";
  if (scope === "private") return "Private";
  return `${entry.ownerName ?? "Someone"}'s`;
}

/** The one subtext line: "Private · tools + credentials · Linear". */
export function entrySubtext(entry: WorkEnvironmentEntry, viewerId: string | null): string {
  return [ownerWord(entry, viewerId), partsLabel(entry.parts), kindLabel(entry)].join(" · ");
}

/**
 * Why a row can't be picked for this work, or null when it can: someone
 * else's private row never; the viewer's own only for work they own.
 */
export function entryPickReason(
  entry: WorkEnvironmentEntry,
  viewerId: string | null,
  workOwner: "workspace" | "me",
): string | null {
  const scope = entryOwnerScope(entry, viewerId);
  if (scope === "others") return `Only ${entry.ownerName ?? "its owner"}'s work can use this`;
  if (scope === "private" && workOwner === "workspace") {
    return "Switch the owner to Private to use your own connections";
  }
  if (!entry.enabled) return "Disabled — enable it under Library → Connections";
  return null;
}

/** Which setting a toggle of this kind changes. */
export const KIND_SETTING: Record<
  WorkEnvironmentEntryKind,
  "connections" | "mcpServers" | "podSecrets"
> = {
  connection: "connections",
  mcpServer: "mcpServers",
  secret: "podSecrets",
};

/** A short list of names for a summary line: "Jon's AWS, Acme Linear, +2". */
export function namesSummary(names: readonly string[], max = 3): string {
  if (names.length === 0) return "";
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")}, +${rest}` : shown.join(", ");
}
