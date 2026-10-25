import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getGitHubToken } from "../services/github-token-service.js";
import { isGitHubAppConfigured } from "../services/github-app-service.js";
import {
  getCredentialSecret,
  resetCredentialSecret,
} from "../services/credential-secret-service.js";
import { verifyInternalRequest, verifyHmacSignature } from "../services/hmac-auth-service.js";
import { parseGitCredentialScope, gitCredentialKey } from "../services/git-credential-scope.js";
import { ErrorResponseSchema } from "../schemas/common.js";

export { getCredentialSecret, resetCredentialSecret };

export function buildStatusResponse(): {
  configured: boolean;
  appId?: string;
  installationId?: string;
} {
  if (!isGitHubAppConfigured()) {
    return { configured: false };
  }
  return {
    configured: true,
    appId: process.env.GITHUB_APP_ID,
    installationId: process.env.GITHUB_APP_INSTALLATION_ID,
  };
}

const gitCredentialsQuerySchema = z
  .object({
    scope: z.string().max(1024).optional(),
    host: z
      .string()
      .max(253)
      .optional()
      .describe(
        "The git host asking (git's `host=`, with any port). A known GitLab host " +
          "gets the run owner's GitLab token for that host; github.com or none, " +
          "GitHub's.",
      ),
    taskId: z
      .string()
      .optional()
      .describe(
        "Optional task ID. With a taskId, returns the task creator's user token " +
          "(for task-scoped operations). Without, returns an installation token " +
          "(for pod-level operations like clone).",
      ),
  })
  .describe("Query parameters for internal git credentials endpoint");

const GitCredentialsResponseSchema = z
  .object({
    token: z.string(),
    username: z
      .string()
      .optional()
      .describe("The user name git sends with the token (GitLab: oauth2)"),
  })
  .describe("Git credential token for cloning or committing");

const GitHubAppStatusResponseSchema = z
  .object({
    configured: z.boolean(),
    appId: z.string().optional(),
    installationId: z.string().optional(),
  })
  .describe("GitHub App installation status");

/** git's `host=` value, lower-cased: `GitLab.Corp:8443` → `gitlab.corp:8443`. */
function normalizeGitHost(host: string | undefined): string {
  return (host ?? "").trim().toLowerCase();
}

/**
 * Whether a deployment named `host` as a GitLab: gitlab.com, `GITLAB_HOSTS`,
 * or the setup wizard's `GITLAB_HOST`. A port on either side is matched
 * with or without it.
 */
async function isKnownGitLabHost(host: string, workspaceId: string | null): Promise<boolean> {
  const { refreshGitLabInstances } = await import("../services/gitlab-instance-service.js");
  const { runtimeGitLabInstance } = await import("../services/gitlab-instance-runtime.js");
  await refreshGitLabInstances().catch(() => {});
  if (runtimeGitLabInstance(host)) return true;
  const bare = (h: string) => h.replace(/:\d+$/, "");
  const clean = (h: string) =>
    h
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
  const named = ["gitlab.com"];
  for (const h of (process.env.GITLAB_HOSTS ?? process.env.OPTIO_GITLAB_HOSTS ?? "").split(",")) {
    if (h.trim()) named.push(h);
  }
  const { retrieveSecretWithFallback } = await import("../services/secret-service.js");
  const wizard = await retrieveSecretWithFallback("GITLAB_HOST", "global", workspaceId).catch(
    () => "",
  );
  if (wizard) named.push(wizard);
  return named.map(clean).some((h) => h === host || bare(h) === bare(host));
}

