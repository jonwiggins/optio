/**
 * The shared secrets the webhooks Optio registers carry — GitLab's token
 * (`X-Gitlab-Token`) and GitHub's HMAC secret (`X-Hub-Signature-256`) —
 * resolved the same way by the receivers (`routes/event-ingress.ts`,
 * `routes/tickets.ts`) and by the service that registers hooks on projects
 * (`repo-webhook-service.ts`).
 *
 * The deployment's `GITLAB_WEBHOOK_SECRET` / `GITHUB_WEBHOOK_SECRET` wins
 * when set. Otherwise the secret is Optio's own: generated once, kept as the
 * global secret of the same name, and handed to every hook Optio creates —
 * so a deployment needs to configure nothing for events to arrive. The
 * receivers are rate-limited and must not read Postgres per delivery, so a
 * found value is cached for a minute; a miss is not, so the first hook's
 * deliveries work the moment the secret exists.
 */
import { randomBytes } from "node:crypto";
import { logger } from "../logger.js";
import { retrieveSecret, storeSecret } from "./secret-service.js";

export const GITLAB_WEBHOOK_SECRET_NAME = "GITLAB_WEBHOOK_SECRET";
export const GITHUB_WEBHOOK_SECRET_NAME = "GITHUB_WEBHOOK_SECRET";

const CACHE_TTL_MS = 60_000;

/** One platform's webhook secret: the environment's, else the one Optio stored. */
function webhookSecretKeeper(name: string, platform: string) {
  let cached: { value: string; at: number } | null = null;

  const fromEnv = (): string | null => process.env[name]?.trim() || null;

  async function fromStore(): Promise<string | null> {
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
    try {
      const value = await retrieveSecret(name, "global");
      cached = { value, at: Date.now() };
      return value;
    } catch {
      return null;
    }
  }

  async function get(): Promise<string | null> {
    return fromEnv() ?? (await fromStore());
  }

  async function ensure(): Promise<string> {
    const existing = await get();
    if (existing) return existing;
    await storeSecret(name, randomBytes(32).toString("hex"), "global");
    logger.info(`Generated the ${platform} webhook secret (stored as a global secret)`);
    cached = null;
    const stored = await fromStore();
    if (!stored) throw new Error(`The ${platform} webhook secret could not be stored`);
    return stored;
  }

  return { get, ensure, reset: () => (cached = null) };
}

const gitlab = webhookSecretKeeper(GITLAB_WEBHOOK_SECRET_NAME, "GitLab");
const github = webhookSecretKeeper(GITHUB_WEBHOOK_SECRET_NAME, "GitHub");

/**
 * The token deliveries must carry: the environment's, else the stored one,
 * else null (GitLab triggers stay off until a hook is created).
 */
export async function gitlabWebhookSecret(): Promise<string | null> {
  return gitlab.get();
}

/**
 * The token to put on a hook Optio creates — generated and stored on first
 * use. Two concurrent first uses both store; the value read back afterwards
 * is the one that won, so every hook gets what the receiver will check.
 */
export async function ensureGitlabWebhookSecret(): Promise<string> {
  return gitlab.ensure();
}

/**
 * GitHub's: the deployment's `GITHUB_WEBHOOK_SECRET`, else the one Optio
 * generated for the repository hooks it registers (opt-in,
 * repo-webhook-service.ts), else null — as upstream, the receiver then
 * refuses every delivery.
 */
export async function githubWebhookSecret(): Promise<string | null> {
  return github.get();
}

/** The secret for a GitHub repository hook Optio creates — generated and stored on first use. */
export async function ensureGithubWebhookSecret(): Promise<string> {
  return github.ensure();
}

/** For tests. */
export function resetGitlabWebhookSecretCache(): void {
  gitlab.reset();
}

/** For tests. */
export function resetGithubWebhookSecretCache(): void {
  github.reset();
}
