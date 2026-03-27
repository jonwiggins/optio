import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks } from "../db/schema.js";
import {
  retrieveSecret,
  retrieveSecretWithFallback,
  storeSecret,
  deleteSecret,
} from "./secret-service.js";
import { isGitHubAppConfigured, getInstallationToken } from "./github-app-service.js";

const refreshLocks = new Map<string, Promise<string>>();
const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000;

export type GitHubTokenContext =
  | { taskId: string }
  | { userId: string; workspaceId?: string | null }
  | { server: true };

export async function getGitHubToken(context: GitHubTokenContext): Promise<string> {
  if ("server" in context) return getServerToken();
  if ("taskId" in context) return getTokenForTask(context.taskId);
  return getTokenForUser(context.userId, context.workspaceId);
}

async function getServerToken(): Promise<string> {
  if (isGitHubAppConfigured()) return getInstallationToken();
  return retrieveSecretWithFallback("GITHUB_TOKEN", "global");
}

async function getTokenForTask(taskId: string): Promise<string> {
  const [task] = await db
    .select({ createdBy: tasks.createdBy, workspaceId: tasks.workspaceId })
    .from(tasks)
    .where(eq(tasks.id, taskId));

  if (!task?.createdBy) {
    return retrieveSecretWithFallback("GITHUB_TOKEN", "global", task?.workspaceId);
  }
  return getTokenForUser(task.createdBy, task.workspaceId);
}

async function getTokenForUser(userId: string, workspaceId?: string | null): Promise<string> {
  try {
    const accessToken = await retrieveSecret("GITHUB_USER_ACCESS_TOKEN", `user:${userId}`);
    const expiresAt = await retrieveSecret("GITHUB_USER_TOKEN_EXPIRES_AT", `user:${userId}`);

    const expiryTime = new Date(expiresAt).getTime();
    if (Date.now() < expiryTime - TOKEN_REFRESH_BUFFER_MS) {
      return accessToken;
    }
    return refreshUserToken(userId);
  } catch {
    return retrieveSecretWithFallback("GITHUB_TOKEN", "global", workspaceId);
  }
}

async function refreshUserToken(userId: string): Promise<string> {
  const existing = refreshLocks.get(userId);
  if (existing) return existing;

  const refreshPromise = doRefreshUserToken(userId);
  refreshLocks.set(userId, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    refreshLocks.delete(userId);
  }
}

async function doRefreshUserToken(userId: string): Promise<string> {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    await deleteUserGitHubTokens(userId);
    return retrieveSecretWithFallback("GITHUB_TOKEN", "global");
  }

  try {
    const refreshToken = await retrieveSecret("GITHUB_USER_REFRESH_TOKEN", `user:${userId}`);

    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) throw new Error(`GitHub token refresh failed: ${res.status}`);

    const data = (await res.json()) as Record<string, string | number>;
    if (data.error) throw new Error(`GitHub token refresh error: ${data.error}`);

    const newAccessToken = data.access_token as string;
    const newRefreshToken = data.refresh_token as string;
    const expiresIn = (data.expires_in as number) || 28800;

    await storeUserGitHubTokens(userId, {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn,
    });

    return newAccessToken;
  } catch {
    await deleteUserGitHubTokens(userId);
    return retrieveSecretWithFallback("GITHUB_TOKEN", "global");
  }
}

export async function storeUserGitHubTokens(
  userId: string,
  tokens: { accessToken: string; refreshToken: string; expiresIn: number },
): Promise<void> {
  const scope = `user:${userId}`;
  const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
  await Promise.all([
    storeSecret("GITHUB_USER_ACCESS_TOKEN", tokens.accessToken, scope),
    storeSecret("GITHUB_USER_REFRESH_TOKEN", tokens.refreshToken, scope),
    storeSecret("GITHUB_USER_TOKEN_EXPIRES_AT", expiresAt, scope),
  ]);
}

export async function deleteUserGitHubTokens(userId: string): Promise<void> {
  const scope = `user:${userId}`;
  await Promise.all([
    deleteSecret("GITHUB_USER_ACCESS_TOKEN", scope),
    deleteSecret("GITHUB_USER_REFRESH_TOKEN", scope),
    deleteSecret("GITHUB_USER_TOKEN_EXPIRES_AT", scope),
  ]);
}
