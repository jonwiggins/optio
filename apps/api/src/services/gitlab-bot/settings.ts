import { getDeploymentSetting, setDeploymentSetting } from "../deployment-settings.js";
import { getGitToken } from "../git-token-service.js";
import { siteGitLabHosts } from "../credential-health/inventory.js";
import { normalizeGitLabHost } from "../credential-health/gitlab-hosts.js";
import { GitLabBotApi } from "./gitlab-api.js";
import { isGitLabUsername } from "./commands.js";
import { botIdentityCache as cache, type BotIdentity } from "./bot-cache.js";

export type { BotIdentity } from "./bot-cache.js";

/**
 * Optio's user on GitHub and GitLab and how it answers @-mentions
 * (docs/gitlab-bot.md). One set of settings per platform, the same shape:
 *
 *   GitLab  the organization's GitLab token's own user: Optio asks GitLab
 *           (`GET /user`) and remembers the answer ten minutes per host, so
 *           whoever the token belongs to (`optio-bot`, `svc-optio`) is the
 *           name people mention — as long as GitLab says it is a bot (a
 *           project, group or service account token): a person's token
 *           is refused unless an admin names that user.
 *   GitHub  the GitHub App's bot (`<app slug>[bot]`, mentioned as
 *           `@<app slug>`), or the machine user an admin names; a
 *           personal token's user is never the bot on its own (GitHub
 *           doesn't say whether a user is a person).
 *
 * A deployment admin may name it (Settings → Integrations), or switch it
 * on or off. Deployment-wide, saved in `deployment_settings` under
 * `gitlab.bot` / `github.bot` over the environment
 * (`OPTIO_GITLAB_BOT_ENABLED`, `OPTIO_GITLAB_BOT_USERNAME`,
 * `OPTIO_GITLAB_BOT_RATE_LIMIT`, and the same `OPTIO_GITHUB_BOT_*`; chart
 * `gitlab.bot.*`, `github.bot.*`). Off on both until one of them turns it
 * on.
 */

export type BotPlatform = "github" | "gitlab";

export const GITLAB_BOT_KEY = "gitlab.bot";
export const GITHUB_BOT_KEY = "github.bot";

const BOT_KEY: Record<BotPlatform, string> = { github: GITHUB_BOT_KEY, gitlab: GITLAB_BOT_KEY };
const ENV_PREFIX: Record<BotPlatform, string> = {
  github: "OPTIO_GITHUB_BOT_",
  gitlab: "OPTIO_GITLAB_BOT_",
};

/** The rate limit's window: commands per person per merge request or issue in this many minutes. */
export const RATE_WINDOW_MINUTES = 10;
export const DEFAULT_RATE_LIMIT = 5;
export const MAX_RATE_LIMIT = 100;

/** What a deployment admin saved (absent fields follow the environment). */
export interface GitLabBotStored {
  enabled?: boolean;
  /** The bot's username; null or absent = the token's own user. */
  username?: string | null;
  rateLimit?: number;
}

export interface GitLabBotEnvironment {
  enabled: boolean;
  username: string | null;
  rateLimit: number;
}

export interface GitLabBotSettings {
  enabled: boolean;
  /** The name a deployment admin gave the bot; null = the token's own user. */
  username: string | null;
  rateLimit: number;
  source: {
    enabled: "app" | "environment";
    username: "app" | "environment" | "token";
    rateLimit: "app" | "environment";
  };
  environment: GitLabBotEnvironment;
}

function clampRate(n: number): number {
  return Math.max(1, Math.min(MAX_RATE_LIMIT, Math.floor(n)));
}

/** A platform's bot as the environment sets it (`OPTIO_<PLATFORM>_BOT_*`). */
export function envBot(
  platform: BotPlatform,
  env: NodeJS.ProcessEnv = process.env,
): GitLabBotEnvironment {
  const prefix = ENV_PREFIX[platform];
  const enabled = (env[`${prefix}ENABLED`] ?? "").trim().toLowerCase();
  const username = (env[`${prefix}USERNAME`] ?? "").trim().replace(/^@/, "");
  const rate = Number.parseInt(env[`${prefix}RATE_LIMIT`] ?? "", 10);
  return {
    enabled: ["true", "1", "yes", "on"].includes(enabled),
    username: isGitLabUsername(username) ? username : null,
    rateLimit: Number.isFinite(rate) && rate > 0 ? clampRate(rate) : DEFAULT_RATE_LIMIT,
  };
}

