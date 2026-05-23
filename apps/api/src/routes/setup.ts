import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { checkRuntimeHealth } from "../services/container-service.js";
import { listSecrets, retrieveSecret } from "../services/secret-service.js";
import { isSubscriptionAvailable } from "../services/auth-service.js";
import { isGitHubAppConfigured, getInstallationToken } from "../services/github-app-service.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import { ErrorResponseSchema } from "../schemas/common.js";

const tokenSchema = z.object({ token: z.string().min(1) }).describe("Body with a required token");
const gitlabTokenSchema = z
  .object({
    token: z.string().min(1),
    host: z
      .string()
      .optional()
      .describe("Optional self-hosted GitLab host; defaults to gitlab.com"),
  })
  .describe("GitLab token + optional host");
const awsCredentialsSchema = z
  .object({
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
    sessionToken: z.string().optional(),
    region: z.string().min(1),
  })
  .describe("AWS credentials + region for CodeCommit access");
const keySchema = z.object({ key: z.string().min(1) }).describe("Body with a required API key");
const reposBodySchema = z
  .object({
    token: z
      .string()
      .optional()
      .describe("Optional GitHub PAT; if omitted uses the installed GitHub App"),
  })
  .describe("Body for listing the authenticated user's GitHub repos");
const validateRepoSchema = z
  .object({
    repoUrl: z.string().min(1),
    token: z.string().optional(),
  })
  .describe("Body for validating access to a specific repo URL");

const ValidationResultSchema = z
  .object({
    valid: z.boolean(),
    error: z.string().optional(),
    user: z.object({ login: z.string(), name: z.string() }).optional(),
  })
  .passthrough()
  .describe("Result of an upstream credential probe");

const SetupStatusResponseSchema = z
  .object({
    isSetUp: z.boolean(),
    steps: z.record(z.object({ done: z.boolean(), label: z.string() })),
  })
  .describe("Initial setup progress summary");

const ReposListResponseSchema = z
  .object({
    repos: z.array(z.unknown()),
    error: z.string().optional(),
  })
  .describe("List of the authenticated user's repos, from the git provider");

const SETUP_POST_RATE_LIMIT = {
  max: 5,
  timeWindow: "15 minutes",
};

const SETUP_STATUS_RATE_LIMIT = {
  max: 20,
  timeWindow: "1 minute",
};

