import {
  listGitLabInstances,
  refreshGitLabInstances,
} from "../services/gitlab-instance-service.js";
import { runtimeGitLabInstance } from "../services/gitlab-instance-runtime.js";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as repoService from "../services/repo-service.js";
import {
  validateCpuQuantity,
  validateMemoryQuantity,
  validateRequestLimitPair,
  parseCpuMillicores,
  parseMemoryMi,
  AGENT_TYPES,
  autoMergeStamp,
  requireAutoMergeConfirmation,
  currentFeatures,
  featureAllows,
  parseRepoUrl,
  resolveRepoPlatform,
  type GitPlatformType,
  type PlatformLocation,
} from "@optio/shared";
import { modelBelongsToAgent } from "../services/agent-options-service.js";
import { requireRole } from "../plugins/auth.js";
import { getGitHubToken } from "../services/github-token-service.js";
import { getGitPlatformForRepo, getGitToken } from "../services/git-token-service.js";
import { createGitPlatform } from "../services/git-platform/index.js";
import { retrieveSecretWithFallback } from "../services/secret-service.js";
import {
  ensureRepoWebhook,
  removeRepoWebhook,
  repoWebhooksFor,
} from "../services/repo-webhook-service.js";
import { platformRefusal, refineFeature } from "../services/feature-guard.js";
import { browseGitHubRepos } from "../services/github-repo-browse-service.js";
import { isSsrfSafeUrl } from "../utils/ssrf.js";
import { logAction } from "../services/optio-action-service.js";
import { auditAutoMergeSetting } from "../services/audit.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { RepoSchema } from "../schemas/integration.js";
import { resolveReviewConfig } from "../services/review-config.js";
import * as optioSettingsService from "../services/optio-settings-service.js";
import { withManagedBy } from "../services/config/managed.js";
import {
  ImagePresetUnavailableError,
  availablePresets,
  presetAvailable,
} from "../services/image-presets.js";
import { mergeConfirmationRequired } from "../services/deployment-settings.js";

const createRepoSchema = z
  .object({
    repoUrl: z.string().min(1).describe("Repository URL (http/https)"),
    fullName: z.string().min(1).describe("owner/repo slug"),
    defaultBranch: z.string().optional().describe("Default branch name (e.g. `main`)"),
    isPrivate: z.boolean().optional(),
    gitPlatform: z
      .enum(["github", "gitlab", "codecommit"])
      .optional()
      .describe(
        "The repository's git platform, for a host Optio cannot tell from the URL " +
          "(a self-hosted GitLab). A known host's own platform wins.",
      ),
  })
  .describe("Body for adding a repository to Optio");

