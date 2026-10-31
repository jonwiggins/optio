/**
 * Credential health (docs/credential-health.md): every token Optio holds
 * that a person can renew, as a `CredentialRef`: what it is, whose, where
 * its owner fixes it, and how to check it.
 *
 *   gateway  per model gateway: its shared token (`tokenSource: stored`),
 *            the organization's token, and each person's (pasted or made
 *            by Optio). Each is read only through the gateway's own
 *            consent-checked reader, for the gateway it was given for: a
 *            token is never paired with another gateway, and one whose
 *            consent no longer matches (the gateway moved) is not sent.
 *   GitLab   GITLAB_TOKEN and GITLAB_TOKEN_<HOST> at the organization's
 *            (global) and each person's scope, and a person's
 *            GITLAB_USER_ACCESS_TOKEN; sent only to GitLab hosts a
 *            deployment admin named (gitlab-hosts.ts).
 *
 * Keys name the credential, not its value (`gateway:<id>:user:<userId>`,
 * `gitlab:<name>:org:<ws>`), so a replaced token keeps its row.
 */
import { and, eq, inArray, like, or } from "drizzle-orm";
import { currentFeatures, gatewayTokenSecretName, modelGatewayTypeInfo } from "@optio/shared";
import { db } from "../../db/client.js";
import { modelProviders, secrets } from "../../db/schema.js";
import { organizationGatewayToken, personalGatewayToken } from "../model-gateway-service.js";
import { storedGatewayToken, type ModelProviderRow } from "../model-provider-service.js";
import { retrieveSecretById, retrieveSecretWithFallback } from "../secret-service.js";
import { gitLabTokenNameForHost } from "../git-token-service.js";
import { checkGatewayToken, checkGitLabToken } from "./checks.js";
import { gitlabHostsFor, namedGitLabHosts, normalizeGitLabHost } from "./gitlab-hosts.js";
import type { CheckOutcome } from "./outcome.js";

export type CredentialKind = "gateway" | "gitlab";
export type CredentialScope = "person" | "organization";

export interface CredentialRef {
  key: string;
  kind: CredentialKind;
  /** What it is ("Gateway token · Corp LiteLLM", "GitLab token"). */
  label: string;
  scope: CredentialScope;
  workspaceId: string | null;
  /** The person, for `person`. */
  userId: string | null;
  /** Where its owner replaces it. */
  fixAt: string;
  check(now: Date): Promise<CheckOutcome>;
}

/** Whose gateway token: the gateway's shared one, the organization's, or a person's. */
export type GatewayHolder = { kind: "stored" } | { kind: "org" } | { kind: "user"; userId: string };

export function gatewayKey(providerId: string, holder: GatewayHolder): string {
  if (holder.kind === "user") return `gateway:${providerId}:user:${holder.userId}`;
  return `gateway:${providerId}:${holder.kind}`;
}

export function gatewayLabel(row: Pick<ModelProviderRow, "name" | "gatewayType">): string {
  return `Gateway token · ${row.name} (${modelGatewayTypeInfo(row.gatewayType).label})`;
}

export function gatewayFixAt(holder: GatewayHolder): string {
  return holder.kind === "stored" ? "Settings → Model gateway" : "Settings → My tokens";
}

const missing = (reason: string): CheckOutcome => ({
  status: "unknown",
  reason,
  expiresAt: null,
  details: {},
});

/** The ref a gateway token is checked and recorded as. */
export function gatewayRef(
  row: ModelProviderRow,
  holder: GatewayHolder,
  token: () => Promise<string | null>,
): CredentialRef {
  return {
    key: gatewayKey(row.id, holder),
    kind: "gateway",
    label: gatewayLabel(row),
    scope: holder.kind === "user" ? "person" : "organization",
    workspaceId: row.workspaceId ?? null,
    userId: holder.kind === "user" ? holder.userId : null,
    fixAt: gatewayFixAt(holder),
    async check(now) {
      // Through the consent: a token given for another URL reads as none.
      const value = await token().catch(() => null);
      if (!value) return missing("No token Optio may send to this gateway");
      return checkGatewayToken(row, value, now);
    },
  };
}

