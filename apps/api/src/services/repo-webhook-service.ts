/**
 * The webhook that makes a repo's funnel automatic: Optio registers its own
 * receiver on the project when the repo is added, and repairs it on request
 * from the repo page. The outcome lives on the repo row (`webhook_id`,
 * `webhook_url`, `webhook_synced_at`, `webhook_error`) so the page can show
 * it.
 *
 * Which platforms get one is `OPTIO_REPO_WEBHOOKS` (`repoWebhookPlatforms`):
 * GitLab by default (`<public API>/api/webhooks/gitlab`, its token), GitHub
 * only when the list names it (`github` or `all`), and only for a deployment
 * that reaches GitHub with a token rather than a GitHub App — an App's own
 * webhook already delivers (`<public API>/api/webhooks/github`, an HMAC
 * secret Optio generates unless GITHUB_WEBHOOK_SECRET is set); `none` turns
 * it off for both.
 *
 * Nothing here throws to the caller: adding a repo must not fail because
 * the platform is down or the token lacks the right (GitLab: Maintainer;
 * GitHub: admin on the repository) — the error is stored and shown instead.
 * Uses the server's token for the platform, as `getGitPlatformForRepo`
 * with `server: true` resolves it.
 */
import type { GitPlatformType } from "@optio/shared";
import { logger } from "../logger.js";
import { getGitPlatformForRepo } from "./git-token-service.js";
import type { GitLabWebhookSpec } from "./git-platform/gitlab.js";
import { isGitHubAppConfigured } from "./github-app-service.js";
import { publicApiOrigin } from "./oauth/provider.js";
import { updateRepo, type RepoRecord } from "./repo-service.js";
import { ensureGithubWebhookSecret, ensureGitlabWebhookSecret } from "./webhook-secret-service.js";

/** What the receiver understands (`normalizeGitLabEvent`), in GitLab's event names. */
export const GITLAB_WEBHOOK_EVENTS = [
  "push",
  "merge_requests",
  "note",
  "issues",
  "pipeline",
  "releases",
] as const;

/** What the GitHub receiver understands (`normalizeGitHubEvent`, routes/tickets.ts). */
export const GITHUB_WEBHOOK_EVENTS = [
  "push",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issues",
  "issue_comment",
  "release",
  "workflow_run",
  "check_suite",
] as const;

type HookPlatform = "gitlab" | "github";

/**
 * The platforms whose repos get Optio's webhook: `OPTIO_REPO_WEBHOOKS`, a
 * comma list of `gitlab` / `github` (`all` for both, `none` for neither);
 * unset, GitLab's only.
 */
export function repoWebhookPlatforms(env: NodeJS.ProcessEnv = process.env): HookPlatform[] {
  const raw = (env.OPTIO_REPO_WEBHOOKS ?? "").trim().toLowerCase();
  if (!raw) return ["gitlab"];
  if (["none", "false", "off", "0"].includes(raw)) return [];
  if (["all", "true", "on", "1"].includes(raw)) return ["github", "gitlab"];
  const names = raw.split(",").map((v) => v.trim());
  return (["github", "gitlab"] as const).filter((p) => names.includes(p));
}

/**
 * Whether Optio keeps a webhook on a repo of `platform`: the platform is in
 * `repoWebhookPlatforms`, and for GitHub no App is configured (the App's
 * own webhook delivers).
 */
export function repoWebhooksFor(platform: string | null | undefined): platform is HookPlatform {
  if (platform !== "gitlab" && platform !== "github") return false;
  if (!repoWebhookPlatforms().includes(platform)) return false;
  return platform === "gitlab" || !isGitHubAppConfigured();
}

export interface RepoWebhookStatus {
  hookId: string | null;
  url: string | null;
  syncedAt: Date | null;
  error: string | null;
}

export function repoWebhookStatus(repo: RepoRecord): RepoWebhookStatus {
  return {
    hookId: repo.webhookId ?? null,
    url: repo.webhookUrl ?? null,
    syncedAt: repo.webhookSyncedAt ?? null,
    error: repo.webhookError ?? null,
  };
}

/**
 * Where GitLab should deliver, or null when the deployment has no public
 * address (`PUBLIC_API_URL` / `PUBLIC_URL` unset): `publicApiOrigin()` then
 * falls back to localhost, which GitLab cannot reach.
 */
