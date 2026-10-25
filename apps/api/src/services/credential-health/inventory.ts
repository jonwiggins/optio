/**
 * Credential health (docs/credential-health.md): every credential Optio
 * holds that a person can renew, as a `CredentialRef` — what it is, whose,
 * where its owner fixes it, and how to check it.
 *
 *   GitHub   GITHUB_TOKEN at global (the organization's), team and user
 *            scope, and the GITHUB_TOKEN environment variable (a GitHub App's
 *            tokens renew themselves and aren't listed)
 *   GitLab   GITLAB_TOKEN at global (the organization's), team and user
 *            scope, a personal GITLAB_USER_ACCESS_TOKEN (the older name), and
 *            the GITLAB_TOKEN environment variable
 *   gateway  per model gateway: its shared token (`stored`), or the
 *            organization's, each team's and each member's token
 *   Jira     each enabled Jira ticket provider
 *   remote workspaces   each enabled remote-workspace connection (Coder,
 *            GitHub Codespaces, Daytona, E2B)
 *
 * A GitLab token is checked only against the hosts a deployment admin
 * named, and of those the ones its owner's work uses (gitlab-hosts.ts); a
 * GitHub token against the GitHub of its owner's repos (github.com, or a
 * GitHub Enterprise Server), github.com when they have none under the full
 * profile.
 *
 * Keys name the credential, not its value (`gitlab:user:<id>`,
 * `gateway:<provider>:team:<id>`), so a replaced token keeps its row; the
 * run pre-flight (gateway-preflight.ts) writes under the same keys.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { REMOTE_WORKSPACE_PROVIDER_INFO, currentFeatures, parseRepoUrl } from "@optio/shared";
import { db } from "../../db/client.js";
import {
  modelProviders,
  remoteWorkspaceConnections,
  repos,
  secrets,
  teams,
  ticketProviders,
  workspaceMembers,
} from "../../db/schema.js";
import { tokenSecretNameOf } from "../model-gateway-service.js";
import { storedGatewayToken, type ModelProviderRow } from "../model-provider-service.js";
import { retrieveSecret, retrieveSecretById } from "../secret-service.js";
import {
  checkRemoteWorkspaceConnection,
  checkGatewayToken,
  checkGitHubToken,
  checkGitLabToken,
  checkJiraProvider,
} from "./checks.js";
import { gitlabHostsFor, namedGitLabHosts } from "./gitlab-hosts.js";
import type { CheckOutcome } from "./outcome.js";
import {
  gatewayFixAt,
  gatewayKey,
  gatewayLabel,
  gatewayScope,
  type CredentialKind,
  type CredentialScope,
  type GatewayHolder,
} from "./keys.js";

export type { CredentialKind, CredentialScope, GatewayHolder } from "./keys.js";

export interface CredentialRef {
  key: string;
  kind: CredentialKind;
  /** What it is, for the page and the notice ("GitLab token", "Gateway token · LiteLLM"). */
  label: string;
  scope: CredentialScope;
  workspaceId: string | null;
  /** The person, for `person`. */
  userId: string | null;
  /** The team, for `team`. */
  teamId: string | null;
  /** Where its owner replaces it ("Settings → My tokens", "Teams → Platform → Tokens"). */
  fixAt: string;
  check(now: Date): Promise<CheckOutcome>;
}

/** The ref a gateway token is checked and recorded as. */
export function gatewayRef(
  row: ModelProviderRow,
  holder: GatewayHolder,
  teamName: string | null,
  workspaceId: string | null,
  token: () => Promise<string | null>,
): CredentialRef {
  return {
    key: gatewayKey(row.id, holder),
    kind: "gateway",
    label: gatewayLabel(row),
    ...gatewayScope(holder),
    workspaceId,
    fixAt: gatewayFixAt(holder, teamName),
    async check(now) {
      const value = await token();
      if (!value) return missing("The token is gone");
      return checkGatewayToken(row, value, now);
    },
  };
}

const missing = (reason: string): CheckOutcome => ({
  status: "unknown",
  reason,
  expiresAt: null,
  details: {},
});

async function secretValue(id: string): Promise<string | null> {
  try {
    return (await retrieveSecretById(id))?.value ?? null;
  } catch {
    return null;
  }
}

async function teamNames(): Promise<Map<string, { name: string; workspaceId: string }>> {
  const rows = await db
    .select({ id: teams.id, name: teams.name, workspaceId: teams.workspaceId })
    .from(teams);
  return new Map(rows.map((t) => [t.id, { name: t.name, workspaceId: t.workspaceId }]));
}

