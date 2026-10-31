import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AGENT_POLICY_MAX_RULES,
  AGENT_POLICY_RULE_MAX_LENGTH,
  AgentPolicyError,
  STANDARD_DENY_RULES,
  opencodeSupportsRule,
  resolveAgentPolicy,
} from "@optio/shared";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { requireRole } from "../plugins/auth.js";
import { actorOf } from "../services/ownership.js";
import { logAction } from "../services/optio-action-service.js";
import {
  AgentPolicyNotFoundError,
  getRepoPolicy,
  getWorkspacePolicy,
  policyChange,
  setRepoPolicy,
  setWorkspacePolicy,
} from "../services/agent-policy.js";
import {
  agentEgress,
  deploymentBuiltInRules,
  deploymentRuntimeClass,
} from "../utils/agent-policy-env.js";

/**
 * Agent policy (docs/agent-policy.md), for the current workspace only:
 *
 * - `GET /api/agent-policy`: the workspace's rules, the built-in list, and
 *   the deployment's egress allowlist and RuntimeClass (every member reads
 *   it); `PUT`: a workspace admin changes the workspace's rules and turns
 *   the built-in rules on for it.
 * - `GET` / `PUT /api/repos/:id/agent-policy`: the rules a repo of this
 *   workspace adds; a workspace admin changes them. Another workspace's repo
 *   is a 404.
 *
 * The deployment's settings (built-in rules for every workspace, egress,
 * RuntimeClass) are the operator's chart values and have no write route.
 * Every change goes to the action log (`agent_policy.update`).
 */

const RuleList = z
  .array(z.string().max(AGENT_POLICY_RULE_MAX_LENGTH))
  .max(AGENT_POLICY_MAX_RULES)
  .describe("Claude Code permission rules added to the deny list, e.g. Read(**/.env*)");

const WorkspaceBody = z
  .object({
    builtInRules: z
      .boolean()
      .optional()
      .describe(
        "Turn the built-in rules on for this workspace (off can't override the deployment)",
      ),
    denyRules: RuleList.optional(),
  })
  .strict();
const RepoBody = z.object({ denyRules: RuleList }).strict();

const PolicySchema = z
  .object({ builtInRules: z.boolean().optional(), denyRules: z.array(z.string()).optional() })
  .nullable()
  .describe("What this level stores; null = nothing set");

const RuleSchema = z.object({
  rule: z.string(),
  from: z.enum(["built-in", "workspace", "repo"]),
  opencode: z.boolean().describe("OpenCode gets an equivalent"),
});

const WorkspaceResponse = z.object({
  policy: PolicySchema,
  effective: z.object({
    builtInRules: z.boolean(),
    builtInFrom: z.enum(["deployment", "workspace"]).nullable(),
    rules: z.array(RuleSchema).describe("What a run in this workspace gets, before repo rules"),
  }),
  builtIn: z.array(z.string()).describe("The built-in rules"),
  deployment: z.object({
    builtInRules: z.boolean().describe("The operator turned the built-in rules on everywhere"),
    runtimeClassName: z
      .string()
      .nullable()
      .describe("The RuntimeClass every agent pod runs under; null = the cluster's default"),
    runtimeClassError: z.string().optional(),
    egress: z.object({
      mode: z.enum(["allowlist", "default", "not-set", "invalid"]),
      entries: z.array(
        z.object({ name: z.string(), to: z.array(z.string()), ports: z.array(z.number()) }),
      ),
      error: z.string().optional(),
    }),
  }),
  canEdit: z.boolean().describe("The caller is a workspace admin"),
});

const RepoResponse = z.object({ policy: PolicySchema, canEdit: z.boolean() });

const withOpencode = (rules: Array<{ rule: string; from: "built-in" | "workspace" | "repo" }>) =>
  rules.map((r) => ({ ...r, opencode: opencodeSupportsRule(r.rule) }));

