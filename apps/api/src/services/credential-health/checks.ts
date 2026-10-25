import { gitLabFetch } from "../gitlab-instance-runtime.js";
import { gitLabInstanceForHost } from "@optio/shared";
/**
 * Credential health (docs/credential-health.md): asking each service about
 * one token. Every function answers with a `CheckOutcome` and never throws;
 * a service that can't be reached is `unknown`, not `error`.
 *
 * TLS: GitLab and GitHub are reached with Node's fetch, which trusts the chart's
 * `caBundle` (`NODE_EXTRA_CA_CERTS`), as `git-platform/gitlab.ts` does; the
 * gateway through `model-gateway-service.ts` (plus `OPTIO_GATEWAY_CA_PEM`);
 * Jira and the remote-workspace providers through their connections' own CA fields and the outbound
 * guard. No call leaves the deployment's own services.
 */
import { getTicketProvider } from "@optio/ticket-providers";
import { REMOTE_WORKSPACE_PROVIDER_INFO, type TicketSource } from "@optio/shared";
import type { remoteWorkspaceConnections, ticketProviders } from "../../db/schema.js";
import { RemoteWorkspaceError, clientFor } from "../remote-workspace-service.js";
import { describeFailure, gatewayKeyInfoRaw, gatewayTest } from "../model-gateway-service.js";
import type { ModelProviderRow } from "../model-provider-service.js";
import { resolveProviderConfig } from "../ticket-sync-service.js";
import {
  type CheckOutcome,
  expiryVerdict,
  gitlabSelfOutcome,
  type GitLabTokenSelf,
  keyInfoOutcome,
  maintainerShortfall,
  reasons,
  worse,
} from "./outcome.js";

const REQUEST_TIMEOUT_MS = 15_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let fetchOverride: Fetch | null = null;

/** Tests: route the GitLab calls through a stand-in (null restores Node's fetch). */
export function setCredentialHealthFetchForTests(f: Fetch | null): void {
  fetchOverride = f;
}

function httpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return (fetchOverride ?? gitLabFetch)(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

const TLS_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "CERT_HAS_EXPIRED",
]);

/** Why a request didn't get an answer, in a sentence; a private CA says where to put it. */
export function describeNetworkError(err: unknown): string {
  const e = err as { message?: string; name?: string; cause?: { code?: string; message?: string } };
  const code = e?.cause?.code;
  if (code && TLS_CODES.has(code)) {
    return `its certificate isn't trusted (${code}): put the deployment's CA in the chart's caBundle`;
  }
  if (e?.name === "TimeoutError") return `no answer in ${REQUEST_TIMEOUT_MS / 1000} s`;
  const cause = e?.cause?.message ?? code;
  const message = e?.message ?? String(err);
  return cause && cause !== message ? `${message} (${cause})` : message;
}

const unknown = (reason: string, details: Record<string, unknown> = {}): CheckOutcome => ({
  status: "unknown",
  reason,
  expiresAt: null,
  details,
});

// ── GitLab ───────────────────────────────────────────────────────────────────

export interface GitLabCheckInput {
  token: string;
  /**
   * The hosts this token may be sent to (gitlab-hosts.ts: named by a
   * deployment admin, and used by the owner's work), tried in order; the
   * first that accepts the token is its own.
   */
  hosts: string[];
  /**
   * The projects Optio keeps webhooks on (the organization's token manages
   * them): the token's user must be a Maintainer there.
   */
  webhookProjects?: Array<{ host: string; path: string }>;
}

/** GitLab's `{ message }` / `{ error, error_description }`, short, never the token. */
async function gitlabErrorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as {
      message?: unknown;
      error?: unknown;
      error_description?: unknown;
    };
    const text = [body.error_description, body.error, body.message].find(
      (v) => typeof v === "string" && v.trim(),
    );
    return typeof text === "string" ? text.slice(0, 160) : "";
  } catch {
    return "";
  }
}

const MAX_WEBHOOK_PROJECTS = 25;