// ── GitHub ───────────────────────────────────────────────────────────────────

const GITHUB_DOT_COM_API = "https://api.github.com";

/** The GitHub APIs of the GitHub repos, by workspace. */
async function githubRepoApis(): Promise<Map<string, Set<string>>> {
  const rows = await db
    .select({ workspaceId: repos.workspaceId, repoUrl: repos.repoUrl })
    .from(repos)
    .where(eq(repos.gitPlatform, "github"));
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const ri = parseRepoUrl(r.repoUrl, "github");
    if (!ri || !r.workspaceId) continue;
    const set = out.get(r.workspaceId) ?? new Set<string>();
    set.add(ri.apiBaseUrl);
    out.set(r.workspaceId, set);
  }
  return out;
}

const GITHUB_ORG_FIX = "Settings → Secrets (GITHUB_TOKEN, global)";

async function githubCredentials(
  names: Map<string, { name: string; workspaceId: string }>,
): Promise<CredentialRef[]> {
  const rows = await db
    .select({
      id: secrets.id,
      scope: secrets.scope,
      userId: secrets.userId,
      teamId: secrets.teamId,
      workspaceId: secrets.workspaceId,
    })
    .from(secrets)
    .where(eq(secrets.name, "GITHUB_TOKEN"));
  const env = process.env.GITHUB_TOKEN?.trim() || null;
  if (!rows.length && !env) return [];
  const full = currentFeatures().modelAccess !== "gateway";
  const repoApis = await githubRepoApis();
  const memberOf = await workspacesOf([
    ...new Set(rows.filter((r) => r.scope === "user" && r.userId).map((r) => r.userId as string)),
  ]);
  const apisIn = (workspaceIds: Iterable<string | null> | "all"): string[] => {
    const sets =
      workspaceIds === "all"
        ? [...repoApis.values()]
        : [...workspaceIds].map((id) => repoApis.get(id ?? "") ?? new Set<string>());
    const apis = [...new Set(sets.flatMap((set) => [...set]))].sort((a, b) =>
      a === GITHUB_DOT_COM_API ? -1 : b === GITHUB_DOT_COM_API ? 1 : a.localeCompare(b),
    );
    return apis.length ? apis : full ? [GITHUB_DOT_COM_API] : [];
  };
  const github = (
    base: Omit<CredentialRef, "kind" | "check" | "label">,
    token: () => Promise<string | null>,
    apiBaseUrls: string[],
    label = "GitHub token",
  ): CredentialRef => ({
    ...base,
    kind: "github",
    label,
    async check(now) {
      const value = await token();
      if (!value) return missing("The token is gone");
      return checkGitHubToken({ token: value, apiBaseUrls }, now);
    },
  });

  const refs: CredentialRef[] = [];
  const org = rows.find((r) => r.scope === "global");
  for (const r of rows) {
    if (r.scope === "global") {
      refs.push(
        github(
          {
            key: "github:org",
            scope: "organization",
            workspaceId: null,
            userId: null,
            teamId: null,
            fixAt: GITHUB_ORG_FIX,
          },
          () => secretValue(r.id),
          apisIn("all"),
        ),
      );
    } else if (r.scope === "user" && r.userId) {
      refs.push(
        github(
          {
            key: `github:user:${r.userId}`,
            scope: "person",
            workspaceId: null,
            userId: r.userId,
            teamId: null,
            fixAt: "Settings → My tokens",
          },
          () => secretValue(r.id),
          apisIn(memberOf.get(r.userId) ?? []),
        ),
      );
    } else if (r.scope === "team" && r.teamId) {
      const team = names.get(r.teamId);
      const workspaceId = team?.workspaceId ?? r.workspaceId;
      refs.push(
        github(
          {
            key: `github:team:${r.teamId}`,
            scope: "team",
            workspaceId,
            userId: null,
            teamId: r.teamId,
            fixAt: `Teams → ${team?.name ?? "the team"} → Tokens`,
          },
          () => secretValue(r.id),
          apisIn([workspaceId]),
        ),
      );
    }
  }
  if (env) {
    refs.push(
      github(
        {
          key: "github:env",
          scope: "organization",
          workspaceId: null,
          userId: null,
          teamId: null,
          fixAt: org
            ? "the deployment's environment (a global GITHUB_TOKEN secret is used before it)"
            : "the deployment's environment, or a global GITHUB_TOKEN secret, which wins",
        },
        async () => env,
        apisIn("all"),
        "GitHub token (GITHUB_TOKEN environment variable)",
      ),
    );
  }
  return refs;
}