export function gitlabWebhookUrl(): string | null {
  return receiverUrl("gitlab");
}

/** Where a platform's receiver is (`/api/webhooks/<platform>`), or null without a public address. */
function receiverUrl(platform: HookPlatform): string | null {
  if (!process.env.PUBLIC_API_URL?.trim() && !process.env.PUBLIC_URL?.trim()) return null;
  return `${publicApiOrigin()}/api/webhooks/${platform}`;
}

const PLATFORM_NAME: Record<HookPlatform, string> = { github: "GitHub", gitlab: "GitLab" };

/**
 * Make the repo's webhook exist and point at this deployment. Returns the
 * stored status; a repo whose platform gets no webhook (`repoWebhooksFor`)
 * is left alone.
 */
export async function ensureRepoWebhook(
  repo: RepoRecord,
  actor?: { userId?: string | null },
): Promise<RepoWebhookStatus> {
  const platformType = repo.gitPlatform;
  if (!repoWebhooksFor(platformType)) return repoWebhookStatus(repo);
  const name = PLATFORM_NAME[platformType];

  const url = receiverUrl(platformType);
  if (!url) {
    return store(repo, {
      webhookError: `PUBLIC_API_URL (or PUBLIC_URL) is not set, so ${name} has no address to deliver to`,
    });
  }

  try {
    const token =
      platformType === "gitlab"
        ? await ensureGitlabWebhookSecret()
        : await ensureGithubWebhookSecret();
    const { platform, ri } = await getGitPlatformForRepo(repo.repoUrl, {
      server: true,
      workspaceId: repo.workspaceId ?? null,
      platformHint: repo.gitPlatform as GitPlatformType,
    });
    if (!platform.ensureWebhook) {
      throw new Error(`Webhooks are not supported on ${platform.type}`);
    }
    // The hook made before, so a moved public URL updates it instead of adding one.
    const spec: GitLabWebhookSpec = {
      url,
      token,
      events: platformType === "gitlab" ? [...GITLAB_WEBHOOK_EVENTS] : [...GITHUB_WEBHOOK_EVENTS],
      ...(repo.webhookId ? { hookId: repo.webhookId } : {}),
    };
    const { hookId, created } = await platform.ensureWebhook(ri, spec);
    logger.info(
      { repoId: repo.id, repoUrl: repo.repoUrl, hookId, created, userId: actor?.userId ?? null },
      created ? `Created the ${name} webhook` : `Updated the ${name} webhook`,
    );
    return store(repo, {
      webhookId: hookId,
      webhookUrl: url,
      webhookSyncedAt: new Date(),
      webhookError: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, repoId: repo.id, repoUrl: repo.repoUrl, userId: actor?.userId ?? null },
      `${name} webhook could not be set up`,
    );
    return store(repo, { webhookError: message });
  }
}

/**
 * Take Optio's hook off the project when the repo is removed. Best effort:
 * the repo goes either way, and a hook already gone is fine.
 */
export async function removeRepoWebhook(repo: RepoRecord): Promise<void> {
  if ((repo.gitPlatform !== "gitlab" && repo.gitPlatform !== "github") || !repo.webhookId) return;
  try {
    const { platform, ri } = await getGitPlatformForRepo(repo.repoUrl, {
      server: true,
      workspaceId: repo.workspaceId ?? null,
      platformHint: repo.gitPlatform as GitPlatformType,
    });
    await platform.deleteWebhook?.(ri, repo.webhookId);
    logger.info({ repoId: repo.id, hookId: repo.webhookId }, "Removed the repo's webhook");
  } catch (err) {
    logger.warn({ err, repoId: repo.id, hookId: repo.webhookId }, "Repo webhook not removed");
  }
}

async function store(
  repo: RepoRecord,
  fields: {
    webhookId?: string | null;
    webhookUrl?: string | null;
    webhookSyncedAt?: Date | null;
    webhookError: string | null;
  },
): Promise<RepoWebhookStatus> {
  try {
    const updated = await updateRepo(repo.id, fields);
    if (updated) return repoWebhookStatus(updated);
  } catch (err) {
    logger.warn({ err, repoId: repo.id }, "Repo webhook status not stored");
  }
  return repoWebhookStatus({ ...repo, ...fields });
}