export default async function githubAppRoutes(rawApp: FastifyInstance): Promise<void> {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/internal/git-credentials",
    {
      schema: {
        hide: true,
        operationId: "getGitCredentials",
        summary: "Get git credentials (internal)",
        description:
          "Internal endpoint called by credential helpers in agent pods. " +
          "Cluster-internal only — the Helm ingress blocks /api/internal/* " +
          "from public traffic. Authenticates via HMAC-SHA256 signature in " +
          "the X-Optio-Signature header. " +
          "Hidden from the public spec.",
        tags: ["Auth & Sessions"],
        querystring: gitCredentialsQuerySchema,
        response: {
          200: GitCredentialsResponseSchema,
          401: ErrorResponseSchema,
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const scope = req.query.scope ? parseGitCredentialScope(req.query.scope) : null;
      if (req.query.scope && !scope)
        return reply.status(401).send({ error: "Invalid credential scope" });
      // Unscoped keys once lived in every repo pod and could request any user's
      // token. Reject them by default, including after an upgrade.
      if (!scope && process.env.OPTIO_ALLOW_LEGACY_GIT_CREDENTIALS !== "1") {
        return reply
          .status(401)
          .send({ error: "Legacy credential helper disabled; recreate this pod" });
      }
      const authResult = scope
        ? verifyHmacSignature(
            String(req.headers["x-optio-signature"] ?? ""),
            req.url,
            gitCredentialKey(req.query.scope!),
          )
        : verifyInternalRequest(
            req.headers as Record<string, string | string[] | undefined>,
            req.url,
          );
      if (authResult) {
        return reply.status(authResult.status as 401).send({ error: authResult.error });
      }

      try {
        if (scope?.workspaceId && scope.ownerUserId) {
          const { getUserRole } = await import("../services/workspace-service.js");
          const role = await getUserRole(scope.workspaceId, scope.ownerUserId);
          if (role !== "admin" && role !== "member")
            return reply
              .status(401)
              .send({ error: "Credential owner no longer has workspace execution access" });
        }
        reply.header("Cache-Control", "no-store");
        const host = normalizeGitHost(req.query.host);
        // git hands the answer to whichever host asked: the legacy unscoped
        // key has GitHub's token alone, so any other host gets nothing.
        if (!scope && host && host !== "github.com") {
          return reply.status(404).send({ error: `${host} is not a known GitLab host` });
        }
        if (scope && host && host !== "github.com") {
          // Only a host named as GitLab: git hands the answer to whichever
          // host asked, so an unknown one gets nothing.
          if (!(await isKnownGitLabHost(host, scope.workspaceId ?? null))) {
            return reply.status(404).send({ error: `${host} is not a known GitLab host` });
          }
          const { getGitToken } = await import("../services/git-token-service.js");
          const token = await getGitToken("gitlab", {
            userId: scope.ownerUserId ?? undefined,
            server: !scope.ownerUserId && !scope.ownerTeamId,
            workspaceId: scope.workspaceId,
            ownerTeamId: scope.ownerTeamId ?? null,
            host,
          });
          return reply.send({ token, username: "oauth2" });
        }
        const { taskId } = req.query;
        const token = scope
          ? await getGitHubToken(
              scope.ownerUserId
                ? { userId: scope.ownerUserId, workspaceId: scope.workspaceId }
                : { server: true, workspaceId: scope.workspaceId },
            )
          : taskId
            ? await getGitHubToken({ taskId })
            : await getGitHubToken({ server: true });
        return reply.send({ token });
      } catch (err) {
        app.log.error(err, "Failed to get git credentials");
        return reply.status(500).send({ error: "Failed to retrieve git credentials" });
      }
    },
  );

  app.get(
    "/api/github-app/status",
    {
      schema: {
        operationId: "getGitHubAppStatus",
        summary: "Check GitHub App configuration",
        description:
          "Return whether the GitHub App is configured at the deployment " +
          "level (via `GITHUB_APP_ID` and `GITHUB_APP_INSTALLATION_ID` envs). " +
          "When configured, Optio can authenticate to GitHub without a PAT.",
        tags: ["Auth & Sessions"],
        response: { 200: GitHubAppStatusResponseSchema },
      },
    },
    async (_req, reply) => {
      return reply.send(buildStatusResponse());
    },
  );
}