// ── GitLab ───────────────────────────────────────────────────────────────────

/**
 * The GitLab hosts a deployment admin named: the setup wizard's GITLAB_HOST
 * (a deployment secret), then GITLAB_HOSTS (chart `gitlab.hosts`). Tokens are
 * checked against these only (gitlab-hosts.ts); gitlab.com is never one of
 * them where models are reached through a gateway only.
 */
/** Whether gitlab.com may be asked: not where models are reached through a gateway only. */
function allowGitLabCom(): boolean {
  return currentFeatures().modelAccess !== "gateway";
}

export async function siteGitLabHosts(): Promise<string[]> {
  const saved = await retrieveSecret("GITLAB_HOST", "global").catch(() => null);
  const env = (process.env.GITLAB_HOSTS ?? process.env.OPTIO_GITLAB_HOSTS ?? "").split(",");
  const { refreshGitLabInstances } = await import("../gitlab-instance-service.js");
  const { gitLabInstanceUrls } = await import("@optio/shared");
  await refreshGitLabInstances().catch(() => {});
  return namedGitLabHosts(
    [saved, ...env, ...gitLabInstanceUrls().map((v) => new URL(v).host)],
    allowGitLabCom(),
  );
}

/** The hosts of the GitLab repos, by workspace (any host: gitlab-hosts.ts filters them). */
async function gitlabRepoHosts(): Promise<Map<string, Set<string>>> {
  const rows = await db
    .select({ workspaceId: repos.workspaceId, repoUrl: repos.repoUrl })
    .from(repos)
    .where(eq(repos.gitPlatform, "gitlab"));
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const host = parseRepoUrl(r.repoUrl)?.host;
    if (!host || !r.workspaceId) continue;
    const set = out.get(r.workspaceId) ?? new Set<string>();
    set.add(host.toLowerCase());
    out.set(r.workspaceId, set);
  }
  return out;
}

