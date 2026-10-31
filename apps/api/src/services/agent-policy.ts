import { and, eq, isNull, sql } from "drizzle-orm";
import {
  CLAUDE_MANAGED_SETTINGS_PATH,
  claudeManagedSettings,
  cleanAgentPolicy,
  normalizeRepoUrl,
  opencodeDenyPermission,
  opencodeSupportsRule,
  resolveAgentPolicy,
  type AgentContainerConfig,
  type AgentPolicy,
  type EffectiveAgentPolicy,
} from "@optio/shared";
import { db } from "../db/client.js";
import { agentPolicies, repos } from "../db/schema.js";
import { deploymentBuiltInRules } from "../utils/agent-policy-env.js";

/**
 * Agent policy (docs/agent-policy.md). Three controls, each off by default:
 *
 * - Deny rules: the built-in list (the operator's `OPTIO_AGENT_POLICY_DEFAULTS`,
 *   or a workspace admin for one workspace), a workspace's own rules and a
 *   repo's. `applyAgentPolicy` writes them into a run's setup files
 *   (Claude Code's managed settings) or env (OpenCode's inline config); it
 *   is called once, from `buildAgentEnvironment`.
 * - The egress allowlist: the chart's NetworkPolicy (helm
 *   `networkPolicy.agentEgress`); the API only shows it and keeps a
 *   restricted repo's own policy from widening it (utils/agent-policy-env.ts).
 * - A RuntimeClass for every agent pod (`OPTIO_AGENT_RUNTIME_CLASS`,
 *   utils/agent-policy-env.ts, used by agent-node-placement.ts).
 *
 * Who changes what: the deployment's settings are the operator's (chart
 * values, as env); a workspace's and its repos' rules are that workspace's
 * admins' (routes/agent-policy.ts). Nothing here can be changed by an agent.
 */

type SetupFile = NonNullable<AgentContainerConfig["setupFiles"]>[number];

// ── The levels ──────────────────────────────────────────────────────────────

export class AgentPolicyNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(message: string) {
    super(message);
    this.name = "AgentPolicyNotFoundError";
  }
}

/** A workspace's own row: undefined when none was ever written. */
async function workspaceRow(workspaceId: string): Promise<AgentPolicy | undefined> {
  const [row] = await db
    .select({ policy: agentPolicies.policy })
    .from(agentPolicies)
    .where(and(eq(agentPolicies.workspaceId, workspaceId), isNull(agentPolicies.repoId)));
  return row?.policy;
}

export async function getWorkspacePolicy(workspaceId: string): Promise<AgentPolicy | null> {
  return (await workspaceRow(workspaceId)) ?? null;
}

/** A repo of `workspaceId`, or a 404 (another workspace's repo is never found). */
async function repoIn(repoId: string, workspaceId: string): Promise<{ id: string }> {
  const [row] = await db
    .select({ id: repos.id, workspaceId: repos.workspaceId })
    .from(repos)
    .where(eq(repos.id, repoId));
  if (!row || row.workspaceId !== workspaceId) throw new AgentPolicyNotFoundError("Repo not found");
  return row;
}

export async function getRepoPolicy(
  repoId: string,
  workspaceId: string,
): Promise<AgentPolicy | null> {
  await repoIn(repoId, workspaceId);
  const [row] = await db
    .select({ policy: agentPolicies.policy })
    .from(agentPolicies)
    .where(eq(agentPolicies.repoId, repoId));
  return row?.policy ?? null;
}

/** What changed, for the action log: the rules added and removed, and the switch. */
export function policyChange(
  before: AgentPolicy | null,
  after: AgentPolicy,
): { added: string[]; removed: string[]; builtInRules?: boolean } {
  const was = new Set(before?.denyRules ?? []);
  const now = new Set(after.denyRules ?? []);
  return {
    added: [...now].filter((r) => !was.has(r)),
    removed: [...was].filter((r) => !now.has(r)),
    ...((before?.builtInRules ?? false) !== (after.builtInRules ?? false)
      ? { builtInRules: after.builtInRules ?? false }
      : {}),
  };
}

/**
 * A workspace admin sets the workspace's policy (the route checks the role):
 * the fields sent replace the stored ones, the others stay.
 */
export async function setWorkspacePolicy(
  workspaceId: string,
  input: AgentPolicy,
  userId: string | null,
): Promise<{ before: AgentPolicy | null; policy: AgentPolicy }> {
  const before = await getWorkspacePolicy(workspaceId);
  const policy = cleanAgentPolicy({ ...(before ?? {}), ...defined(input) }, "workspace");
  await db
    .insert(agentPolicies)
    .values({ workspaceId, policy, updatedBy: userId })
    .onConflictDoUpdate({
      target: agentPolicies.workspaceId,
      targetWhere: isNull(agentPolicies.repoId),
      set: { policy, updatedBy: userId, updatedAt: new Date() },
    });
  return { before, policy };
}