export function envGitLabBot(env: NodeJS.ProcessEnv = process.env): GitLabBotEnvironment {
  return envBot("gitlab", env);
}

/** The saved value, cleaned (anything unreadable is left out). */
function cleanStored(v: unknown): GitLabBotStored {
  if (!v || typeof v !== "object") return {};
  const o = v as Record<string, unknown>;
  const out: GitLabBotStored = {};
  if (typeof o.enabled === "boolean") out.enabled = o.enabled;
  if (o.username === null) out.username = null;
  else if (typeof o.username === "string" && isGitLabUsername(o.username))
    out.username = o.username;
  if (typeof o.rateLimit === "number" && o.rateLimit > 0) out.rateLimit = clampRate(o.rateLimit);
  return out;
}

export async function gitlabBotSettings(): Promise<GitLabBotSettings> {
  return botSettings("gitlab");
}

export async function githubBotSettings(): Promise<GitLabBotSettings> {
  return botSettings("github");
}

/** A platform's bot: what an admin saved, over the environment. */
export async function botSettings(platform: BotPlatform): Promise<GitLabBotSettings> {
  const environment = envBot(platform);
  const stored = cleanStored(await getDeploymentSetting(BOT_KEY[platform]));
  const appName = "username" in stored;
  return {
    enabled: stored.enabled ?? environment.enabled,
    username: appName ? (stored.username ?? null) : environment.username,
    rateLimit: stored.rateLimit ?? environment.rateLimit,
    source: {
      enabled: stored.enabled !== undefined ? "app" : "environment",
      username:
        appName && stored.username
          ? "app"
          : !appName && environment.username
            ? "environment"
            : "token",
      rateLimit: stored.rateLimit !== undefined ? "app" : "environment",
    },
    environment,
  };
}

/**
 * Save what a deployment admin changed: `undefined` keeps a field, `null`
 * returns it to the environment's (for `username`: back to the token's user
 * when the environment names none — say so with `useToken`).
 */
export interface BotSettingsPatch {
  enabled?: boolean | null;
  username?: string | null;
  useToken?: boolean;
  rateLimit?: number | null;
}

export async function saveGitLabBotSettings(
  patch: BotSettingsPatch,
  userId: string | null,
): Promise<GitLabBotSettings> {
  return saveBotSettings("gitlab", patch, userId);
}

export async function saveBotSettings(
  platform: BotPlatform,
  patch: BotSettingsPatch,
  userId: string | null,
): Promise<GitLabBotSettings> {
  const label = platform === "github" ? "GitHub" : "GitLab";
  const stored = cleanStored(await getDeploymentSetting(BOT_KEY[platform]));
  if (patch.enabled === null) delete stored.enabled;
  else if (patch.enabled !== undefined) stored.enabled = patch.enabled;
  if (patch.useToken) stored.username = null;
  else if (patch.username === null) delete stored.username;
  else if (patch.username !== undefined) {
    const name = patch.username.trim().replace(/^@/, "");
    if (!isGitLabUsername(name)) throw new Error(`"${patch.username}" isn't a ${label} username`);
    stored.username = name;
  }
  if (patch.rateLimit === null) delete stored.rateLimit;
  else if (patch.rateLimit !== undefined) stored.rateLimit = clampRate(patch.rateLimit);
  await setDeploymentSetting(BOT_KEY[platform], Object.keys(stored).length ? stored : null, userId);
  forgetBotIdentities();
  return botSettings(platform);
}

// ── Who the bot is on a host ─────────────────────────────────────────────────

const OK_TTL_MS = 10 * 60_000;
const FAIL_TTL_MS = 60_000;

export function forgetBotIdentities(): void {
  cache.clear();
}

/** The organization's GitLab token as the API uses it for server-side calls. */
export function orgGitLabToken(workspaceId: string | null, host?: string): Promise<string> {
  return getGitToken("gitlab", { server: true, workspaceId, ...(host ? { host } : {}) });
}

/**
 * The bot on `apiBaseUrl`'s GitLab: the name an admin gave it, else the
 * organization token's user when GitLab says it is a bot. Null (with the
 * reason) when neither is known, or the token is a person's.
 */
