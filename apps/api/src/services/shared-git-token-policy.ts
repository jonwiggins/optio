import { inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { workspaces } from "../db/schema.js";
import type { GitPlatformType } from "@optio/shared";
import {
  getDeploymentSetting,
  setDeploymentSetting,
  switchEnabled,
  switchPolicy,
  type DeploymentSwitch,
  type SwitchPolicy,
} from "./deployment-settings.js";

/**
 * Shared git token only for allowed repos (docs/repo-access.md).
 *
 * The deployment's own git credentials are the GitHub App installation
 * token, the workspace-less `GITHUB_TOKEN`, `GITLAB_TOKEN` and
 * `GITLAB_TOKEN_<HOST>` secrets a deployment admin keeps, and the API's
 * `GITHUB_TOKEN` / `GITLAB_TOKEN` environment. By default they are the last
 * fallback for every repo, so a workspace admin who adds a repo gets it read
 * and pushed with them. With this switch on, they are used for a repo only
 * when a deployment admin listed it (a pattern) for the workspace doing the
 * work. A person's own token and a workspace's own repo secret are not
 * affected: the git host itself decides what those can open.
 *
 * Off by default (Settings → Access, or `OPTIO_SHARED_GIT_TOKEN_RESTRICTED`,
 * chart `sharedGitToken.restricted`). Like every deployment switch, a saved
 * value that can't be read follows the environment, so a deployment that must
 * never fall back sets the environment too. The allowlist is kept in the app
 * (`git.sharedTokenRepos`), by workspace id; one that can't be read allows
 * nothing.
 */

export const SHARED_GIT_TOKEN_SWITCH: DeploymentSwitch = {
  key: "git.sharedTokenRestricted",
  env: "OPTIO_SHARED_GIT_TOKEN_RESTRICTED",
};

export const SHARED_GIT_TOKEN_REPOS_KEY = "git.sharedTokenRepos";

/** One allowlist entry: `pattern` may use the deployment's git token in `workspaceId`. */
export interface SharedGitTokenRule {
  workspaceId: string;
  pattern: string;
}

const CACHE_MS = 5_000;
let cache: { rules: SharedGitTokenRule[]; until: number } | null = null;

/** Forget the remembered allowlist (tests, and after a change). */
export function forgetSharedGitTokenPolicy(): void {
  cache = null;
}

/** The switch, where it comes from and the environment's default (the settings page). */
export function sharedGitTokenPolicy(): Promise<SwitchPolicy> {
  return switchPolicy(SHARED_GIT_TOKEN_SWITCH);
}

/** Whether the switch is on now (remembered for a few seconds, as every switch). */
export function sharedGitTokenRestricted(): Promise<boolean> {
  return switchEnabled(SHARED_GIT_TOKEN_SWITCH);
}

function isRule(v: unknown): v is SharedGitTokenRule {
  const r = v as SharedGitTokenRule;
  return !!r && typeof r.workspaceId === "string" && typeof r.pattern === "string";
}

/** The stored allowlist (empty when none is stored). */
export async function sharedGitTokenRules(): Promise<SharedGitTokenRule[]> {
  const stored = await getDeploymentSetting(SHARED_GIT_TOKEN_REPOS_KEY);
  return Array.isArray(stored) ? stored.filter(isRule) : [];
}

/** The allowlist, remembered for a few seconds; one that can't be read allows nothing. */
async function currentRules(): Promise<SharedGitTokenRule[]> {
  const now = Date.now();
  if (cache && cache.until > now) return cache.rules;
  let rules: SharedGitTokenRule[];
  try {
    rules = await sharedGitTokenRules();
  } catch {
    rules = [];
  }
  cache = { rules, until: now + CACHE_MS };
  return rules;
}

/**
 * A pattern in its stored form, or null when it isn't one:
 * `*` (every repo), `host/path` (that repo), or `host/path/*` (every repo
 * below `path`; `host/*` is every repo on the host). Case-insensitive; a
 * scheme, trailing slash and `.git` are dropped.
 */
export function normalizeRepoPattern(raw: string): string | null {
  let p = raw.trim().toLowerCase();
  if (p === "*") return p;
  p = p.replace(/^[a-z]+:\/\//, "").replace(/\/+$/, "");
  const wildcard = p.endsWith("/*");
  if (wildcard) p = p.slice(0, -2);
  p = p.replace(/\.git$/, "");
  const segments = p.split("/");
  segments[0] = segments[0].replace(/:\d+$/, "");
  p = segments.join("/");
  if (segments.length < (wildcard ? 1 : 2)) return null;
  if (!segments.every((s) => /^[a-z0-9_.~-]+$/.test(s) && s !== "." && s !== "..")) return null;
  return wildcard ? `${p}/*` : p;
}

/**
 * `host/path` of a repo URL, lower-cased, or null when the URL could
 * address something other than what it seems to: dot segments, escapes or
 * a query, which git or the host's API may resolve to another repository
 * than the one the pattern names.
 */
export function repoKey(repoUrl: string): string | null {
  let u = repoUrl.trim();
  const ssh = u.match(/^[\w.-]+@([^:/]+):(.+)$/);
  if (ssh) u = `${ssh[1]}/${ssh[2]}`;
  u = u
    .replace(/^[a-z+]+:\/\//i, "")
    .replace(/^[^/@]*@/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  const [hostPort, ...path] = u.split("/");
  const host = hostPort.replace(/:\d+$/, "");
  if (!host || path.length === 0) return null;
  if (!path.every((s) => /^[a-z0-9_.~-]+$/.test(s) && s !== "." && s !== "..")) return null;
  return [host, ...path].join("/");
}

/** Whether `pattern` (stored form) covers the repo at `repoUrl`. */
export function patternMatches(pattern: string, repoUrl: string): boolean {
  const key = repoKey(repoUrl);
  if (!key) return false;
  if (pattern === "*") return true;
  if (pattern.endsWith("/*")) return key.startsWith(pattern.slice(0, -1));
  return key === pattern;
}

/**
 * May the deployment's git credentials be used for `repoUrl` in work of
 * `workspaceId`? Always yes with the switch off. With it on, only for a repo
 * a deployment admin listed for that workspace: never without a workspace
 * or a repo (listing every repo the token can see, a call that names no
 * repo).
 */
export async function sharedGitTokenAllowed(
  workspaceId: string | null | undefined,
  repoUrl: string | null | undefined,
): Promise<boolean> {
  if (!(await sharedGitTokenRestricted())) return true;
  if (!workspaceId || !repoUrl) return false;
  return (await currentRules()).some(
    (r) => r.workspaceId === workspaceId && patternMatches(r.pattern, repoUrl),
  );
}

/** The repo's git host for a message, and the secret a person adds for it. */
function hostLabel(repoUrl: string | null | undefined): { host: string; secret: string } {
  const key = repoUrl ? repoKey(repoUrl) : null;
  if (key?.startsWith("github.com/")) return { host: "GitHub", secret: "GITHUB_TOKEN" };
  if (key?.includes("gitlab")) return { host: "GitLab", secret: "GITLAB_TOKEN" };
  return { host: "git", secret: "GITHUB_TOKEN or GITLAB_TOKEN" };
}

/** Thrown where only the deployment's git credentials were left and the policy refuses them. */
export class SharedGitTokenRefusedError extends Error {
  readonly code = "shared_git_token_refused";
  constructor(readonly repoUrl: string | null | undefined) {
    const { host, secret } = hostLabel(repoUrl);
    super(
      (repoUrl
        ? `The organization's shared ${host} token isn't allowed for ${repoUrl} in this workspace.`
        : `The organization's shared ${host} token is only used for allowed repositories.`) +
        ` Add your own ${host} token as a private secret named ${secret} (Connections), or ask` +
        " a deployment admin to allow the repository for this workspace (Settings → Access →" +
        " Shared git token).",
    );
    this.name = "SharedGitTokenRefusedError";
  }
}

export function isSharedGitTokenRefused(err: unknown): err is SharedGitTokenRefusedError {
  return err instanceof SharedGitTokenRefusedError;
}

// ── The settings page ────────────────────────────────────────────────────────

/** An allowlist entry as the settings page shows it: by workspace slug. */
export interface SharedGitTokenRuleView {
  workspace: string;
  pattern: string;
}

/** The allowlist with each workspace's current slug (entries of deleted workspaces dropped). */
export async function sharedGitTokenRuleViews(): Promise<SharedGitTokenRuleView[]> {
  const rules = await sharedGitTokenRules();
  if (rules.length === 0) return [];
  const ids = [...new Set(rules.map((r) => r.workspaceId))];
  const rows = await db
    .select({ id: workspaces.id, slug: workspaces.slug })
    .from(workspaces)
    .where(inArray(workspaces.id, ids));
  const slug = new Map(rows.map((r) => [r.id, r.slug]));
  return rules.flatMap((r) => {
    const s = slug.get(r.workspaceId);
    return s ? [{ workspace: s, pattern: r.pattern }] : [];
  });
}

/**
 * Replace the allowlist from the settings page's entries (workspace by slug
 * or id). Throws an Error with a message for the person on an unknown
 * workspace or a malformed pattern; nothing is saved then.
 */
export async function saveSharedGitTokenRules(
  entries: SharedGitTokenRuleView[],
  updatedBy: string | null,
): Promise<void> {
  const wanted = [...new Set(entries.map((e) => e.workspace.trim()))].filter(Boolean);
  const rows = wanted.length
    ? await db.select({ id: workspaces.id, slug: workspaces.slug }).from(workspaces)
    : [];
  const byRef = new Map<string, string>();
  for (const r of rows) {
    byRef.set(r.slug.toLowerCase(), r.id);
    byRef.set(r.id, r.id);
  }
  const rules: SharedGitTokenRule[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const workspaceId = byRef.get(e.workspace.trim().toLowerCase());
    if (!workspaceId) throw new Error(`No workspace "${e.workspace.trim()}"`);
    const pattern = normalizeRepoPattern(e.pattern);
    if (!pattern) {
      throw new Error(
        `"${e.pattern.trim()}" is not a repository pattern: use host/group/repo, host/group/* or *`,
      );
    }
    const key = `${workspaceId} ${pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ workspaceId, pattern });
  }
  await setDeploymentSetting(SHARED_GIT_TOKEN_REPOS_KEY, rules.length ? rules : null, updatedBy);
  forgetSharedGitTokenPolicy();
}

/**
 * `context` with what the policy needs to decide (the repo the token is for,
 * the workspace of the work) while the switch is on; unchanged while it is
 * off, so an off switch changes nothing about how tokens are resolved.
 */
export async function scopeToWork<T extends object>(
  context: T,
  scope: { repoUrl?: string | null; workspaceId?: string | null },
): Promise<T & { repoUrl?: string | null; workspaceId?: string | null }> {
  if (!(await sharedGitTokenRestricted())) return context;
  const defined = Object.fromEntries(Object.entries(scope).filter(([, v]) => v !== undefined));
  return { ...context, ...defined };
}

/** `scopeToWork` with the repo alone. */
export function scopeToRepo<T extends object>(
  context: T,
  repoUrl: string | null | undefined,
): Promise<T & { repoUrl?: string | null }> {
  return scopeToWork(context, { repoUrl });
}

/**
 * Why a repo may not be added to `workspaceId` under "shared git token only
 * for allowed repos" (shared-git-token-policy.ts), or null when it may: the
 * switch is off, a deployment admin allowed the repo for the workspace, or
 * the requester or the workspace has a token of its own for it (the git
 * host decides what that token can open). Other problems (no token at all,
 * an unlisted host) are left to the usual paths, as without the switch.
 */
export async function repoAdmissionRefusal(
  repoUrl: string,
  context: { userId?: string; workspaceId: string | null; platformHint?: GitPlatformType },
): Promise<string | null> {
  if (await sharedGitTokenAllowed(context.workspaceId, repoUrl)) return null;
  try {
    // Lazily: git-token-service resolves tokens through this module.
    const { getGitPlatformForRepo } = await import("./git-token-service.js");
    await getGitPlatformForRepo(repoUrl, context);
    return null;
  } catch (err) {
    return isSharedGitTokenRefused(err) ? err.message : null;
  }
}