/** A workspace admin sets the rules of a repo in that workspace (the route checks the role). */
export async function setRepoPolicy(
  repoId: string,
  workspaceId: string,
  input: AgentPolicy,
  userId: string | null,
): Promise<{ before: AgentPolicy | null; policy: AgentPolicy }> {
  const before = await getRepoPolicy(repoId, workspaceId);
  const policy = cleanAgentPolicy({ denyRules: input.denyRules ?? before?.denyRules }, "repo");
  await db
    .insert(agentPolicies)
    .values({ workspaceId, repoId, policy, updatedBy: userId })
    .onConflictDoUpdate({
      target: agentPolicies.repoId,
      targetWhere: sql`${agentPolicies.repoId} IS NOT NULL`,
      set: { policy, updatedBy: userId, updatedAt: new Date() },
    });
  return { before, policy };
}

function defined(input: AgentPolicy): AgentPolicy {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}

// ── Resolution for a run ────────────────────────────────────────────────────

export interface PolicyForRun extends EffectiveAgentPolicy {
  /**
   * Whether anything was ever set for this run (the deployment's switch, a
   * workspace or repo row). False: the run gets nothing, exactly as without
   * agent policy.
   */
  inUse: boolean;
}

/**
 * The policy for work in `repoUrl` in `workspaceId`. A failed read throws,
 * so a run never starts without rules it should have.
 */
export async function resolvePolicyFor(input: {
  workspaceId: string | null;
  repoUrl?: string | null;
}): Promise<PolicyForRun> {
  const deploymentBuiltIn = deploymentBuiltInRules();
  const [workspace, repo] = input.workspaceId
    ? await Promise.all([
        workspaceRow(input.workspaceId),
        input.repoUrl ? repoRowByUrl(input.repoUrl, input.workspaceId) : undefined,
      ])
    : [undefined, undefined];
  const resolved = resolveAgentPolicy({ deploymentBuiltIn, workspace, repo });
  return {
    ...resolved,
    // The operator's switch set at all (true, or false after being true),
    // or a row a workspace admin wrote.
    inUse:
      !!process.env.OPTIO_AGENT_POLICY_DEFAULTS?.trim() ||
      workspace !== undefined ||
      repo !== undefined,
  };
}

async function repoRowByUrl(
  repoUrl: string,
  workspaceId: string,
): Promise<AgentPolicy | undefined> {
  const [row] = await db
    .select({ policy: agentPolicies.policy })
    .from(agentPolicies)
    .innerJoin(repos, eq(repos.id, agentPolicies.repoId))
    .where(
      and(eq(repos.repoUrl, normalizeRepoUrl(repoUrl)), eq(agentPolicies.workspaceId, workspaceId)),
    );
  return row?.policy;
}

export interface ApplyPolicyInput {
  repoUrl: string | null;
  agentType: string | null;
  workspaceId: string | null;
  /** The Ask Optio assistant: Optio's own tools, no repo. */
  controllerOnly?: boolean;
}

/** How a run's rules reached its agent, for the log. */
export interface AppliedPolicy {
  rules: number;
  enforcedBy: "claude-managed-settings" | "opencode-config" | null;
  /** Rules the runtime has no equivalent for. */
  notEnforced: string[];
}

/**
 * The hook in `buildAgentEnvironment`. Nothing ever set (the default): no
 * file, no env, the run is exactly what it was without agent policy.
 * Otherwise:
 *
 * - Claude Code gets `/etc/claude-code/managed-settings.json` with the
 *   rules, an empty list included: repo and Job pods serve many runs, and
 *   writing it every time replaces what an earlier run's policy left there.
 * - OpenCode gets the rules OpenCode has an equivalent for in
 *   `OPENCODE_CONFIG_CONTENT`, the inline config it reads after the repo's
 *   own `opencode.json`. Nothing else in Optio sets that variable, and a pod
 *   secret can't (utils/pod-env.ts reserves the name).
 * - Other runtimes get nothing; the log says so.
 */
export async function applyAgentPolicy(
  input: ApplyPolicyInput,
  setupFiles: SetupFile[],
  env: Record<string, string>,
): Promise<AppliedPolicy | null> {
  if (!input.agentType || input.controllerOnly) return null;
  const policy = await resolvePolicyFor(input);
  if (!policy.inUse) return null;
  return policyForRuntime(policy, input.agentType, setupFiles, env);
}

/** Writes `policy` for one runtime. */
export function policyForRuntime(
  policy: EffectiveAgentPolicy,
  agentType: string,
  setupFiles: SetupFile[],
  env: Record<string, string>,
): AppliedPolicy {
  const rules = policy.rules.map((r) => r.rule);
  if (agentType === "claude-code") {
    setupFiles.push({
      path: CLAUDE_MANAGED_SETTINGS_PATH,
      content: JSON.stringify(claudeManagedSettings(rules), null, 2),
    });
    return { rules: rules.length, enforcedBy: "claude-managed-settings", notEnforced: [] };
  }
  if (agentType === "opencode") {
    const deny = opencodeDenyPermission(rules);
    const notEnforced = rules.filter((r) => !opencodeSupportsRule(r));
    if (Object.keys(deny).length === 0)
      return { rules: rules.length, enforcedBy: null, notEnforced };
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: deny });
    return { rules: rules.length, enforcedBy: "opencode-config", notEnforced };
  }
  return { rules: rules.length, enforcedBy: null, notEnforced: rules };
}
