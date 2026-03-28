import type { FastifyInstance } from "fastify";
import { checkRuntimeHealth } from "../services/container-service.js";
import { listSecrets, retrieveSecret } from "../services/secret-service.js";
import { isSubscriptionAvailable } from "../services/auth-service.js";
import { isGitHubAppConfigured } from "../services/github-app-service.js";

export async function setupRoutes(app: FastifyInstance) {
  // Check if the system has been set up (secrets exist)
  app.get("/api/setup/status", async (_req, reply) => {
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

    const hasAnyAgentKey =
      hasAnthropicKey || hasOpenAIKey || usingSubscription || hasOauthToken || hasCodexAppServer;

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
        anyAgentKey: { done: hasAnyAgentKey, label: "At least one agent API key" },
      },
    });
  });

  // Validate a GitHub token by trying to get the authenticated user
  app.post("/api/setup/validate/github-token", async (req, reply) => {
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
      reply.send({ valid: false, error: String(err) });
    }
  });

  // Validate an Anthropic API key
  app.post("/api/setup/validate/anthropic-key", async (req, reply) => {
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
      reply.send({ valid: false, error: String(err) });
    }
  });

  // Validate an OpenAI API key
  app.post("/api/setup/validate/openai-key", async (req, reply) => {
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
      reply.send({ valid: false, error: String(err) });
    }
  });

  // List recent repos for the authenticated user
  app.post("/api/setup/repos", async (req, reply) => {
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
      reply.send({ repos: [], error: String(err) });
    }
  });

  // Validate repo access (try to ls-remote)
  app.post("/api/setup/validate/repo", async (req, reply) => {
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
      reply.send({ valid: false, error: String(err) });
    }
  });
}