export async function botIdentity(
  apiBaseUrl: string,
  workspaceId: string | null,
  settings?: GitLabBotSettings,
): Promise<{ identity: BotIdentity | null; error: string | null }> {
  const s = settings ?? (await gitlabBotSettings());
  const key = `${apiBaseUrl}|${workspaceId ?? ""}`;
  const hit = cache.get(key);
  const ttl = hit?.identity ? OK_TTL_MS : FAIL_TTL_MS;
  let discovered = hit && Date.now() - hit.at < ttl ? hit : null;
  if (s.username) {
    // The named bot, with the token user's id when that is the same user.
    const id =
      discovered?.identity &&
      discovered.identity.username.toLowerCase() === s.username.toLowerCase()
        ? discovered.identity.id
        : null;
    return {
      identity: {
        username: s.username,
        id,
        source: s.source.username === "app" ? "app" : "environment",
      },
      error: null,
    };
  }
  if (!discovered) {
    try {
      const token = await orgGitLabToken(workspaceId, new URL(apiBaseUrl).host);
      const user = await new GitLabBotApi(apiBaseUrl, token).currentUser();
      // A person's token: mentions of that person must not start work.
      discovered =
        user.bot === false
          ? {
              at: Date.now(),
              identity: null,
              error: `The organization's GitLab token belongs to a person (@${user.username}), not a bot or service account: use a project, group or service account token, or name the bot to answer as that user`,
            }
          : {
              at: Date.now(),
              identity: { id: user.id, username: user.username, source: "token" },
              error: null,
            };
    } catch (err) {
      discovered = {
        at: Date.now(),
        identity: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    cache.set(key, discovered);
  }
  return { identity: discovered.identity, error: discovered.error };
}

/**
 * The bot on a GitHub (`apiBaseUrl`): the name an admin gave it, else the
 * GitHub App's (`<slug>`, whose comments are `<slug>[bot]`'s). Null (with
 * the reason) otherwise: a personal token's user is never the bot on its
 * own, since GitHub doesn't say whether a user is a person.
 */
export async function githubBotIdentity(
  apiBaseUrl: string,
  settings?: GitLabBotSettings,
): Promise<{ identity: BotIdentity | null; error: string | null }> {
  const s = settings ?? (await botSettings("github"));
  if (s.username) {
    return {
      identity: {
        username: s.username,
        id: null,
        source: s.source.username === "app" ? "app" : "environment",
      },
      error: null,
    };
  }
  const key = `github:${apiBaseUrl}|`;
  const hit = cache.get(key);
  const ttl = hit?.identity ? OK_TTL_MS : FAIL_TTL_MS;
  if (hit && Date.now() - hit.at < ttl) return { identity: hit.identity, error: hit.error };
  let found: { identity: BotIdentity | null; error: string | null };
  const { isGitHubAppConfigured, generateJwt } = await import("../github-app-service.js");
  if (!isGitHubAppConfigured() || apiBaseUrl !== "https://api.github.com") {
    found = {
      identity: null,
      error:
        "Name the GitHub bot (the machine user people mention): without a GitHub App, Optio never answers as a token's user on its own",
    };
  } else {
    try {
      const { githubAppSlug } = await import("./github-api.js");
      const slug = await githubAppSlug(await generateJwt());
      found = { identity: { username: slug, id: null, source: "token" }, error: null };
    } catch (err) {
      found = { identity: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
  cache.set(key, { at: Date.now(), ...found });
  return found;
}

// ── Where the bot may call ───────────────────────────────────────────────────

/**
 * The GitLab hosts the bot answers on: those a deployment admin named (the
 * setup wizard's `GITLAB_HOST`, the chart's `gitlab.hosts`), as for
 * credential health (credential-health/gitlab-hosts.ts). A repo's host
 * alone isn't enough: any workspace admin adds repos, and the organization's
 * token must not go to a host nobody named.
 */
export async function botHosts(): Promise<string[]> {
  return siteGitLabHosts().catch(() => []);
}

/** Whether `host` (a repo URL's, maybe without the port) is one of `named`. */
export function isNamedHost(host: string, named: string[]): boolean {
  const h = normalizeGitLabHost(host);
  const bare = (v: string) => v.replace(/:\d+$/, "");
  return named.some((n) => n === h || bare(n) === bare(h));
}
