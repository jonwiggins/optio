import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  AGENT_POLICY_MAX_RULES,
  AGENT_POLICY_RULE_MAX_LENGTH,
  AgentPolicyError,
  STANDARD_DENY_RULES,
  agentPolicyDefaultsOn,
  opencodeSupportsRule,
  resolveAgentPolicy,
} from "@optio/shared";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { requireRole } from "../plugins/auth.js";
import { actorOf } from "../services/ownership.js";
import { auditEvent } from "../services/audit.js";
import { canSeeWork } from "../services/work-visibility.js";
import { db } from "../db/client.js";
import { workRuns } from "../db/schema.js";
import {
  AgentPolicyAccessError,
  RuntimeClassUnavailableError,
  agentEgress,
  availableRuntimeClasses,
  canManageTeamPolicy,
  deploymentRuntimeClass,
  getRepoPolicy,
  getRunPolicy,
  getTeamPolicy,
  getWorkspacePolicy,
  policyChange,
  setRepoPolicy,
  setTeamPolicy,
  setWorkspacePolicy,
} from "../services/agent-policy.js";
import { requireTeamsEnabled } from "../services/team-service.js";

/**
 * Agent policy (docs/agent-policy.md):
 *
 * - `GET /api/agent-policy` — the workspace's policy, the built-in rules,
 *   the egress allowlist and the RuntimeClasses (every member reads it);
 *   `PUT` — a workspace admin changes it.
 * - `GET` / `PUT /api/teams/:id/agent-policy` — the rules a team adds; its
 *   admins (or a workspace admin) change them.
 * - `GET` / `PUT /api/repos/:id/agent-policy` — the rules a repo adds and
 *   its RuntimeClass; a workspace admin changes them (a repo's settings
 *   are an admin's). A RuntimeClass the deployment doesn't list is refused.
 * - `GET /api/runs/:id/agent-policy` — what a run started with, for anyone
 *   who may see the run.
 *
 * Every change is in the audit trail (`agent_policy.update`).
 */

const RuleList = z
  .array(z.string().max(AGENT_POLICY_RULE_MAX_LENGTH))
  .max(AGENT_POLICY_MAX_RULES)
  .describe("Claude Code permission rules added to the deny list, e.g. Read(**/.env*)");

const WorkspaceBody = z.object({
  defaults: z
    .boolean()
    .nullable()
    .optional()
    .describe("The built-in rules on or off; null = the deployment's default"),
  denyRules: RuleList.optional(),
});
const TeamBody = z.object({ denyRules: RuleList.optional() });
const RepoBody = z.object({
  denyRules: RuleList.optional(),
  runtimeClassName: z
    .string()
    .max(253)
    .nullable()
    .optional()
    .describe("The RuntimeClass the repo's pods run under; null = the deployment's"),
});

const PolicySchema = z
  .object({
    defaults: z.boolean().nullable().optional(),
    denyRules: z.array(z.string()).optional(),
    runtimeClassName: z.string().nullable().optional(),
  })
  .nullable();

const RuleSchema = z.object({
  rule: z.string(),
  from: z.enum(["default", "workspace", "team", "repo"]),
  opencode: z.boolean().describe("OpenCode gets an equivalent"),
});

const EffectiveSchema = z.object({
  defaults: z.boolean(),
  defaultsFrom: z.enum(["profile", "workspace"]),
  rules: z.array(RuleSchema),
  runtimeClassName: z.string().nullable(),
  runtimeClassFrom: z.enum(["deployment", "repo"]).nullable(),
});

const RuntimeSchema = z.object({
  deployment: z.string().nullable().describe("agent.runtimeClassName"),
  available: z.array(z.string()).describe("The classes a repo may pick"),
});

const WorkspaceResponse = z.object({
  policy: PolicySchema,
  effective: EffectiveSchema,
  builtIn: z.array(z.string()),
  profileDefaults: z
    .boolean()
    .describe("Whether the deployment turns the built-in rules on (OPTIO_AGENT_POLICY_DEFAULTS)"),
  egress: z.object({
    mode: z.enum(["allowlist", "any-https", "unenforced"]),
    always: z.array(z.string()),
    entries: z.array(
      z.object({ name: z.string(), to: z.array(z.string()), ports: z.array(z.number()) }),
    ),
  }),
  runtime: RuntimeSchema,
  canEdit: z.boolean(),
});

const LevelResponse = z.object({
  policy: PolicySchema,
  canEdit: z.boolean(),
  runtime: RuntimeSchema.optional(),
});

const withOpencode = (rules: Array<{ rule: string; from: string }>) =>
  rules.map((r) => ({ ...r, opencode: opencodeSupportsRule(r.rule) })) as Array<{
    rule: string;
    from: "default" | "workspace" | "team" | "repo";
    opencode: boolean;
  }>;

const runtime = () => ({
  deployment: deploymentRuntimeClass(),
  available: availableRuntimeClasses(),
});

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof AgentPolicyAccessError) {
    return reply.status(err.statusCode).send({ error: err.message });
  }
  if (err instanceof AgentPolicyError || err instanceof RuntimeClassUnavailableError) {
    return reply.status(400).send({ error: err.message });
  }
  throw err;
}