const updateRepoSchema = z
  .object({
    imagePreset: z.string().optional(),
    extraPackages: z.string().optional(),
    setupCommands: z.string().optional(),
    customDockerfile: z.string().nullable().optional(),
    autoMerge: z
      .boolean()
      .optional()
      .describe("Merge PRs by itself; turning it on needs `autoMergeConfirmed: true`"),
    autoMergeConfirmed: z
      .boolean()
      .optional()
      .describe("The person ticked the checkbox AND accepted the confirmation dialog"),
    cautiousMode: z.boolean().optional(),
    defaultAgentType: z
      .enum([...AGENT_TYPES] as [string, ...string[]])
      // A runtime the deployment leaves out is refused (OPTIO_RUNTIMES, config/features.ts).
      .superRefine(refineFeature("runtimes"))
      .optional(),
    promptTemplateOverride: z.string().nullable().optional(),
    defaultBranch: z.string().optional(),
    claudeModel: z.string().optional(),
    claudeContextWindow: z.string().optional(),
    claudeThinking: z
      .boolean()
      .optional()
      .describe("Deprecated and ignored: Claude Code always thinks (its default)"),
    claudeEffort: z.string().optional(),
    copilotModel: z.string().optional(),
    copilotEffort: z.string().optional(),
    opencodeModel: z.string().optional(),
    opencodeAgent: z.string().optional(),
    opencodeProvider: z.string().optional(),
    opencodeBaseUrl: z.string().url().nullable().optional(),
    geminiModel: z.string().optional(),
    geminiApprovalMode: z.string().optional(),
    openclawModel: z.string().nullable().optional(),
    openclawAgent: z.string().nullable().optional(),
    cursorModel: z.string().nullable().optional(),
    maxTurnsCoding: z.number().int().min(1).max(10000).optional(),
    maxTurnsReview: z.number().int().min(1).max(10000).optional(),
    autoResume: z.boolean().optional(),
    planningModeEnabled: z.boolean().optional(),
    maxConcurrentTasks: z.number().int().min(1).max(50).optional(),
    maxPodInstances: z.number().int().min(1).max(20).optional(),
    maxAgentsPerPod: z.number().int().min(1).max(50).optional(),
    reviewEnabled: z.boolean().optional(),
    reviewTrigger: z.string().optional(),
    reviewPromptTemplate: z
      .string()
      .nullable()
      .optional()
      .describe("The repo's own review prompt. Null = the workspace's, else the built-in"),
    reviewDepth: z
      .enum(["thorough", "light"])
      .nullable()
      .optional()
      .describe(
        "How deep reviews go: thorough (context and tests) or light (the diff, top " +
          "findings, half the turns). Null = the workspace's default",
      ),
    testCommand: z.string().optional(),
    reviewAgentType: z
      .enum([...AGENT_TYPES] as [string, ...string[]])
      .superRefine(refineFeature("runtimes"))
      .nullable()
      .optional()
      .describe("Override the agent used for code reviews. Null = inherit."),
    reviewModel: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Model for code reviews. Null = inherit: the global default review model, " +
          "else the review agent's catalog default.",
      ),
    externalReviewMode: z.enum(["off", "on_request", "on_pr_hold", "on_pr_post"]).optional(),
    externalReviewFilters: z
      .object({
        skipDrafts: z.boolean().optional(),
        skipOptioAuthored: z.boolean().optional(),
        includeAuthors: z.array(z.string()).optional(),
        excludeAuthors: z.array(z.string()).optional(),
        includeLabels: z.array(z.string()).optional(),
        excludeLabels: z.array(z.string()).optional(),
      })
      .nullable()
      .optional(),
    externalReviewWaitForCi: z.boolean().optional(),
    maxAutoResumes: z.number().int().min(1).max(100).nullable().optional(),
    slackWebhookUrl: z
      .string()
      .url()
      .refine(isSsrfSafeUrl, "Slack webhook URL must not target private/internal addresses")
      .nullable()
      .optional(),
    slackChannel: z.string().nullable().optional(),
    slackNotifyOn: z
      .array(z.enum(["completed", "failed", "needs_attention", "pr_opened"]))
      .optional(),
    slackEnabled: z.boolean().optional(),
    networkPolicy: z.enum(["unrestricted", "restricted"]).optional(),
    secretProxy: z.boolean().optional(),
    offPeakOnly: z.boolean().optional(),
    cpuRequest: z.string().nullable().optional(),
    cpuLimit: z.string().nullable().optional(),
    memoryRequest: z.string().nullable().optional(),
    memoryLimit: z.string().nullable().optional(),
    dockerInDocker: z.boolean().optional(),
  })
  .describe("Partial update to a repository configuration");

const RepoListResponseSchema = z.object({ repos: z.array(RepoSchema) });
const RepoResponseSchema = z.object({ repo: RepoSchema });
const BrowseQuerySchema = z
  .object({
    q: z.string().max(200).optional().describe("Filter by owner/name or description"),
    page: z.coerce.number().int().min(1).max(1000).optional().default(1),
    perPage: z.coerce.number().int().min(1).max(100).optional().default(30),
  })
  .describe("Search + paging for the accessible-repos picker");

const BrowseResponseSchema = z
  .object({
    repos: z.array(
      z.object({
        fullName: z.string(),
        cloneUrl: z.string(),
        htmlUrl: z.string(),
        defaultBranch: z.string(),
        isPrivate: z.boolean(),
        description: z.string().nullable(),
        pushedAt: z.string().nullable(),
      }),
    ),
    page: z.number(),
    perPage: z.number(),
    hasMore: z.boolean(),
    truncated: z.boolean().optional(),
    error: z.string().optional(),
  })
  .describe("GitHub repositories the server's credentials can access");