function runtimeClass(): { runtimeClassName: string | null; runtimeClassError?: string } {
  try {
    return { runtimeClassName: deploymentRuntimeClass() };
  } catch (err) {
    return { runtimeClassName: null, runtimeClassError: (err as Error).message };
  }
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof AgentPolicyNotFoundError)
    return reply.status(404).send({ error: err.message });
  if (err instanceof AgentPolicyError) return reply.status(400).send({ error: err.message });
  throw err;
}

function logChange(
  req: FastifyRequest,
  workspaceId: string,
  scope: "workspace" | "repo",
  change: ReturnType<typeof policyChange>,
  repoId?: string,
) {
  logAction({
    workspaceId,
    userId: req.user?.id,
    action: "agent_policy.update",
    params: { scope, ...(repoId ? { repoId } : {}) },
    result: change,
    success: true,
  }).catch(() => {});
}

export async function agentPolicyRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  const workspaceView = async (workspaceId: string, isAdmin: boolean) => {
    const policy = await getWorkspacePolicy(workspaceId);
    const builtIn = deploymentBuiltInRules();
    const effective = resolveAgentPolicy({ deploymentBuiltIn: builtIn, workspace: policy });
    return {
      policy,
      effective: { ...effective, rules: withOpencode(effective.rules) },
      builtIn: [...STANDARD_DENY_RULES],
      deployment: { builtInRules: builtIn, ...runtimeClass(), egress: agentEgress() },
      canEdit: isAdmin,
    };
  };

  app.get(
    "/api/agent-policy",
    {
      preHandler: [requireRole("viewer")],
      schema: {
        operationId: "getAgentPolicy",
        summary: "The workspace's agent policy, and the deployment's egress and RuntimeClass",
        description:
          "Any member of the current workspace. The deployment's settings are the operator's chart values.",
        tags: ["Workspaces"],
        response: { 200: WorkspaceResponse, 400: ErrorResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!actor.workspaceId) return reply.status(400).send({ error: "No workspace selected" });
      reply.send(await workspaceView(actor.workspaceId, actor.isAdmin));
    },
  );

  app.put(
    "/api/agent-policy",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "setAgentPolicy",
        summary: "Change the workspace's agent policy (workspace admins)",
        description:
          "Fields sent replace the stored ones. builtInRules can't turn off what the deployment turned on.",
        tags: ["Workspaces"],
        body: WorkspaceBody,
        response: { 200: WorkspaceResponse, 400: ErrorResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!actor.workspaceId) return reply.status(400).send({ error: "No workspace selected" });
      try {
        const { before, policy } = await setWorkspacePolicy(
          actor.workspaceId,
          req.body,
          actor.userId,
        );
        logChange(req, actor.workspaceId, "workspace", policyChange(before, policy));
      } catch (err) {
        return sendError(reply, err);
      }
      reply.send(await workspaceView(actor.workspaceId, true));
    },
  );

  app.get(
    "/api/repos/:id/agent-policy",
    {
      preHandler: [requireRole("viewer")],
      schema: {
        operationId: "getRepoAgentPolicy",
        summary: "The deny rules work in a repo adds to the workspace's",
        description: "A repo of the current workspace; another workspace's repo is a 404.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: RepoResponse, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!actor.workspaceId) return reply.status(400).send({ error: "No workspace selected" });
      try {
        const policy = await getRepoPolicy(req.params.id, actor.workspaceId);
        reply.send({ policy, canEdit: actor.isAdmin });
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
        summary: "Change the deny rules work in a repo adds (workspace admins)",
        description:
          "Workspace admins of the repo's own workspace; another workspace's repo is a 404.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: RepoBody,
        response: {
          200: RepoResponse,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      if (!actor.workspaceId) return reply.status(400).send({ error: "No workspace selected" });
      try {
        const { before, policy } = await setRepoPolicy(
          req.params.id,
          actor.workspaceId,
          req.body,
          actor.userId,
        );
        logChange(req, actor.workspaceId, "repo", policyChange(before, policy), req.params.id);
        reply.send({ policy, canEdit: true });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