const requireAdminWhenAuthenticated = async (req: FastifyRequest, reply: FastifyReply) => {
  if (isAuthDisabled()) return;
  if (!req.user) return;
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

export async function setupRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/setup/status",
    {
      config: { rateLimit: SETUP_STATUS_RATE_LIMIT },
      schema: {
        operationId: "getSetupStatus",
        summary: "Get initial setup status",
        description:
          "Return whether Optio has completed its initial setup, plus a " +
          "per-step breakdown (container runtime, git token, agent API keys, " +
          "etc.). This endpoint is public — the frontend polls it to decide " +
          "whether to show the setup wizard.",
        tags: ["Setup & Settings"],
        security: [],
        response: { 200: SetupStatusResponseSchema },
      },
    },
    async (_req, reply) => {
      const secrets = await listSecrets();
      const secretNames = secrets.map((s) => s.name);

      // This endpoint is public (no req.user) so it cannot decrypt
      // workspace-scoped secrets: the AAD binding (`name|scope|workspaceId`,
      // see #319) requires the caller's workspaceId. Inferring mode from the
      // set of stored secret names avoids that read-after-write asymmetry.
      const hasAnthropicKey = secretNames.includes("ANTHROPIC_API_KEY");
      const hasOpenAIKey = secretNames.includes("OPENAI_API_KEY");
      const hasGitToken =
        secretNames.includes("GITHUB_TOKEN") ||
        isGitHubAppConfigured() ||
        secretNames.includes("GITLAB_TOKEN");

      const usingSubscription = isSubscriptionAvailable();
      const hasOauthToken = secretNames.includes("CLAUDE_CODE_OAUTH_TOKEN");
      // Claude Vertex AI is detected by Claude-specific GCP project secret
      const hasClaudeVertexAi = secretNames.includes("CLAUDE_VERTEX_PROJECT_ID");

      const hasCodexAppServer = secretNames.includes("CODEX_APP_SERVER_URL");

      const hasCopilotToken = secretNames.includes("COPILOT_GITHUB_TOKEN");

      const hasOpencodeBaseUrl = secretNames.includes("OPENCODE_DEFAULT_BASE_URL");
      const opencodeConfigured = hasAnthropicKey || hasOpenAIKey || hasOpencodeBaseUrl;

      const hasGeminiKey = secretNames.includes("GEMINI_API_KEY");
      // Vertex AI mode is signaled by GOOGLE_CLOUD_PROJECT (written by the
      // wizard alongside GEMINI_AUTH_MODE="vertex-ai") — distinct from API
      // key mode.
      const hasGeminiVertexAi = secretNames.includes("GOOGLE_CLOUD_PROJECT");

      const hasAnyAgentKey =
        hasAnthropicKey ||
        hasOpenAIKey ||
        usingSubscription ||
        hasOauthToken ||
        hasClaudeVertexAi ||
        hasCodexAppServer ||
        hasCopilotToken ||
        hasGeminiKey ||
        hasGeminiVertexAi ||
        hasOpencodeBaseUrl;

      let runtimeHealthy = false;
      try {
        runtimeHealthy = await checkRuntimeHealth();
      } catch {
        /* non-critical */
      }

      // Runtime health is a separate step for the wizard; it must not gate
      // isSetUp, or a container-runtime blip traps users in the wizard.
      const isSetUp = hasAnyAgentKey && hasGitToken;

      reply.send({
        isSetUp,
        steps: {
          runtime: { done: runtimeHealthy, label: "Container runtime" },
          gitToken: { done: hasGitToken, label: "Git provider token" },
          anthropicKey: {
            done: hasAnthropicKey || usingSubscription || hasOauthToken || hasClaudeVertexAi,
            label: "Claude credentials",
          },
          openaiKey: { done: hasOpenAIKey, label: "OpenAI API key" },
          codexAppServer: { done: hasCodexAppServer, label: "Codex app-server" },
          copilotToken: { done: hasCopilotToken, label: "GitHub Copilot token" },
          opencodeConfigured: {
            done: opencodeConfigured,
            label: "OpenCode configured",
          },
          geminiKey: { done: hasGeminiKey || hasGeminiVertexAi, label: "Google Gemini API key" },
          anyAgentKey: { done: hasAnyAgentKey, label: "At least one agent API key" },
        },
      });
    },
  );

  app.post(
    "/api/setup/validate/github-token",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
      schema: {
        operationId: "validateGitHubToken",
        summary: "Validate a GitHub personal access token",
        description:
          "Probe `api.github.com/user` with the provided token to verify it " +
          "works. Rate limited to 5/15min per IP. Publicly accessible during " +
          "initial setup, admin-only afterward.",
        tags: ["Setup & Settings"],
        body: tokenSchema,
        response: { 200: ValidationResultSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { token } = req.body;

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

  app.post(
    "/api/setup/validate/gitlab-token",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
      schema: {
        operationId: "validateGitLabToken",
        summary: "Validate a GitLab token",
        description: "Probe GitLab's /user endpoint with the provided token and optional host.",
        tags: ["Setup & Settings"],
        body: gitlabTokenSchema,
        response: { 200: ValidationResultSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { token, host } = req.body;
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

  app.post(
    "/api/setup/validate/aws-credentials",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
      schema: {
        operationId: "validateAwsCredentials",
        summary: "Validate AWS credentials for CodeCommit",
        description:
          "Confirms the supplied AWS credentials by calling sts:GetCallerIdentity " +
          "and codecommit:ListRepositories in the given region.",
        tags: ["Setup & Settings"],
        body: awsCredentialsSchema,
        response: { 200: ValidationResultSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { accessKeyId, secretAccessKey, sessionToken, region } = req.body;
      try {
        const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
        const { CodeCommitClient: CC, ListRepositoriesCommand } =
          await import("@aws-sdk/client-codecommit");
        const credentials = {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken ? { sessionToken } : {}),
        };
        const sts = new STSClient({ region, credentials });
        const id = await sts.send(new GetCallerIdentityCommand({}));
        const cc = new CC({ region, credentials });
        await cc.send(new ListRepositoriesCommand({}));
        reply.send({
          valid: true,
          user: {
            login: id.Arn ?? "aws",
            name: id.Account ? `AWS account ${id.Account}` : "AWS",
          },
        });
      } catch (err) {
        app.log.error(err, "AWS credential validation failed");
        reply.send({ valid: false, error: sanitizeError(err) });
      }
    },
  );

  app.post(
    "/api/setup/repos/codecommit",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
      schema: {
        operationId: "listSetupCodeCommitRepos",
        summary: "List CodeCommit repositories for setup",
        description: "List CodeCommit repos in the given region accessible to the supplied creds.",
        tags: ["Setup & Settings"],
        body: awsCredentialsSchema,
        response: { 200: ReposListResponseSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { accessKeyId, secretAccessKey, sessionToken, region } = req.body;
      try {
        const {
          CodeCommitClient: CC,
          ListRepositoriesCommand,
          GetRepositoryCommand,
        } = await import("@aws-sdk/client-codecommit");
        const credentials = {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken ? { sessionToken } : {}),
        };
        const cc = new CC({ region, credentials });
        const list = await cc.send(new ListRepositoriesCommand({}));
        const names = (list.repositories ?? []).map((r) => r.repositoryName).filter(Boolean) as
          | string[]
          | [];
        const details = await Promise.all(
          names.slice(0, 50).map((name) =>
            cc
              .send(new GetRepositoryCommand({ repositoryName: name }))
              .then((d) => d.repositoryMetadata)
              .catch(() => null),
          ),
        );
        const repos = details
          .filter((d): d is NonNullable<typeof d> => Boolean(d))
          .map((d) => ({
            fullName: d.repositoryName ?? "",
            cloneUrl:
              d.cloneUrlHttp ??
              `https://git-codecommit.${region}.amazonaws.com/v1/repos/${d.repositoryName}`,
            htmlUrl: `https://${region}.console.aws.amazon.com/codesuite/codecommit/repositories/${d.repositoryName}/browse`,
            defaultBranch: d.defaultBranch ?? "main",
            isPrivate: true,
            description: d.repositoryDescription ?? null,
            language: null,
            pushedAt: d.lastModifiedDate ? new Date(d.lastModifiedDate).toISOString() : "",
          }));
        reply.send({ repos });
      } catch (err) {
        app.log.error(err, "CodeCommit repo listing failed");
        reply.send({ repos: [], error: sanitizeError(err) });
      }
    },
  );

  app.post(
    "/api/setup/validate/anthropic-key",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
      schema: {
        operationId: "validateAnthropicKey",
        summary: "Validate an Anthropic API key",
        description: "Probe Anthropic's /v1/models endpoint with the provided key.",
        tags: ["Setup & Settings"],
        body: keySchema,
        response: { 200: ValidationResultSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { key } = req.body;

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

  app.post(
    "/api/setup/validate/copilot-token",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
      schema: {
        operationId: "validateCopilotToken",
        summary: "Validate a GitHub Copilot token",
        description:
          "Probe GitHub's /user endpoint with the provided token. Classic " +
          "PATs (`ghp_*`) are rejected — Copilot CLI requires a fine-grained PAT.",
        tags: ["Setup & Settings"],
        body: tokenSchema,
        response: { 200: ValidationResultSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { token } = req.body;

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

  app.post(
    "/api/setup/validate/openai-key",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
      schema: {
        operationId: "validateOpenAIKey",
        summary: "Validate an OpenAI API key",
        description: "Probe OpenAI's /v1/models endpoint with the provided key.",
        tags: ["Setup & Settings"],
        body: keySchema,
        response: { 200: ValidationResultSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { key } = req.body;

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

  app.post(
    "/api/setup/validate/gemini-key",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
      schema: {
        operationId: "validateGeminiKey",
        summary: "Validate a Google Gemini API key",
        description: "Probe Google's generativelanguage API with the provided key.",
        tags: ["Setup & Settings"],
        body: keySchema,
        response: { 200: ValidationResultSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { key } = req.body;

      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
        );
        if (res.ok) {
          reply.send({ valid: true });
        } else {
          const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          reply.send({ valid: false, error: body.error?.message ?? `API returned ${res.status}` });
        }
      } catch (err) {
        app.log.error(err, "Gemini key validation failed");
        reply.send({ valid: false, error: sanitizeError(err) });
      }
    },
  );

  app.post(
    "/api/setup/repos",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
      schema: {
        operationId: "listSetupGitHubRepos",
        summary: "List GitHub repos available for setup",
        description:
          "List the authenticated user's recent GitHub repos, used by the " +
          "setup wizard's repo picker. If no token is supplied, falls back " +
          "to the GitHub App installation token.",
        tags: ["Setup & Settings"],
        body: reposBodySchema,
        response: { 200: ReposListResponseSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const token = req.body.token;

      let effectiveToken = token || null;
      if (!effectiveToken && isGitHubAppConfigured()) {
        try {
          effectiveToken = await getInstallationToken();
        } catch {
          return reply.send({ repos: [], error: "Failed to get GitHub App token" });
        }
      }
      if (!effectiveToken) {
        return reply.status(400).send({ error: "Token is required" });
      }

      try {
        const headers = { Authorization: `Bearer ${effectiveToken}`, "User-Agent": "Optio" };

        const apiUrl = token
          ? "https://api.github.com/user/repos?sort=pushed&direction=desc&per_page=20&affiliation=owner,collaborator,organization_member"
          : "https://api.github.com/installation/repositories?sort=pushed&direction=desc&per_page=20";
        const res = await fetch(apiUrl, { headers });
        if (!res.ok) {
          return reply.send({ repos: [], error: `GitHub returned ${res.status}` });
        }

        type RepoItem = {
          full_name: string;
          html_url: string;
          clone_url: string;
          default_branch: string;
          private: boolean;
          description: string | null;
          language: string | null;
          pushed_at: string;
        };

        const json = (await res.json()) as RepoItem[] | { repositories: RepoItem[] };
        const data: RepoItem[] = Array.isArray(json) ? json : json.repositories;

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

  app.post(
    "/api/setup/repos/gitlab",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
      schema: {
        operationId: "listSetupGitLabRepos",
        summary: "List GitLab projects available for setup",
        description: "List GitLab projects accessible to the provided token.",
        tags: ["Setup & Settings"],
        body: gitlabTokenSchema,
        response: { 200: ReposListResponseSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { token, host } = req.body;
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

  app.post(
    "/api/setup/validate/repo",
    {
      config: { rateLimit: SETUP_POST_RATE_LIMIT },
      preHandler: [requireAdminWhenAuthenticated],
      schema: {
        operationId: "validateRepoAccess",
        summary: "Validate access to a specific repo",
        description:
          "Check whether Optio can access a given GitHub repo URL using the " +
          "supplied token (or the configured GitHub App).",
        tags: ["Setup & Settings"],
        body: validateRepoSchema,
        response: { 200: ValidationResultSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { repoUrl, token } = req.body;

      try {
        const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
        if (!match) {
          return reply.send({ valid: false, error: "Could not parse GitHub repo from URL" });
        }
        const [, owner, repo] = match;
        const headers: Record<string, string> = { "User-Agent": "Optio" };
        let repoToken: string | null = token ?? null;
        if (!repoToken) repoToken = await retrieveSecret("GITHUB_TOKEN").catch(() => null);
        if (!repoToken && isGitHubAppConfigured()) {
          repoToken = await getInstallationToken().catch(() => null);
        }
        if (repoToken) headers["Authorization"] = `Bearer ${repoToken}`;

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