const RepoBrowseQuerySchema = z
  .object({
    q: z.string().max(200).optional().describe("Filter by path, name or description"),
    instance: z.string().max(2048).optional().describe("A configured GitLab instance base URL"),
    platform: z
      .enum(["github", "gitlab", "codecommit"])
      .optional()
      .describe(
        "The git platform to list; default the deployment's first (OPTIO_GIT_PLATFORMS; github unless narrowed)",
      ),
  })
  .describe("Search for the platform-neutral Add repository picker");

const RepoBrowseResponseSchema = z
  .object({
    repos: BrowseResponseSchema.shape.repos,
    platform: z.enum(["github", "gitlab", "codecommit"]),
    host: z.string().nullable().describe("The platform host that was listed"),
    error: z.string().optional().describe("Why the list is empty; a pasted URL still works"),
  })
  .describe("Repositories the person's (else the organization's) git credentials can access");

/**
 * Where `GET /api/repos/browse` lists a platform. GitLab: the GITLAB_HOST
 * secret the setup wizard saves, else the first self-managed host in
 * GITLAB_HOSTS, else the host of a GitLab repo the workspace already has,
 * else gitlab.com.
 */
async function browseLocation(
  platform: GitPlatformType,
  workspaceId: string | null,
): Promise<PlatformLocation> {
  if (platform === "github") return { host: "github.com", apiBaseUrl: "https://api.github.com" };
  let host = await retrieveSecretWithFallback("GITLAB_HOST", "global", workspaceId).catch(() => "");
  if (!host) {
    const env = process.env.GITLAB_HOSTS ?? process.env.OPTIO_GITLAB_HOSTS ?? "";
    host =
      env
        .split(",")
        .map((h) => h.trim())
        .find((h) => h && h.toLowerCase() !== "gitlab.com") ?? "";
  }
  if (!host) {
    const repos = await repoService.listRepos(workspaceId).catch(() => []);
    const gitlab = repos.find((r: { gitPlatform?: string | null }) => r.gitPlatform === "gitlab");
    if (gitlab) host = parseRepoUrl(gitlab.repoUrl)?.host ?? "";
  }
  host = (host || "gitlab.com").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return { host, apiBaseUrl: `https://${host}/api/v4` };
}

const DetectResponseSchema = z.object({ detected: z.unknown() });

const RepoWebhookResponseSchema = z
  .object({
    webhook: z.object({
      hookId: z.string().nullable().describe("The hook's id on GitLab; null = never created"),
      url: z.string().nullable().describe("The receiver URL the hook points at"),
      syncedAt: z.date().nullable().describe("When the hook was last brought up to date"),
      error: z.string().nullable().describe("Why the last attempt failed; null = fine"),
    }),
  })
  .describe("The project webhook Optio keeps on a GitLab repo");

const BranchesQuerySchema = z
  .object({
    q: z.string().max(200).optional().describe("Only branches whose name contains this"),
    limit: z.coerce.number().int().min(1).max(100).optional().default(30),
  })
  .describe("Search for the branch picker");

const BranchesResponseSchema = z
  .object({
    branches: z.array(
      z.object({
        name: z.string(),
        default: z.boolean().describe("The repo's default branch"),
        protected: z.boolean().optional(),
      }),
    ),
    defaultBranch: z.string().nullable().describe("The branch the repo is configured with"),
    error: z
      .string()
      .optional()
      .describe(
        "Why the list is empty (no credentials, the platform refused); a typed name still works",
      ),
  })
  .describe("Branches of a repository, the default branch first");

