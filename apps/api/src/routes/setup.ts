import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { checkRuntimeHealth } from "../services/container-service.js";
import { listSecrets, retrieveSecret } from "../services/secret-service.js";
import { isSubscriptionAvailable } from "../services/auth-service.js";
import { isGitHubAppConfigured } from "../services/github-app-service.js";
import { isAuthDisabled } from "../services/oauth/index.js";

/** Rate limit config for setup POST endpoints: 5 requests per 15 minutes per IP. */
const SETUP_POST_RATE_LIMIT = {
  max: 5,
  timeWindow: "15 minutes",
};

/** Rate limit config for the status endpoint: 20 requests per minute per IP. */
const SETUP_STATUS_RATE_LIMIT = {
  max: 20,
  timeWindow: "1 minute",
};

/**
 * Pre-handler for POST setup routes.
 *
 * When auth is enabled and the user is authenticated (i.e. setup is already
 * complete — the auth plugin only lets unauthenticated requests through when
 * setup is NOT complete), require the admin role.
 */
const requireAdminWhenAuthenticated = async (req: FastifyRequest, reply: FastifyReply) => {
  if (isAuthDisabled()) return;
  if (!req.user) return; // Not authenticated → setup not yet complete, allow
  if (req.user.workspaceRole !== "admin") {
    return reply.status(403).send({
      error: "Admin role required for setup operations",
    });
  }
};

function sanitizeError(err: unknown): string {
  if (process.env.NODE_ENV !== "production") return String(err);
  return "An unexpected error occurred";
}