/** The workspaces each of `userIds` is a member of. */
async function workspacesOf(userIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!userIds.length) return out;
  const rows = await db
    .select({ userId: workspaceMembers.userId, workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(inArray(workspaceMembers.userId, userIds));
  for (const r of rows) out.set(r.userId, [...(out.get(r.userId) ?? []), r.workspaceId]);
  return out;
}

/** The GitLab projects Optio keeps a webhook on (`repos.webhook_id`), by host. */
async function webhookProjects(): Promise<Array<{ host: string; path: string }>> {
  const rows = await db
    .select({ repoUrl: repos.repoUrl })
    .from(repos)
    .where(and(eq(repos.gitPlatform, "gitlab"), isNotNull(repos.webhookId)));
  const out: Array<{ host: string; path: string }> = [];
  for (const r of rows) {
    const ri = parseRepoUrl(r.repoUrl);
    if (!ri) continue;
    const item = { host: ri.host.toLowerCase(), path: `${ri.owner}/${ri.repo}` };
    if (!out.some((o) => o.host === item.host && o.path === item.path)) out.push(item);
  }
  return out;
}

const GITLAB_ORG_FIX = "Settings → Integrations → Deployment secrets (GITLAB_TOKEN)";

async function gitlabCredentials(
  names: Map<string, { name: string; workspaceId: string }>,
): Promise<CredentialRef[]> {
  const rows = await db
    .select({
      id: secrets.id,
      name: secrets.name,
      scope: secrets.scope,
      userId: secrets.userId,
      teamId: secrets.teamId,
      workspaceId: secrets.workspaceId,
    })
    .from(secrets)
    .where(inArray(secrets.name, ["GITLAB_TOKEN", "GITLAB_USER_ACCESS_TOKEN"]));
  const env = process.env.GITLAB_TOKEN?.trim() || null;
  if (!rows.length && !env) return [];
  const named = await siteGitLabHosts();
  const allowPublic = allowGitLabCom();
  const projects = await webhookProjects();
  const repoHosts = await gitlabRepoHosts();
  const legacyUser = (r: (typeof rows)[number]) =>
    r.userId ?? r.scope.match(/^user:([0-9a-f-]{36})$/i)?.[1] ?? null;
  const memberOf = await workspacesOf([
    ...new Set(
      rows
        .filter((r) => r.scope === "user" || r.name === "GITLAB_USER_ACCESS_TOKEN")
        .map(legacyUser)
        .filter((id): id is string => !!id),
    ),
  ]);
  // Where each token is used: the repos of its owner's workspaces (all of
  // them for the organization's); only the named ones of those are asked.
  const hostsIn = (workspaceIds: Iterable<string | null> | "all"): string[] =>
    gitlabHostsFor({
      named,
      allowGitLabCom: allowPublic,
      ownerRepoHosts:
        workspaceIds === "all"
          ? [...repoHosts.values()].flatMap((set) => [...set])
          : [...workspaceIds].flatMap((id) => [...(repoHosts.get(id ?? "") ?? [])]),
    });
  const refs: CredentialRef[] = [];
  const gitlab = (
    base: Omit<CredentialRef, "kind" | "check">,
    token: () => Promise<string | null>,
    hosts: string[],
    manageWebhooks = false,
  ): CredentialRef => ({
    ...base,
    kind: "gitlab",
    async check(now) {
      const value = await token();
      if (!value) return missing("The token is gone");
      return checkGitLabToken(
        { token: value, hosts, ...(manageWebhooks ? { webhookProjects: projects } : {}) },
        now,
      );
    },
  });

  const org = rows.find((r) => r.name === "GITLAB_TOKEN" && r.scope === "global");
  const personal = new Set(
    rows.filter((r) => r.name === "GITLAB_TOKEN" && r.scope === "user").map((r) => r.userId),
  );
  for (const r of rows) {
    if (r.name === "GITLAB_TOKEN" && r.scope === "global") {
      // The token every run without a team or personal one uses, and the
      // one Optio manages webhooks with.
      refs.push(
        gitlab(
          {
            key: "gitlab:org",
            label: "GitLab token",
            scope: "organization",
            workspaceId: null,
            userId: null,
            teamId: null,
            fixAt: GITLAB_ORG_FIX,
          },
          () => secretValue(r.id),
          hostsIn("all"),
          true,
        ),
      );
    } else if (r.name === "GITLAB_TOKEN" && r.scope === "user" && r.userId) {
      refs.push(
        gitlab(
          {
            key: `gitlab:user:${r.userId}`,
            label: "GitLab token",
            scope: "person",
            workspaceId: null,
            userId: r.userId,
            teamId: null,
            fixAt: "Settings → My tokens",
          },
          () => secretValue(r.id),
          hostsIn(memberOf.get(r.userId) ?? []),
        ),
      );
    } else if (r.name === "GITLAB_TOKEN" && r.scope === "team" && r.teamId) {
      const team = names.get(r.teamId);
      const workspaceId = team?.workspaceId ?? r.workspaceId;
      refs.push(
        gitlab(
          {
            key: `gitlab:team:${r.teamId}`,
            label: "GitLab token",
            scope: "team",
            workspaceId,
            userId: null,
            teamId: r.teamId,
            fixAt: `Teams → ${team?.name ?? "the team"} → Tokens`,
          },
          () => secretValue(r.id),
          hostsIn([workspaceId]),
        ),
      );
    } else if (r.name === "GITLAB_USER_ACCESS_TOKEN") {
      // The older personal name (`user:<id>` scope); a GITLAB_TOKEN of the
      // same person wins over it, so only one without is checked.
      const userId = legacyUser(r);
      if (!userId || personal.has(userId)) continue;
      refs.push(
        gitlab(
          {
            key: `gitlab:user:${userId}`,
            label: "GitLab token (GITLAB_USER_ACCESS_TOKEN)",
            scope: "person",
            workspaceId: null,
            userId,
            teamId: null,
            fixAt: "Settings → My tokens",
          },
          () => secretValue(r.id),
          hostsIn(memberOf.get(userId) ?? []),
        ),
      );
    }
  }
  if (env) {
    refs.push(
      gitlab(
        {
          key: "gitlab:env",
          label: "GitLab token (GITLAB_TOKEN environment variable)",
          scope: "organization",
          workspaceId: null,
          userId: null,
          teamId: null,
          fixAt: org
            ? "the deployment's environment (a GITLAB_TOKEN deployment secret is used before it)"
            : "the deployment's environment (Helm existingSecrets.GITLAB_TOKEN), or a GITLAB_TOKEN deployment secret, which wins",
        },
        async () => env,
        hostsIn("all"),
        // Webhooks use it only when there is no GITLAB_TOKEN secret.
        !org,
      ),
    );
  }
  return refs;
}

// ── The model gateway ────────────────────────────────────────────────────────

async function gatewayCredentials(
  names: Map<string, { name: string; workspaceId: string }>,
): Promise<CredentialRef[]> {
  const gateways = await db.select().from(modelProviders).where(eq(modelProviders.kind, "gateway"));
  const refs: CredentialRef[] = [];
  for (const row of gateways) {
    if (row.tokenSource === "stored") {
      if (!storedGatewayToken(row)) continue;
      refs.push(
        gatewayRef(
          row,
          { kind: "stored", userId: row.ownerUserId },
          null,
          row.workspaceId,
          async () => storedGatewayToken(row),
        ),
      );
      continue;
    }
    const name = tokenSecretNameOf(row);
    const rows = await db
      .select({
        id: secrets.id,
        scope: secrets.scope,
        userId: secrets.userId,
        teamId: secrets.teamId,
      })
      .from(secrets)
      .where(and(eq(secrets.name, name), inArray(secrets.scope, ["global", "team", "user"])));
    // Who may run work through it: a person's own gateway, its owner; the
    // organization's, the workspace's members and teams.
    const members = row.ownerUserId
      ? new Set([row.ownerUserId])
      : row.workspaceId
        ? new Set(
            (
              await db
                .select({ userId: workspaceMembers.userId })
                .from(workspaceMembers)
                .where(eq(workspaceMembers.workspaceId, row.workspaceId))
            ).map((m) => m.userId),
          )
        : null;
    for (const s of rows) {
      const value = () => secretValue(s.id);
      if (s.scope === "global" && !row.ownerUserId) {
        refs.push(gatewayRef(row, { kind: "org" }, null, row.workspaceId, value));
      } else if (s.scope === "team" && s.teamId && !row.ownerUserId) {
        const team = names.get(s.teamId);
        if (!team || (row.workspaceId && team.workspaceId !== row.workspaceId)) continue;
        refs.push(
          gatewayRef(row, { kind: "team", teamId: s.teamId }, team.name, team.workspaceId, value),
        );
      } else if (s.scope === "user" && s.userId && (!members || members.has(s.userId))) {
        refs.push(
          gatewayRef(row, { kind: "user", userId: s.userId }, null, row.workspaceId, value),
        );
      }
    }
  }
  return refs;
}

// ── Jira and remote workspaces ───────────────────────────────────────────────────────────

function ownerScope(row: { ownerUserId: string | null; ownerTeamId: string | null }): {
  scope: CredentialScope;
  userId: string | null;
  teamId: string | null;
} {
  if (row.ownerTeamId) return { scope: "team", userId: null, teamId: row.ownerTeamId };
  if (row.ownerUserId) return { scope: "person", userId: row.ownerUserId, teamId: null };
  return { scope: "organization", userId: null, teamId: null };
}

function hostOf(url: unknown): string {
  try {
    return new URL(String(url)).host;
  } catch {
    return String(url ?? "");
  }
}

async function jiraCredentials(): Promise<CredentialRef[]> {
  const rows = await db
    .select()
    .from(ticketProviders)
    .where(and(eq(ticketProviders.source, "jira"), eq(ticketProviders.enabled, true)));
  return rows.map((row) => ({
    key: `jira:${row.id}`,
    kind: "jira" as const,
    label: `Jira · ${hostOf((row.config as { baseUrl?: unknown })?.baseUrl)}`,
    ...ownerScope(row),
    workspaceId: row.workspaceId,
    fixAt: "Settings → Integrations → Tickets",
    check: () => checkJiraProvider(row),
  }));
}

async function remoteWorkspaceCredentials(): Promise<CredentialRef[]> {
  const rows = await db
    .select()
    .from(remoteWorkspaceConnections)
    .where(eq(remoteWorkspaceConnections.enabled, true));
  return rows.map((row) => ({
    key: `remote_workspace:${row.id}`,
    kind: "remote_workspace" as const,
    label: `${REMOTE_WORKSPACE_PROVIDER_INFO[row.provider]?.label ?? row.provider} · ${row.name}`,
    ...ownerScope(row),
    workspaceId: row.workspaceId,
    fixAt: "Settings → Integrations → Remote workspaces",
    check: (now: Date) => checkRemoteWorkspaceConnection(row, now),
  }));
}

/** Every credential to check, in a stable order (GitHub, GitLab, gateway, Jira, remote workspaces). */
export async function listCredentials(): Promise<CredentialRef[]> {
  const names = await teamNames();
  return [
    ...(await githubCredentials(names)),
    ...(await gitlabCredentials(names)),
    ...(await gatewayCredentials(names)),
    ...(await jiraCredentials()),
    ...(await remoteWorkspaceCredentials()),
  ];
}

/** The credential behind `key` (the Check now button), or null when it is gone. */
export async function credentialByKey(key: string): Promise<CredentialRef | null> {
  const all = await listCredentials();
  return all.find((r) => r.key === key) ?? null;
}