export async function repoRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/repos/github/accessible",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "browseAccessibleGitHubRepos",
        summary: "Browse GitHub repos the server can access",
        description:
          "List the GitHub repositories reachable with the server's stored " +
          "credentials (GitHub App installation, else the GITHUB_TOKEN PAT, " +
          "including organization repos), for the Add repository picker. " +
          "`q` filters by owner/name or description. Requires `member` role.",
        tags: ["Repos & Integrations"],
        querystring: BrowseQuerySchema,
        response: { 200: BrowseResponseSchema },
      },
    },
    async (req, reply) => {
      const { q, page, perPage } = req.query;
      let token: string;
      try {
        token = await getGitHubToken({ server: true, workspaceId: req.user?.workspaceId ?? null });
      } catch {
        return reply.send({
          repos: [],
          page,
          perPage,
          hasMore: false,
          error: "No GitHub credentials configured — add a GITHUB_TOKEN secret or a GitHub App.",
        });
      }
      try {
        const result = await browseGitHubRepos(token, { q, page, perPage });
        reply.send({ ...result, page, perPage });
      } catch (err) {
        req.log.warn({ err }, "Browsing accessible GitHub repos failed");
        reply.send({
          repos: [],
          page,
          perPage,
          hasMore: false,
          error: err instanceof Error ? err.message : "Failed to list repositories",
        });
      }
    },
  );

  app.get(
    "/api/repos/browse",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "browseAccessibleRepos",
        summary: "Browse repos the git credentials can access",
        description:
          "List the repositories on a git platform the person's own token (else " +
          "the organization's) can reach, for the Add repository picker: GitLab " +
          "projects the token is a member of (`/projects?membership=true`), GitHub " +
          "repos as `/api/repos/github/accessible` lists them. `q` searches " +
          "server-side. A platform the deployment does not offer is " +
          "refused. Requires `member` role.",
        tags: ["Repos & Integrations"],
        querystring: RepoBrowseQuerySchema,
        response: { 200: RepoBrowseResponseSchema },
      },
    },
    async (req, reply) => {
      const platform: GitPlatformType =
        req.query.platform ?? (currentFeatures().gitPlatforms[0] as GitPlatformType);
      if (!featureAllows("gitPlatforms", platform)) {
        return reply.send({
          repos: [],
          platform,
          host: null,
          error: `This deployment does not offer ${platform} repositories.`,
        });
      }
      const workspaceId = req.user?.workspaceId ?? null;
      await refreshGitLabInstances().catch(() => {});
      let at = await browseLocation(platform, workspaceId);
      if (platform === "gitlab") {
        const instances = req.query.instance ? await listGitLabInstances() : [];
        const { gitLabInstanceUrls } = await import("@optio/shared");
        const preferred = gitLabInstanceUrls()[0];
        const instance = req.query.instance
          ? (instances.find((i) => i.baseUrl === req.query.instance) ??
            (req.query.instance === "https://gitlab.com"
              ? { baseUrl: req.query.instance }
              : undefined))
          : preferred
            ? { baseUrl: preferred }
            : undefined;
        if (req.query.instance && !instance)
          return reply.send({ repos: [], platform, host: null, error: "Unknown GitLab instance" });
        if (instance)
          at = { host: new URL(instance.baseUrl).host, apiBaseUrl: `${instance.baseUrl}/api/v4` };
        else {
          const configured = runtimeGitLabInstance(at.host);
          if (configured) at.apiBaseUrl = `${configured.baseUrl}/api/v4`;
        }
      }
      let token: string;
      try {
        token = await getGitToken(
          platform,
          platform === "github"
            ? { server: true, workspaceId }
            : { userId: req.user?.id, workspaceId, host: at.host },
        );
      } catch {
        return reply.send({
          repos: [],
          platform,
          host: at.host,
          error:
            platform === "gitlab"
              ? "No GitLab token — add your own GITLAB_TOKEN under Settings, or ask an admin for the organization's."
              : `No ${platform} credentials configured.`,
        });
      }
      const git = createGitPlatform(platform, token);
      if (!git.browseRepositories) {
        return reply.send({
          repos: [],
          platform,
          host: at.host,
          error: `Listing ${platform} repositories is not supported — paste the URL instead.`,
        });
      }
      try {
        const repos = await git.browseRepositories(req.query.q ?? "", at, { perPage: 50 });
        reply.send({ repos, platform, host: at.host });
      } catch (err) {
        req.log.warn({ err, platform, host: at.host }, "Browsing accessible repos failed");
        reply.send({
          repos: [],
          platform,
          host: at.host,
          error: err instanceof Error ? err.message : "Failed to list repositories",
        });
      }
    },
  );

  app.get(
    "/api/repos",
    {
      schema: {
        operationId: "listRepos",
        summary: "List repositories",
        description: "Return all repositories configured in the current workspace.",
        tags: ["Repos & Integrations"],
        response: { 200: RepoListResponseSchema },
      },
    },
    async (req, reply) => {
      const workspaceId = req.user?.workspaceId ?? null;
      const repos = await repoService.listRepos(workspaceId);
      reply.send({ repos: await withManagedBy(repos, "repos") });
    },
  );

  app.get(
    "/api/repos/:id",
    {
      schema: {
        operationId: "getRepo",
        summary: "Get a repository",
        description: "Fetch a single repository by ID, scoped to the current workspace.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: RepoResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const repo = await repoService.getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && repo.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }

      // Compute the effective review agent + model so the UI can show
      // "Inherit from repo default → gemini · gemini-2.5-pro" hints when
      // the per-repo overrides are unset. Errors here are non-fatal — the
      // UI can fall back to the raw stored values.
      const globalSettings = await optioSettingsService
        .getSettings(repo.workspaceId ?? null)
        .catch(() => null);
      const resolved = resolveReviewConfig({
        repoReviewAgentType: repo.reviewAgentType ?? null,
        repoDefaultAgentType: repo.defaultAgentType ?? null,
        repoReviewModel: repo.reviewModel ?? null,
        globalDefaultReviewAgentType: globalSettings?.defaultReviewAgentType ?? null,
        globalDefaultReviewModel: globalSettings?.defaultReviewModel ?? null,
      });

      reply.send({
        repo: {
          ...repo,
          effectiveReviewAgentType: resolved.agentType,
          effectiveReviewModel: resolved.model,
          // "Confirmed on <date> by <name>" next to the auto-merge checkbox.
          autoMergeConfirmedByName: repo.autoMergeConfirmedAt
            ? await repoService.autoMergeConfirmerName(repo.autoMergeConfirmedBy).catch(() => null)
            : null,
        },
      });
    },
  );

  app.get(
    "/api/repos/:id/branches",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "listRepoBranches",
        summary: "List a repository's branches",
        description:
          "The branches of a configured repository from its git platform " +
          "(GitHub, GitLab or CodeCommit), the default branch first, narrowed " +
          "by `q` (a name that contains it). For the branch picker in the New " +
          "work form. When the platform cannot be asked (no credentials, an " +
          "error) the list is empty and `error` says why, so a typed branch " +
          "name still goes through. Requires `member` role.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        querystring: BranchesQuerySchema,
        response: { 200: BranchesResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { q, limit } = req.query;
      const repo = await repoService.getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && repo.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }
      const defaultBranch = repo.defaultBranch ?? null;
      try {
        const { platform, ri } = await getGitPlatformForRepo(repo.repoUrl, {
          server: true,
          workspaceId: repo.workspaceId ?? wsId ?? null,
          platformHint: (repo.gitPlatform as GitPlatformType | undefined) ?? undefined,
        });
        const branches = await platform.listBranches(ri, {
          search: q?.trim() || undefined,
          perPage: limit,
        });
        reply.send({ branches, defaultBranch });
      } catch (err) {
        req.log.warn({ err, repoId: id }, "Listing repo branches failed");
        reply.send({
          branches: [],
          defaultBranch,
          error: err instanceof Error ? err.message : "Failed to list branches",
        });
      }
    },
  );

  app.post(
    "/api/repos",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "createRepo",
        summary: "Add a repository",
        description:
          "Register a new repository with Optio. After creation, an auto-detect " +
          "step populates sensible defaults for image preset and test command " +
          "based on the repo's language/build system. A git platform the " +
          "deployment does not offer (OPTIO_GIT_PLATFORMS) is refused. Requires `admin` role.",
        tags: ["Repos & Integrations"],
        body: createRepoSchema,
        response: {
          201: RepoResponseSchema,
          400: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body;
      const workspaceId = req.user?.workspaceId ?? null;

      // A git platform the deployment leaves out (OPTIO_GIT_PLATFORMS).
      const refusal = platformRefusal(
        resolveRepoPlatform(body.repoUrl, body.gitPlatform) ?? undefined,
      );
      if (refusal) return reply.status(400).send({ error: refusal });

      const existing = await repoService.getRepoByUrl(body.repoUrl, workspaceId);
      if (existing) {
        return reply.status(409).send({ error: "This repository has already been added" });
      }

      const repo = await repoService.createRepo({
        ...body,
        workspaceId,
      });

      try {
        const { detectRepoConfig } = await import("../services/repo-detect-service.js");
        // detectRepoConfig reads through the repo's own platform (GitLab's
        // token for a GitLab repo); only a GitHub repo waits on a GitHub token.
        const githubToken =
          repo.gitPlatform === "github"
            ? await getGitHubToken({ userId: req.user!.id }).catch(() => null)
            : null;
        if (githubToken || repo.gitPlatform !== "github") {
          const detected = await detectRepoConfig(body.repoUrl, githubToken ?? "");
          // A detected preset this deployment doesn't have stays on base.
          const imagePreset = presetAvailable(detected.imagePreset) ? detected.imagePreset : "base";
          if (imagePreset !== "base" || detected.testCommand) {
            await repoService.updateRepo(repo.id, {
              imagePreset,
              testCommand: detected.testCommand,
            });
          }
        }
      } catch {
        /* non-critical */
      }

      // A repo whose platform gets Optio's webhook (GitLab by default,
      // GitHub when OPTIO_REPO_WEBHOOKS names it) gets it now, after the
      // reply: the outcome lands on the repo row and the repo page shows it.
      if (repoWebhooksFor(repo.gitPlatform)) {
        ensureRepoWebhook(repo, { userId: req.user?.id ?? null }).catch(() => {});
      }

      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "repo.create",
        params: { repoUrl: body.repoUrl, fullName: body.fullName },
        result: { id: repo.id },
        success: true,
      }).catch(() => {});
      reply.status(201).send({ repo });
    },
  );

  app.patch(
    "/api/repos/:id",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "updateRepo",
        summary: "Update a repository",
        description:
          "Partial update to a repository's configuration. K8s resource " +
          "requests/limits are validated; mismatched requests > limits " +
          "return 400. Slack webhook URLs are SSRF-guarded. Requires " +
          "`admin` role.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: updateRepoSchema,
        response: {
          200: RepoResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await repoService.getRepo(id);
      if (!existing) return reply.status(404).send({ error: "Repo not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }
      const { autoMergeConfirmed, ...body } = req.body;
      // The checkbox AND the dialog, when the deployment asks for both
      // (shared work/auto-merge.ts).
      const unconfirmed = requireAutoMergeConfirmation(
        { autoMerge: body.autoMerge, autoMergeConfirmed },
        existing,
        await mergeConfirmationRequired(),
      );
      if (unconfirmed) return reply.status(400).send({ error: unconfirmed });

      const resourceErrors: string[] = [];
      if (body.cpuRequest) {
        const r = validateCpuQuantity(body.cpuRequest);
        if (!r.valid) resourceErrors.push(r.error!);
      }
      if (body.cpuLimit) {
        const r = validateCpuQuantity(body.cpuLimit);
        if (!r.valid) resourceErrors.push(r.error!);
      }
      if (body.memoryRequest) {
        const r = validateMemoryQuantity(body.memoryRequest);
        if (!r.valid) resourceErrors.push(r.error!);
      }
      if (body.memoryLimit) {
        const r = validateMemoryQuantity(body.memoryLimit);
        if (!r.valid) resourceErrors.push(r.error!);
      }
      const cpuPair = validateRequestLimitPair(
        body.cpuRequest ?? existing.cpuRequest,
        body.cpuLimit ?? existing.cpuLimit,
        parseCpuMillicores,
        "CPU",
      );
      if (!cpuPair.valid) resourceErrors.push(cpuPair.error!);
      const memPair = validateRequestLimitPair(
        body.memoryRequest ?? existing.memoryRequest,
        body.memoryLimit ?? existing.memoryLimit,
        parseMemoryMi,
        "Memory",
      );
      if (!memPair.valid) resourceErrors.push(memPair.error!);
      if (resourceErrors.length > 0) {
        return reply.status(400).send({ error: resourceErrors.join(" ") });
      }
      // Only a preset whose image this deployment has (image-presets.ts).
      if (body.imagePreset && !presetAvailable(body.imagePreset)) {
        return reply.status(400).send({
          error: new ImagePresetUnavailableError(body.imagePreset, availablePresets()).message,
        });
      }

      // Reject reviewAgentType + reviewModel combinations where the model
      // belongs to a different agent's catalog (e.g. agent=gemini, model=sonnet).
      // A model the live list offers counts (#644). If only the agent changes,
      // the resolver picks the catalog default.
      const incomingReviewAgent = body.reviewAgentType ?? undefined;
      const incomingReviewModel = body.reviewModel;
      if (incomingReviewAgent && incomingReviewModel) {
        const known = await modelBelongsToAgent(incomingReviewAgent, incomingReviewModel, {
          workspaceId: req.user?.workspaceId ?? null,
        });
        if (!known) {
          return reply.status(400).send({
            error: `Review model "${incomingReviewModel}" does not belong to the "${incomingReviewAgent}" catalog.`,
          });
        }
      }

      const repo = await repoService.updateRepo(id, {
        ...body,
        ...autoMergeStamp({ autoMerge: body.autoMerge, autoMergeConfirmed }, req.user?.id ?? null),
      });
      if (!repo) return reply.status(404).send({ error: "Repo not found" });
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "repo.update",
        params: { repoId: id, ...body },
        result: { id },
        success: true,
      }).catch(() => {});
      void auditAutoMergeSetting(
        req,
        { autoMerge: body.autoMerge, autoMergeConfirmed },
        { type: "repo", id },
        existing,
      );
      reply.send({ repo: (await withManagedBy([repo], "repos"))[0] });
    },
  );

  app.delete(
    "/api/repos/:id",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "deleteRepo",
        summary: "Delete a repository",
        description:
          "Remove a repository from Optio. Does not delete associated " +
          "tasks or logs. Requires `admin` role.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 204: z.null(), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const existing = await repoService.getRepo(id);
      if (!existing) return reply.status(404).send({ error: "Repo not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && existing.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }
      // Best effort, after the reply: the hook Optio made comes off the project
      removeRepoWebhook(existing).catch(() => {});
      await repoService.deleteRepo(id);
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "repo.delete",
        params: { repoId: id, repoUrl: existing.repoUrl },
        result: { id },
        success: true,
      }).catch(() => {});
      reply.status(204).send(null);
    },
  );

  app.post(
    "/api/repos/:id/detect",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "detectRepoConfig",
        summary: "Auto-detect repo configuration",
        description:
          "Re-run the language / build-system detection for a repo and " +
          "persist the detected image preset + test command. Requires " +
          "`admin` role.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: {
          200: DetectResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const repo = await repoService.getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && repo.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }

      try {
        const { detectRepoConfig } = await import("../services/repo-detect-service.js");
        const githubToken = await getGitHubToken({ userId: req.user!.id });
        const detected = await detectRepoConfig(repo.repoUrl, githubToken);
        await repoService.updateRepo(id, {
          // A detected preset this deployment doesn't have stays on base.
          imagePreset: presetAvailable(detected.imagePreset) ? detected.imagePreset : "base",
          testCommand: detected.testCommand ?? undefined,
        });
        reply.send({ detected });
      } catch (err) {
        reply.status(500).send({ error: String(err) });
      }
    },
  );

  app.post(
    "/api/repos/:id/webhook",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "repairRepoWebhook",
        summary: "Create or repair a repo's webhook",
        description:
          "Make the project webhook that delivers this GitLab repo's push, " +
          "merge request, comment, issue, pipeline and release events to " +
          "Optio exist and point at this deployment, with the server's " +
          "GitLab token (a GitHub repo's, with its token, when " +
          "OPTIO_REPO_WEBHOOKS names GitHub and no GitHub App is configured). " +
          "Created when a repo is added; this re-runs it. The " +
          "outcome is stored on the repo (`webhookId`, `webhookUrl`, " +
          "`webhookSyncedAt`, `webhookError`) and returned; a failure is " +
          "reported in `error`, not as an HTTP error. Requires `admin` role.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: {
          200: RepoWebhookResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const repo = await repoService.getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && repo.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }
      if (!repoWebhooksFor(repo.gitPlatform)) {
        return reply
          .status(400)
          .send({ error: "Webhook registration is not enabled for this platform" });
      }
      const webhook = await ensureRepoWebhook(repo, { userId: req.user?.id ?? null });
      logAction({
        workspaceId: req.user?.workspaceId ?? null,
        userId: req.user?.id,
        action: "repo.webhook.repair",
        params: { repoId: id, repoUrl: repo.repoUrl },
        result: { hookId: webhook.hookId, error: webhook.error },
        success: !webhook.error,
      }).catch(() => {});
      reply.send({ webhook });
    },
  );
}