export async function setupRoutes(app: FastifyInstance) {
  // Check if the system has been set up (secrets exist)
  app.get(
    "/api/setup/status",
    { config: { rateLimit: SETUP_STATUS_RATE_LIMIT } },
    async (_req, reply) => {
      const secrets = await listSecrets();
      const secretNames = secrets.map((s) => s.name);

      const hasAnthropicKey = secretNames.includes("ANTHROPIC_API_KEY");
      const hasOpenAIKey = secretNames.includes("OPENAI_API_KEY");
      // GitHub App configured at deployment level satisfies the GitHub token requirement
      const hasGithubToken = secretNames.includes("GITHUB_TOKEN") || isGitHubAppConfigured();

      // Check if using Max subscription or OAuth token mode
      let usingSubscription = false;
      let hasOauthToken = false;
      try {
        const authMode = await retrieveSecret("CLAUDE_AUTH_MODE").catch(() => null);
        if (authMode === "max-subscription") {
          usingSubscription = isSubscriptionAvailable();
        }
        if (authMode === "oauth-token") {
          hasOauthToken = secretNames.includes("CLAUDE_CODE_OAUTH_TOKEN");
        }
      } catch {}

      // Check if using Codex app-server mode (no API key needed)
      let hasCodexAppServer = false;
      try {
        const codexAuthMode = await retrieveSecret("CODEX_AUTH_MODE").catch(() => null);
        if (codexAuthMode === "app-server") {
          hasCodexAppServer = secretNames.includes("CODEX_APP_SERVER_URL");
        }
      } catch {}

      // Check for Copilot token
      const hasCopilotToken = secretNames.includes("COPILOT_GITHUB_TOKEN");

      const hasAnyAgentKey =
        hasAnthropicKey ||
        hasOpenAIKey ||
        usingSubscription ||
        hasOauthToken ||
        hasCodexAppServer ||
        hasCopilotToken;

      let runtimeHealthy = false;
      try {
        runtimeHealthy = await checkRuntimeHealth();
      } catch {}

      const isSetUp = hasAnyAgentKey && hasGithubToken && runtimeHealthy;

      reply.send({
        isSetUp,
        steps: {
          runtime: { done: runtimeHealthy, label: "Container runtime" },
          githubToken: { done: hasGithubToken, label: "GitHub token" },
          anthropicKey: { done: hasAnthropicKey, label: "Anthropic API key" },
          openaiKey: { done: hasOpenAIKey, label: "OpenAI API key" },
          codexAppServer: { done: hasCodexAppServer, label: "Codex app-server" },
          copilotToken: { done: hasCopilotToken, label: "GitHub Copilot token" },
          anyAgentKey: { done: hasAnyAgentKey, label: "At least one agent API key" },
        },
      });
    },
  );

  // Validate a GitHub token by trying to get the authenticated user
  app.post(
    "/api/setup/validate/github-token",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
    },
    async (req, reply) => {
      const { token } = req.body as { token: string };
      if (!token) return reply.status(400).send({ valid: false, error: "Token is required" });

      try {
        const res = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${token}`, "User-Agent": "Optio" },
        });
        if (!res.ok) {
          return reply.send({ valid: false, error: `GitHub returned ${res.status}` });
        }
        const user = (await res.json()) as { login: string; name: string };
        reply.send({ valid: true, user: { login: user.login, name: user.name } });
      } catch (err) {
        app.log.error(err, "GitHub token validation failed");
        reply.send({ valid: false, error: sanitizeError(err) });
      }
    },
  );

  // Validate a GitLab token by trying to get the authenticated user
  app.post(
    "/api/setup/validate/gitlab-token",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
    },
    async (req, reply) => {
      const { token, host } = req.body as { token: string; host?: string };
      if (!token) return reply.status(400).send({ valid: false, error: "Token is required" });

      const gitlabHost = host ?? "gitlab.com";
      try {
        const res = await fetch(`https://${gitlabHost}/api/v4/user`, {
          headers: { "PRIVATE-TOKEN": token, "User-Agent": "Optio" },
        });
        if (!res.ok) {
          return reply.send({ valid: false, error: `GitLab returned ${res.status}` });
        }
        const user = (await res.json()) as { username: string; name: string };
        reply.send({ valid: true, user: { login: user.username, name: user.name } });
      } catch (err) {
        app.log.error(err, "GitLab token validation failed");
        reply.send({ valid: false, error: sanitizeError(err) });
      }
    },
  );

  // Validate an Anthropic API key
  app.post(
    "/api/setup/validate/anthropic-key",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
    },
    async (req, reply) => {
      const { key } = req.body as { key: string };
      if (!key) return reply.status(400).send({ valid: false, error: "Key is required" });

      try {
        const res = await fetch("https://api.anthropic.com/v1/models", {
          headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          },
        });
        if (res.ok) {
          reply.send({ valid: true });
        } else {
          const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          reply.send({ valid: false, error: body.error?.message ?? `API returned ${res.status}` });
        }
      } catch (err) {
        app.log.error(err, "Anthropic key validation failed");
        reply.send({ valid: false, error: sanitizeError(err) });
      }
    },
  );

  // Validate a GitHub Copilot token
  app.post(
    "/api/setup/validate/copilot-token",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
    },
    async (req, reply) => {
      const { token } = req.body as { token: string };
      if (!token) return reply.status(400).send({ valid: false, error: "Token is required" });

      // Classic PATs (ghp_*) are not supported by Copilot CLI
      if (token.startsWith("ghp_")) {
        return reply.send({
          valid: false,
          error:
            "Classic personal access tokens (ghp_) are not supported by Copilot. Use a fine-grained PAT with the Copilot Requests permission.",
        });
      }

      try {
        const res = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${token}`, "User-Agent": "Optio" },
        });
        if (!res.ok) {
          return reply.send({ valid: false, error: `GitHub returned ${res.status}` });
        }
        const user = (await res.json()) as { login: string; name: string };
        reply.send({ valid: true, user: { login: user.login, name: user.name } });
      } catch (err) {
        app.log.error(err, "Copilot token validation failed");
        reply.send({ valid: false, error: sanitizeError(err) });
      }
    },
  );

  // Validate an OpenAI API key
  app.post(
    "/api/setup/validate/openai-key",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
    },
    async (req, reply) => {
      const { key } = req.body as { key: string };
      if (!key) return reply.status(400).send({ valid: false, error: "Key is required" });

      try {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (res.ok) {
          reply.send({ valid: true });
        } else {
          const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          reply.send({ valid: false, error: body.error?.message ?? `API returned ${res.status}` });
        }
      } catch (err) {
        app.log.error(err, "OpenAI key validation failed");
        reply.send({ valid: false, error: sanitizeError(err) });
      }
    },
  );

  // List recent repos for the authenticated user
  app.post(
    "/api/setup/repos",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
    },
    async (req, reply) => {
      const { token } = req.body as { token: string };
      if (!token) return reply.status(400).send({ repos: [], error: "Token is required" });

      try {
        const headers = { Authorization: `Bearer ${token}`, "User-Agent": "Optio" };

        // Fetch repos sorted by most recently pushed
        const res = await fetch(
          "https://api.github.com/user/repos?sort=pushed&direction=desc&per_page=20&affiliation=owner,collaborator,organization_member",
          { headers },
        );
        if (!res.ok) {
          return reply.send({ repos: [], error: `GitHub returned ${res.status}` });
        }

        const data = (await res.json()) as Array<{
          full_name: string;
          html_url: string;
          clone_url: string;
          default_branch: string;
          private: boolean;
          description: string | null;
          language: string | null;
          pushed_at: string;
        }>;

        const repos = data.map((r) => ({
          fullName: r.full_name,
          cloneUrl: r.clone_url,
          htmlUrl: r.html_url,
          defaultBranch: r.default_branch,
          isPrivate: r.private,
          description: r.description,
          language: r.language,
          pushedAt: r.pushed_at,
        }));

        reply.send({ repos });
      } catch (err) {
        app.log.error(err, "Repo listing failed");
        reply.send({ repos: [], error: sanitizeError(err) });
      }
    },
  );

  // List GitLab projects accessible to the token
  app.post(
    "/api/setup/repos/gitlab",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
    },
    async (req, reply) => {
      const { token, host } = req.body as { token: string; host?: string };
      if (!token) return reply.status(400).send({ repos: [], error: "Token is required" });

      const gitlabHost = host ?? "gitlab.com";
      try {
        const res = await fetch(
          `https://${gitlabHost}/api/v4/projects?membership=true&order_by=last_activity_at&sort=desc&per_page=20`,
          { headers: { "PRIVATE-TOKEN": token, "User-Agent": "Optio" } },
        );
        if (!res.ok) {
          return reply.send({ repos: [], error: `GitLab returned ${res.status}` });
        }

        const data = (await res.json()) as Array<{
          path_with_namespace: string;
          web_url: string;
          http_url_to_repo: string;
          default_branch: string;
          visibility: string;
          description: string | null;
          last_activity_at: string;
        }>;

        const repos = data.map((r) => ({
          fullName: r.path_with_namespace,
          cloneUrl: r.http_url_to_repo,
          htmlUrl: r.web_url,
          defaultBranch: r.default_branch ?? "main",
          isPrivate: r.visibility !== "public",
          description: r.description,
          language: null,
          pushedAt: r.last_activity_at,
        }));

        reply.send({ repos });
      } catch (err) {
        app.log.error(err, "GitLab repo listing failed");
        reply.send({ repos: [], error: sanitizeError(err) });
      }
    },
  );

  // Validate repo access (try to ls-remote)
  app.post(
    "/api/setup/validate/repo",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
    },
    async (req, reply) => {
      const { repoUrl, token } = req.body as { repoUrl: string; token?: string };
      if (!repoUrl) return reply.status(400).send({ valid: false, error: "Repo URL is required" });

      try {
        // Use the GitHub API to check if the repo exists and is accessible
        const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
        if (!match) {
          return reply.send({ valid: false, error: "Could not parse GitHub repo from URL" });
        }
        const [, owner, repo] = match;
        const headers: Record<string, string> = { "User-Agent": "Optio" };
        const effectiveToken = token ?? (await retrieveSecret("GITHUB_TOKEN").catch(() => null));
        if (effectiveToken) headers["Authorization"] = `Bearer ${effectiveToken}`;

        const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
        if (res.ok) {
          const data = (await res.json()) as {
            full_name: string;
            default_branch: string;
            private: boolean;
          };
          reply.send({
            valid: true,
            repo: {
              fullName: data.full_name,
              defaultBranch: data.default_branch,
              isPrivate: data.private,
            },
          });
        } else {
          reply.send({ valid: false, error: `Repository not accessible (${res.status})` });
        }
      } catch (err) {
        app.log.error(err, "Repo validation failed");
        reply.send({ valid: false, error: sanitizeError(err) });
      }
    },
  );
}