/** Every gateway's tokens, each only with its own gateway. */
async function gatewayRefs(filter?: { userId?: string }): Promise<CredentialRef[]> {
  const rows = await db.select().from(modelProviders).where(eq(modelProviders.kind, "gateway"));
  const refs: CredentialRef[] = [];
  for (const row of rows) {
    if (row.tokenSource === "stored") {
      if (!filter?.userId && storedGatewayToken(row)) {
        refs.push(gatewayRef(row, { kind: "stored" }, async () => storedGatewayToken(row)));
      }
      continue;
    }
    // The rows that hold a token for exactly this gateway (`gateway:<id>`).
    const holders = await db
      .select({ scope: secrets.scope, userId: secrets.userId })
      .from(secrets)
      .where(
        and(
          eq(secrets.name, gatewayTokenSecretName(row.id)),
          filter?.userId
            ? and(eq(secrets.scope, "user"), eq(secrets.userId, filter.userId))
            : undefined,
        ),
      );
    for (const h of holders) {
      if (h.scope === "user" && h.userId) {
        const userId = h.userId;
        refs.push(
          gatewayRef(row, { kind: "user", userId }, () => personalGatewayToken(row, userId)),
        );
      } else if (h.scope !== "user" && !filter?.userId) {
        refs.push(gatewayRef(row, { kind: "org" }, () => organizationGatewayToken(row)));
      }
    }
  }
  // One ref per key (an organization token is one, whatever rows hold it).
  return [...new Map(refs.map((r) => [r.key, r])).values()];
}

// ── GitLab ───────────────────────────────────────────────────────────────────

/** What a deployment admin named as GitLab: the setup wizard's GITLAB_HOST, then GITLAB_HOSTS. */
async function namedHosts(workspaceId: string | null): Promise<string[]> {
  const wizard = await retrieveSecretWithFallback("GITLAB_HOST", "global", workspaceId).catch(
    () => "",
  );
  const env = (process.env.GITLAB_HOSTS ?? process.env.OPTIO_GITLAB_HOSTS ?? "").split(",");
  // gitlab.com is never asked where agents reach models through a gateway only.
  return namedGitLabHosts([wizard, ...env], currentFeatures().modelAccess !== "gateway");
}

/**
 * The hosts one GitLab secret goes to: a host-specific one
 * (`GITLAB_TOKEN_<HOST>`) only to a named host whose name it carries; a
 * plain one to the named hosts (gitlab.com when none is named and it may be
 * asked).
 */
export function gitlabHostsForSecret(name: string, named: string[], allowGitLabCom: boolean) {
  if (name.startsWith("GITLAB_TOKEN_")) {
    return named.filter((h) => gitLabTokenNameForHost(h) === name);
  }
  return gitlabHostsFor({ named, allowGitLabCom });
}

const GITLAB_NAMES = or(
  eq(secrets.name, "GITLAB_TOKEN"),
  like(secrets.name, "GITLAB\\_TOKEN\\_%"),
  eq(secrets.name, "GITLAB_USER_ACCESS_TOKEN"),
);

async function gitlabRefs(filter?: { userId?: string }): Promise<CredentialRef[]> {
  const rows = await db
    .select({
      id: secrets.id,
      name: secrets.name,
      scope: secrets.scope,
      workspaceId: secrets.workspaceId,
      userId: secrets.userId,
    })
    .from(secrets)
    .where(
      and(
        GITLAB_NAMES,
        filter?.userId
          ? or(
              and(eq(secrets.scope, "user"), eq(secrets.userId, filter.userId)),
              eq(secrets.scope, `user:${filter.userId}`),
            )
          : or(inArray(secrets.scope, ["global", "user"]), like(secrets.scope, "user:%")),
      ),
    );
  const allowGitLabCom = currentFeatures().modelAccess !== "gateway";
  const refs: CredentialRef[] = [];
  for (const s of rows) {
    // A person's: at user scope, or the older `user:<id>` scope.
    const userId =
      s.scope === "user" ? s.userId : s.scope.startsWith("user:") ? s.scope.slice(5) : null;
    if (s.scope !== "global" && !userId) continue;
    const person = !!userId;
    const id = s.id;
    refs.push({
      key: person
        ? `gitlab:${s.name}:user:${userId}`
        : `gitlab:${s.name}:org:${s.workspaceId ?? "global"}`,
      kind: "gitlab",
      label:
        s.name === "GITLAB_TOKEN" || s.name === "GITLAB_USER_ACCESS_TOKEN"
          ? "GitLab token"
          : `GitLab token · ${s.name.slice("GITLAB_TOKEN_".length).toLowerCase()}`,
      scope: person ? "person" : "organization",
      workspaceId: s.workspaceId ?? null,
      userId,
      fixAt: person ? "Settings → My tokens" : "Settings → Secrets",
      async check(now) {
        const named = await namedHosts(s.workspaceId ?? null);
        const hosts = gitlabHostsForSecret(s.name, named, allowGitLabCom).map(normalizeGitLabHost);
        const value = await retrieveSecretById(id)
          .then((r) => r?.value ?? null)
          .catch(() => null);
        if (!value) return missing("The token can't be read");
        return checkGitLabToken(value, hosts, now);
      },
    });
  }
  return refs;
}

/** Every credential (or one person's own). */
export async function inventory(filter?: { userId?: string }): Promise<CredentialRef[]> {
  const [gateway, gitlab] = await Promise.all([gatewayRefs(filter), gitlabRefs(filter)]);
  return [...gateway, ...gitlab];
}