export async function agentPolicyRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/agent-policy",
    {
      schema: {
        operationId: "getAgentPolicy",
        summary: "The workspace's agent policy, the egress allowlist and the RuntimeClasses",
        tags: ["Workspaces"],
        response: { 200: WorkspaceResponse, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!actor.workspaceId) return reply.status(400).send({ error: "No workspace selected" });
      const policy = await getWorkspacePolicy(actor.workspaceId);
      const effective = resolveAgentPolicy({
        workspace: policy,
        deploymentRuntimeClass: deploymentRuntimeClass(),
      });
      reply.send({
        policy,
        effective: { ...effective, rules: withOpencode(effective.rules) },
        builtIn: [...STANDARD_DENY_RULES],
        profileDefaults: agentPolicyDefaultsOn(),
        egress: agentEgress(),
        runtime: runtime(),
        canEdit: actor.isAdmin,
      });
    },
  );

  app.put(
    "/api/agent-policy",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "setAgentPolicy",
        summary: "Change the workspace's agent policy (workspace admins)",
        tags: ["Workspaces"],
        body: WorkspaceBody,
        response: { 200: LevelResponse, 400: ErrorResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!actor.workspaceId) return reply.status(400).send({ error: "No workspace selected" });
      try {
        const { before, policy } = await setWorkspacePolicy(actor.workspaceId, req.body);
        void auditEvent({
          req,
          action: "agent_policy.update",
          details: { level: "workspace", ...policyChange(before, policy) },
        });
        reply.send({ policy, canEdit: true });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    "/api/teams/:id/agent-policy",
    {
      preHandler: [requireTeamsEnabled],
      schema: {
        operationId: "getTeamAgentPolicy",
        summary: "The rules a team's work adds to the agent policy",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        response: { 200: LevelResponse, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      try {
        const policy = await getTeamPolicy(req.params.id, actor);
        reply.send({ policy, canEdit: canManageTeamPolicy(req.params.id, actor) });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put(
    "/api/teams/:id/agent-policy",
    {
      preHandler: [requireTeamsEnabled, requireRole("member")],
      schema: {
        operationId: "setTeamAgentPolicy",
        summary: "Change the rules a team's work adds (its admins, or a workspace admin)",
        tags: ["Workspaces"],
        params: IdParamsSchema,
        body: TeamBody,
        response: {
          200: LevelResponse,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const { before, policy } = await setTeamPolicy(req.params.id, actorOf(req), req.body);
        void auditEvent({
          req,
          action: "agent_policy.update",
          details: { level: "team", teamId: req.params.id, ...policyChange(before, policy) },
        });
        reply.send({ policy, canEdit: true });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    "/api/repos/:id/agent-policy",
    {
      schema: {
        operationId: "getRepoAgentPolicy",
        summary: "The rules work in a repo adds, and the repo's RuntimeClass",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: LevelResponse, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      try {
        const policy = await getRepoPolicy(req.params.id, actor);
        reply.send({ policy, canEdit: actor.isAdmin, runtime: runtime() });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.put(
    "/api/repos/:id/agent-policy",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "setRepoAgentPolicy",
        summary: "Change the rules work in a repo adds, and its RuntimeClass (workspace admins)",
        description:
          "A RuntimeClass the deployment doesn't list (the chart's agent.runtimeClasses) is " +
          "refused, as an image preset it doesn't have is.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: RepoBody,
        response: {
          200: LevelResponse,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const { before, policy } = await setRepoPolicy(req.params.id, actorOf(req), req.body);
        void auditEvent({
          req,
          action: "agent_policy.update",
          details: { level: "repo", repoId: req.params.id, ...policyChange(before, policy) },
        });
        reply.send({ policy, canEdit: true, runtime: runtime() });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get(
    "/api/runs/:id/agent-policy",
    {
      schema: {
        operationId: "getRunAgentPolicy",
        summary: "The agent policy a run started with (a Repo Task or a Job run)",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: z.object({
            policy: z
              .object({
                defaults: z.boolean(),
                defaultsFrom: z.enum(["profile", "workspace"]),
                rules: z.array(RuleSchema),
                runtimeClassName: z.string().nullable(),
                runtimeClassFrom: z.enum(["deployment", "repo"]).nullable(),
                agentType: z.string().nullable(),
                enforcedBy: z.enum(["claude-managed-settings", "opencode-config"]).nullable(),
                notEnforced: z.array(z.string()),
                appliedAt: z.string(),
              })
              .nullable()
              .describe("Null for a run that started before agent policy, or never started"),
          }),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const [run] = await db
        .select({
          workspaceId: workRuns.workspaceId,
          ownerUserId: workRuns.ownerUserId,
          ownerTeamId: workRuns.ownerTeamId,
          createdBy: workRuns.createdBy,
        })
        .from(workRuns)
        .where(eq(workRuns.id, req.params.id));
      // Not found, another workspace's, or work this person may not see: one 404.
      if (
        !run ||
        (actor.workspaceId && run.workspaceId !== actor.workspaceId) ||
        !canSeeWork(run, actor)
      ) {
        return reply.status(404).send({ error: "Run not found" });
      }
      const policy = await getRunPolicy(req.params.id);
      reply.send({
        policy: policy ? { ...policy, rules: withOpencode(policy.rules ?? []) } : null,
      });
    },
  );
}