/** The token user's access level on each project (null: it can't see the project). */
async function projectAccess(
  base: string,
  headers: Record<string, string>,
  paths: string[],
  userId: number | undefined,
): Promise<Array<{ project: string; level: number | null }>> {
  const out: Array<{ project: string; level: number | null }> = [];
  for (const path of paths.slice(0, MAX_WEBHOOK_PROJECTS)) {
    const enc = encodeURIComponent(path);
    let level: number | null = null;
    try {
      const res = await httpFetch(`${base}/projects/${enc}`, { headers });
      if (res.ok) {
        const p = (await res.json()) as {
          permissions?: {
            project_access?: { access_level?: number } | null;
            group_access?: { access_level?: number } | null;
          };
        };
        level = Math.max(
          p.permissions?.project_access?.access_level ?? 0,
          p.permissions?.group_access?.access_level ?? 0,
        );
      }
      // Inherited from a parent group: `permissions` may not show it.
      if ((level ?? 0) < 40 && userId !== undefined) {
        const m = await httpFetch(`${base}/projects/${enc}/members/all/${userId}`, { headers });
        if (m.ok) {
          const member = (await m.json()) as { access_level?: number };
          level = Math.max(level ?? 0, member.access_level ?? 0);
        }
      }
    } catch {
      // Unreachable for this project: leave it out rather than blame the token.
      continue;
    }
    out.push({ project: path, level });
  }
  return out;
}

/**
 * A GitLab token: `GET /personal_access_tokens/self` (expiry, scopes,
 * revoked; personal, project and group access tokens all answer it) on the
 * site's GitLab, and for the organization's token Maintainer on the projects
 * with Optio's webhooks.
 */
export async function checkGitLabToken(
  input: GitLabCheckInput,
  now: Date = new Date(),
): Promise<CheckOutcome> {
  if (!input.hosts.length) {
    return unknown(
      "No GitLab host to check it against: Optio sends a token only to a GitLab named in the chart's gitlab.hosts or by the setup wizard",
    );
  }
  const headers = {
    // Bearer: every GitLab token kind, OAuth included (PRIVATE-TOKEN takes no OAuth token).
    Authorization: `Bearer ${input.token}`,
    "User-Agent": "Optio",
    Accept: "application/json",
  };
  let refused: { host: string; status: number; why: string } | null = null;
  let unreachable: string | null = null;
  for (const host of input.hosts) {
    const base = `${gitLabInstanceForHost(host) ?? `https://${host}`}/api/v4`;
    let res: Response;
    try {
      res = await httpFetch(`${base}/personal_access_tokens/self`, { headers });
    } catch (err) {
      unreachable = `Couldn't reach GitLab at ${host}: ${describeNetworkError(err)}`;
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      refused = { host, status: res.status, why: await gitlabErrorText(res) };
      continue;
    }
    let self: GitLabTokenSelf | null = null;
    if (res.status === 404) {
      // A GitLab before 15.5: no such endpoint. Whether it signs in at all.
      try {
        const user = await httpFetch(`${base}/user`, { headers });
        if (user.status === 401 || user.status === 403) {
          refused = { host, status: user.status, why: await gitlabErrorText(user) };
          continue;
        }
        if (!user.ok) {
          unreachable = `GitLab at ${host} answered ${user.status}`;
          continue;
        }
      } catch (err) {
        unreachable = `Couldn't reach GitLab at ${host}: ${describeNetworkError(err)}`;
        continue;
      }
      return {
        status: "ok",
        reason: `${host} doesn't report this token's expiry or scopes (GitLab before 15.5)`,
        expiresAt: null,
        details: { host },
      };
    }
    if (!res.ok) {
      unreachable = `GitLab at ${host} answered ${res.status}`;
      continue;
    }
    try {
      self = (await res.json()) as GitLabTokenSelf;
    } catch {
      unreachable = `GitLab at ${host} answered something that isn't JSON`;
      continue;
    }
    let outcome = gitlabSelfOutcome(self, now, host);
    const projects = (input.webhookProjects ?? []).filter((p) => p.host === host);
    if (!outcome.invalid && projects.length) {
      const access = await projectAccess(
        base,
        headers,
        projects.map((p) => p.path),
        self.user_id,
      );
      const short = maintainerShortfall(access);
      if (short) {
        outcome = {
          ...outcome,
          status: worse(outcome.status, "warning"),
          reason: reasons(outcome.reason, short),
        };
      }
      outcome.details = { ...outcome.details, webhookProjects: access.length };
    }
    return outcome;
  }
  if (refused) {
    const why = refused.why ? `: ${refused.why}` : "";
    return {
      status: "error",
      reason:
        refused.status === 403
          ? `GitLab at ${refused.host} refused it (403${why}); it needs the api scope`
          : `GitLab at ${refused.host} refused it (401${why}): expired, revoked or wrong`,
      expiresAt: null,
      details: { host: refused.host },
      invalid: true,
    };
  }
  return unknown(unreachable ?? "GitLab didn't answer");
}

