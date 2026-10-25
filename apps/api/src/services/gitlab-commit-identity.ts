import { gitLabFetch } from "./gitlab-instance-runtime.js";
/**
 * Who agents commit as on a GitLab repo when the deployment set no
 * GIT_BOT_NAME / GIT_BOT_EMAIL and the organization's token for that host
 * is a project or group access token: that token's bot user, with the
 * commit email GitLab gives it — its `commit_email`, else GitLab's private
 * address `<id>-<username>@users.noreply.<host>`. So GitLab's push rules
 * ("committer email must match a verified address") and its attribution see
 * the bot that pushes, not a github.com address.
 *
 * A person's token leaves the default identity: agents' commits are never
 * authored as a real person. GitHub repos keep their identity (the GitHub
 * App's bot, else `optio-agent@noreply.github.com`), and so does a GitLab
 * user that can't be read.
 */
import { createHash } from "node:crypto";
import { parseRepoUrl } from "@optio/shared";
import { getGitToken } from "./git-token-service.js";

const CACHE_MS = 60 * 60_000;
const cache = new Map<string, { at: number; identity: CommitIdentity | null }>();

export interface CommitIdentity {
  name: string;
  email: string;
}

/**
 * The GitLab commit identity for `repoUrl`'s host, or null (not GitLab, not
 * a bot user's token, or unreadable).
 */
export async function gitLabCommitIdentity(
  repoUrl: string,
  workspaceId: string | null,
): Promise<CommitIdentity | null> {
  const ri = parseRepoUrl(repoUrl);
  if (!ri || ri.platform !== "gitlab") return null;
  let token: string;
  try {
    token = await getGitToken("gitlab", { server: true, workspaceId, host: ri.host });
  } catch {
    return null;
  }
  const key = `${ri.apiBaseUrl}|${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.identity;

  let identity: CommitIdentity | null = null;
  try {
    const res = await gitLabFetch(`${ri.apiBaseUrl}/user`, {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "Optio" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const user = (await res.json()) as {
        id?: number;
        username?: string;
        name?: string;
        commit_email?: string | null;
        /** A project, group or service account token's user. */
        bot?: boolean;
      };
      if (user.bot === true && typeof user.id === "number" && user.username) {
        const host = ri.host.replace(/:\d+$/, "");
        identity = {
          name: user.name || user.username,
          email: user.commit_email || `${user.id}-${user.username}@users.noreply.${host}`,
        };
      }
    }
  } catch {
    // Unreachable: the default identity, and asked again next time.
    return null;
  }
  cache.set(key, { at: Date.now(), identity });
  return identity;
}

/** Forget every cached identity (tests). */
export function resetGitLabCommitIdentityCache(): void {
  cache.clear();
}
