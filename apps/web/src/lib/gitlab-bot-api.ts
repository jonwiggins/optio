/**
 * Optio's bot, which people mention in GitLab and GitHub comments
 * (docs/gitlab-bot.md). The API is apps/api/src/routes/gitlab-bot.ts
 * (`/api/gitlab-bot`, `/api/github-bot`, the same shape), kept out of
 * api-client.ts so that file stays as it is.
 */
import { request } from "@/lib/api-client";

export interface GitLabBotView {
  enabled: boolean;
  /** The name a deployment admin gave the bot; null = the organization token's user. */
  username: string | null;
  rateLimit: number;
  rateWindowMinutes: number;
  maxRateLimit: number;
  source: {
    enabled: "app" | "environment";
    username: "app" | "environment" | "token";
    rateLimit: "app" | "environment";
  };
  environment: { enabled: boolean; username: string | null; rateLimit: number };
  /** Whom to mention on each GitLab host. */
  hosts: Array<{ host: string; username: string | null; error: string | null }>;
  canEdit: boolean;
}

export interface GitLabBotUpdate {
  enabled?: boolean | null;
  username?: string | null;
  useToken?: boolean;
  rateLimit?: number | null;
}

export type BotPlatform = "github" | "gitlab";

export function botApi(platform: BotPlatform) {
  const path = `/api/${platform}-bot`;
  return {
    get: () => request<GitLabBotView>(path),
    update: (body: GitLabBotUpdate) =>
      request<GitLabBotView>(path, { method: "PUT", body: JSON.stringify(body) }),
  };
}

export const gitlabBotApi = botApi("gitlab");
export const githubBotApi = botApi("github");