// ── GitHub ───────────────────────────────────────────────────────────────────

export interface GitHubCheckInput {
  token: string;
  /**
   * The GitHub APIs this token may be sent to (`https://api.github.com`, a
   * GitHub Enterprise Server's `https://<host>/api/v3`): those of the repos
   * its owner's work uses, tried in order; the first that accepts it is its
   * own.
   */
  apiBaseUrls: string[];
}

/** The scope a classic token needs for private repos, pull requests and pushes. */
export const GITHUB_REQUIRED_SCOPE = "repo";

/**
 * GitHub's `github-authentication-token-expiration` header (`2026-11-01
 * 12:00:00 UTC` or `… +0000`), which GitHub sends for a token that expires.
 */
export function parseGitHubExpiry(value: string | null): Date | null {
  if (!value) return null;
  const m = value
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const zone = !m[3] || m[3] === "UTC" ? "Z" : m[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
  const d = new Date(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A GitHub token (a classic or fine-grained personal access token, or a
 * machine user's): `GET /user` on its GitHub. The answer's headers carry
 * the expiry (fine-grained and expiring classic tokens) and, for a classic
 * token, its scopes, which must include `repo`.
 */
export async function checkGitHubToken(
  input: GitHubCheckInput,
  now: Date = new Date(),
): Promise<CheckOutcome> {
  if (!input.apiBaseUrls.length) {
    return unknown("No GitHub to check it against: none of its owner's repos is on GitHub");
  }
  const headers = {
    Authorization: `Bearer ${input.token}`,
    "User-Agent": "Optio",
    Accept: "application/vnd.github+json",
  };
  let refused: { api: string; status: number } | null = null;
  let unreachable: string | null = null;
  for (const api of input.apiBaseUrls) {
    const host = (() => {
      try {
        return new URL(api).host;
      } catch {
        return api;
      }
    })();
    let res: Response;
    try {
      res = await httpFetch(`${api.replace(/\/+$/, "")}/user`, { headers });
    } catch (err) {
      unreachable = `Couldn't reach GitHub at ${host}: ${describeNetworkError(err)}`;
      continue;
    }
    if (res.status === 401) {
      refused = { api: host, status: 401 };
      continue;
    }
    if (!res.ok) {
      // 403 is GitHub's rate limit as often as a refusal: not the token's fault.
      unreachable = `GitHub at ${host} answered ${res.status}`;
      continue;
    }
    let login: string | null = null;
    try {
      login = ((await res.json()) as { login?: string }).login ?? null;
    } catch {
      /* the headers are what matter */
    }
    const expiresAt = parseGitHubExpiry(res.headers.get("github-authentication-token-expiration"));
    const verdict = expiryVerdict(expiresAt, now);
    const scopesHeader = res.headers.get("x-oauth-scopes");
    const scopes =
      scopesHeader === null
        ? null
        : scopesHeader
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
    const short =
      scopes && !scopes.includes(GITHUB_REQUIRED_SCOPE)
        ? `It lacks the ${GITHUB_REQUIRED_SCOPE} scope (it has: ${scopes.join(", ") || "none"})`
        : null;
    return {
      status: short ? worse(verdict.status, "warning") : verdict.status,
      reason: reasons(verdict.reason, short),
      expiresAt,
      details: { host, ...(login ? { account: login } : {}), ...(scopes ? { scopes } : {}) },
      ...(verdict.expired ? { invalid: true } : {}),
    };
  }
  if (refused) {
    return {
      status: "error",
      reason: `GitHub at ${refused.api} refused it (401): expired, revoked or wrong`,
      expiresAt: null,
      details: { host: refused.api },
      invalid: true,
    };
  }
  return unknown(unreachable ?? "GitHub didn't answer");
}

// ── The model gateway ────────────────────────────────────────────────────────

/**
 * A gateway token: the gateway's answer about the token itself (LiteLLM's
 * `GET /key/info`, OpenRouter's `GET /api/v1/key`: expiry, blocked, spend
 * against the budget, the reset, or the gateway's own refusal of an
 * expired, spent or wrong key); a gateway whose type reports none is asked
 * `/v1/models`, which says only whether the token works.
 */
export async function checkGatewayToken(
  row: ModelProviderRow,
  token: string,
  now: Date = new Date(),
): Promise<CheckOutcome> {
  const details = { gateway: row.name };
  let res: { status: number; body: unknown };
  try {
    res = await gatewayKeyInfoRaw(row, token);
  } catch (err) {
    return unknown(`Couldn't reach the gateway: ${describeFailure(err)}`, details);
  }
  // Its info, a budget refusal, or LiteLLM turning the key away (expired:
  // a 400 `expired_key`; wrong, deleted or blocked: a 401).
  const known = keyInfoOutcome(res, now);
  if (known) return { ...known, details: { ...details, ...known.details } };
  const test = await gatewayTest(row, token);
  if (test.ok) {
    return {
      status: "ok",
      reason: "The gateway doesn't report this token's expiry or budget",
      expiresAt: null,
      details,
    };
  }
  if (test.error && /refused the token/.test(test.error)) {
    return {
      status: "error",
      reason: `Rejected by the gateway: ${test.error}`,
      expiresAt: null,
      details,
      invalid: true,
    };
  }
  return unknown(test.error ?? "The gateway didn't answer", details);
}

// ── Jira (a ticket provider's Test) ──────────────────────────────────────────

/** A Jira connection: its Test (`/serverInfo` and `/myself`) with the stored credentials. */
export async function checkJiraProvider(
  row: Pick<typeof ticketProviders.$inferSelect, "id" | "source" | "config">,
): Promise<CheckOutcome> {
  try {
    const provider = getTicketProvider(row.source as TicketSource);
    if (!provider.testConnection) return unknown(`${row.source} has no connection test`);
    const result = await provider.testConnection(await resolveProviderConfig(row));
    if (result.ok) {
      return {
        status: "ok",
        reason: null,
        expiresAt: null,
        details: {
          account: result.user ?? null,
          server: result.serverTitle ?? null,
          version: result.version ?? null,
        },
      };
    }
    const why = result.error ?? "the test failed";
    if (/\(40[13]\)|Authentication failed|Forbidden/i.test(why)) {
      return {
        status: "error",
        reason: `Jira refused it: ${why}`,
        expiresAt: null,
        details: {},
        invalid: true,
      };
    }
    if (/TLS error|certificate/i.test(why)) {
      return { status: "error", reason: why, expiresAt: null, details: {} };
    }
    return unknown(why);
  } catch (err) {
    return unknown(err instanceof Error ? err.message : String(err));
  }
}

// ── Remote workspaces (a connection's Test) ─────────────────────────────────

/**
 * A remote-workspace connection: its Test (whom the token signs in as) and,
 * when the provider says, when the token expires (Coder's own key, GitHub's
 * expiry header, Daytona's API key).
 */
export async function checkRemoteWorkspaceConnection(
  row: typeof remoteWorkspaceConnections.$inferSelect,
  now: Date = new Date(),
): Promise<CheckOutcome> {
  const provider = REMOTE_WORKSPACE_PROVIDER_INFO[row.provider]?.label ?? row.provider;
  let client;
  try {
    client = clientFor(row);
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
      expiresAt: null,
      details: {},
    };
  }
  try {
    const me = await client.whoami();
    let expiresAt: Date | null = null;
    try {
      expiresAt = await client.tokenExpiry();
    } catch {
      // The provider doesn't list the token: no expiry to show.
    }
    const expiry = expiryVerdict(expiresAt, now);
    return {
      status: expiry.status,
      reason: expiry.reason,
      expiresAt,
      details: me.username ? { account: me.username } : {},
      ...(expiry.expired ? { invalid: true } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof RemoteWorkspaceError && err.status === 403) {
      return {
        status: "error",
        reason: `${provider} refused it: ${message}`,
        expiresAt: null,
        details: {},
        invalid: true,
      };
    }
    return unknown(message);
  }
}
