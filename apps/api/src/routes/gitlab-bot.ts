import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorResponseSchema } from "../schemas/common.js";
import { logAction } from "../services/optio-action-service.js";
import {
  refuseUnlessDeploymentAdmin,
  requesterIsDeploymentAdmin,
} from "../services/deployment-admin-gates.js";
import {
  MAX_RATE_LIMIT,
  RATE_WINDOW_MINUTES,
  botHosts,
  botIdentity,
  botSettings,
  githubBotIdentity,
  saveBotSettings,
  type BotPlatform,
} from "../services/gitlab-bot/settings.js";

/**
 * Optio's bot, which people mention in GitLab and GitHub comments
 * (docs/gitlab-bot.md), on Settings → Integrations. The same two routes
 * per platform, `/api/gitlab-bot` and `/api/github-bot`:
 *
 * - `GET` — anyone signed in: whether it answers, its name on each host
 *   (GitLab: the organization token's user; GitHub: the GitHub App's; or
 *   the name an admin gave it) and the rate limit, so people know whom to
 *   mention.
 * - `PUT` — deployment admins: on / off, the name (or back to the token's
 *   or App's user), the rate limit; null = the deployment's default.
 */

const LABEL: Record<BotPlatform, string> = { github: "GitHub", gitlab: "GitLab" };

const SourceSchema = z.enum(["app", "environment"]);

const ViewSchema = z.object({
  enabled: z.boolean(),
  username: z
    .string()
    .nullable()
    .describe("The name an admin gave the bot; null = the token's user"),
  rateLimit: z.number().describe("Commands per person per merge request or issue in the window"),
  rateWindowMinutes: z.number(),
  maxRateLimit: z.number(),
  source: z.object({
    enabled: SourceSchema,
    username: z.enum(["app", "environment", "token"]),
    rateLimit: SourceSchema,
  }),
  environment: z.object({
    enabled: z.boolean(),
    username: z.string().nullable(),
    rateLimit: z.number(),
  }),
  hosts: z
    .array(
      z.object({
        host: z.string(),
        username: z.string().nullable().describe("Whom to mention there; null when unknown"),
        error: z.string().nullable(),
      }),
    )
    .describe(
      "GitLab: the hosts a deployment admin named (gitlab.hosts, the setup wizard's); GitHub: github.com",
    ),
  canEdit: z.boolean().describe("The caller is a deployment admin"),
});

const UpdateSchema = z
  .object({
    enabled: z.boolean().nullable().optional(),
    username: z
      .string()
      .min(1)
      .max(255)
      .nullable()
      .optional()
      .describe("The bot's username; null = the deployment's default"),
    useToken: z
      .boolean()
      .optional()
      .describe("Use the organization token's own user (GitLab) or the GitHub App's (GitHub)"),
    rateLimit: z.number().int().min(1).max(MAX_RATE_LIMIT).nullable().optional(),
  })
  .describe("Bot settings to change");

async function view(req: FastifyRequest, platform: BotPlatform) {
  const settings = await botSettings(platform);
  const wsId = req.user?.workspaceId ?? null;
  const hosts =
    platform === "github"
      ? [
          await githubBotIdentity("https://api.github.com", settings).then(
            ({ identity, error }) => ({
              host: "github.com",
              username: identity?.username ?? null,
              error: identity ? null : error,
            }),
          ),
        ]
      : await Promise.all(
          (await botHosts()).slice(0, 10).map(async (host) => {
            const { identity, error } = await botIdentity(`https://${host}/api/v4`, wsId, settings);
            return { host, username: identity?.username ?? null, error: identity ? null : error };
          }),
        );
  return {
    enabled: settings.enabled,
    username: settings.username,
    rateLimit: settings.rateLimit,
    rateWindowMinutes: RATE_WINDOW_MINUTES,
    maxRateLimit: MAX_RATE_LIMIT,
    source: settings.source,
    environment: settings.environment,
    hosts,
    canEdit: await requesterIsDeploymentAdmin(req),
  };
}

export async function gitlabBotRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  for (const platform of ["gitlab", "github"] as const) {
    const name = LABEL[platform];
    const refusal = `Only a deployment admin changes the ${name} bot`;

    app.get(
      `/api/${platform}-bot`,
      {
        schema: {
          operationId: `get${name}Bot`,
          summary: `Optio's ${name} user for @-mentions`,
          description:
            `Whether Optio answers @-mentions in ${name} comments, the name to mention on each ` +
            `${name} host, and the rate limit.`,
          tags: ["Setup & Settings"],
          response: { 200: ViewSchema, 401: ErrorResponseSchema },
        },
      },
      async (req, reply) => {
        if (!req.user) return reply.status(401).send({ error: "Authentication required" });
        reply.send(await view(req, platform));
      },
    );

    app.put(
      `/api/${platform}-bot`,
      {
        schema: {
          operationId: `update${name}Bot`,
          summary: `Change how Optio answers @-mentions in ${name}`,
          description:
            "Deployment admins only. `null` returns a setting to the deployment's default.",
          tags: ["Setup & Settings"],
          body: UpdateSchema,
          response: {
            200: ViewSchema,
            400: ErrorResponseSchema,
            401: ErrorResponseSchema,
            403: ErrorResponseSchema,
          },
        },
      },
      async (req, reply) => {
        if (!req.user) return reply.status(401).send({ error: "Authentication required" });
        if (await refuseUnlessDeploymentAdmin(req, reply, refusal)) return reply;
        try {
          await saveBotSettings(platform, req.body, req.user.id ?? null);
        } catch (err) {
          return reply
            .status(400)
            .send({ error: err instanceof Error ? err.message : String(err) });
        }
        // Deployment-wide: no workspace, so the action log shows it to deployment admins.
        logAction({
          userId: req.user.id,
          workspaceId: null,
          action: `${platform}_bot.settings`,
          params: typeof req.body.enabled === "boolean" ? { enabled: req.body.enabled } : {},
          success: true,
        }).catch(() => {});
        reply.send(await view(req, platform));
      },
    );
  }
}
