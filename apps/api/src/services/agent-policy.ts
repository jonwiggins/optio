import { and, eq, isNull, sql } from "drizzle-orm";
import {
  AgentPolicyError,
  CLAUDE_MANAGED_SETTINGS_PATH,
  claudeManagedSettings,
  cleanAgentPolicy,
  normalizeRepoUrl,
  opencodeDenyPermission,
  opencodeSupportsRule,
  resolveAgentPolicy,
  type AgentContainerConfig,
  type AgentPolicy,
  type AgentPolicyLevel,
  type EffectiveAgentPolicy,
  type RunAgentPolicy,
} from "@optio/shared";
import { opencodeHeadlessPermission } from "@optio/agent-adapters";
import {
  CLAUDE_POLICY_CLEAR_ENV,
  OPENCODE_POLICY_ENV,
  claudePolicyMarkerPath,
} from "../utils/agent-policy-pod.js";
import { db } from "../db/client.js";
import { repos, runAgentPolicies, teams, workRuns, workspaces } from "../db/schema.js";
import type { Actor } from "./ownership.js";

/**
 * Agent policy (docs/agent-policy.md): the deny rules every agent pod gets,
 * per workspace with rules added per team and per repo, and the RuntimeClass
 * agent pods run under. The policy model and its resolution are pure
 * (packages/shared agent-policy.ts); this file stores the levels, applies
 * the result to a run's setup files and records what each run got.
 *
 * Hooks in upstream files, each one call:
 *
 * - `buildAgentEnvironment` (agent-environment-service.ts) → `applyAgentPolicy`:
 *   Claude Code gets `/etc/claude-code/managed-settings.json` (a run with no
 *   rules removes an earlier run's), OpenCode the same rules over its headless
 *   permission block, merged in the pod into the work's own
 *   `OPENCODE_CONFIG_CONTENT` (the inline config, which a repo's own
 *   `opencode.json` can't override); the pod's part is in
 *   utils/agent-policy-pod.ts, run by every exec script (pod-env.ts);
 * - the repo pod's isolation key (pod-isolation.ts, from task-worker.ts): a
 *   team's Tasks get pods of their own, so its rules aren't another run's;
 * - `agentNodePlacement` (agent-node-placement.ts) and the repo pod spec
 *   (repo-pool-service.ts) → `deploymentRuntimeClass` / `repoRuntimeClass`;
 * - `startRemoteWorkspaceWork` (remote-workspace-service.ts) →
 *   `remoteWorkspacePolicyParameters`.
 */

type SetupFile = NonNullable<AgentContainerConfig["setupFiles"]>[number];

// ── The deployment: RuntimeClass and egress (Helm values, as env) ───────────

/** The RuntimeClass every agent pod runs under (`agent.runtimeClassName`); null = the cluster's default. */
export function deploymentRuntimeClass(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.OPTIO_AGENT_RUNTIME_CLASS?.trim() || null;
}

/**
 * The RuntimeClasses a repo may pick: the chart's `agent.runtimeClasses`
 * (`OPTIO_AGENT_RUNTIME_CLASSES`, the classes the cluster has), plus the
 * deployment's own. Optio's namespaced account can't list a cluster's
 * RuntimeClasses, so the chart says which there are, as it does for
 * image presets (image-presets.ts).
 */
export function availableRuntimeClasses(env: NodeJS.ProcessEnv = process.env): string[] {
  const listed = (env.OPTIO_AGENT_RUNTIME_CLASSES ?? "")
    .split(/[\s,]+/)
    .map((c) => c.trim())
    .filter(Boolean);
  const own = deploymentRuntimeClass(env);
  return [...new Set([...(own ? [own] : []), ...listed])];
}

/** A RuntimeClass this deployment doesn't list (so the cluster may not have it). */
export class RuntimeClassUnavailableError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly runtimeClass: string,
    readonly available: readonly string[],
  ) {
    super(
      available.length > 0
        ? `RuntimeClass "${runtimeClass}" is not available in this deployment (available: ${available.join(", ")})`
        : `RuntimeClass "${runtimeClass}" is not available in this deployment: it lists none (the chart's agent.runtimeClasses)`,
    );
    this.name = "RuntimeClassUnavailableError";
  }
}

export function assertRuntimeClassAvailable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const available = availableRuntimeClasses(env);
  if (!available.includes(name)) throw new RuntimeClassUnavailableError(name, available);
}

/** One allowlist entry as the chart's `networkPolicy.agentEgress` holds it. */
export interface AgentEgressEntry {
  name?: string;
  cidr?: string;
  cidrs?: string[];
  except?: string[];
  namespace?: string;
  podLabels?: Record<string, string>;
  ports?: number[];
}

/** Where agent pods may connect, for Settings → Agent policy. */
export interface AgentEgressView {
  /**
   * `allowlist`: DNS, the Optio API and the entries only. `any-https`:
   * upstream's rule, any host on ports 443 and 80. `unenforced`: the chart's
   * NetworkPolicy is off (or this API wasn't deployed by the chart).
   */
  mode: "allowlist" | "any-https" | "unenforced";
  /** Always reachable when a NetworkPolicy is on. */
  always: string[];
  entries: Array<{ name: string; to: string[]; ports: number[] }>;
}

function egressEntries(raw: unknown): AgentEgressEntry[] {
  return Array.isArray(raw)
    ? raw.filter((e): e is AgentEgressEntry => !!e && typeof e === "object")
    : [];
}

/** The chart's egress settings (`OPTIO_AGENT_EGRESS`: `{ enforced, allow }`). */
export function agentEgress(env: NodeJS.ProcessEnv = process.env): AgentEgressView {
  let parsed: { enforced?: unknown; allow?: unknown } = {};
  try {
    parsed = env.OPTIO_AGENT_EGRESS ? JSON.parse(env.OPTIO_AGENT_EGRESS) : {};
  } catch {
    parsed = {};
  }
  const entries = egressEntries(parsed.allow).map((e, i) => {
    const to = [
      ...(e.cidr ? [e.cidr] : []),
      ...(Array.isArray(e.cidrs) ? e.cidrs : []),
      ...(e.namespace
        ? [
            `namespace ${e.namespace}${
              e.podLabels && Object.keys(e.podLabels).length > 0
                ? `, pods ${Object.entries(e.podLabels)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(",")}`
                : ""
            }`,
          ]
        : []),
    ];
    const ports = Array.isArray(e.ports) && e.ports.length > 0 ? e.ports.map(Number) : [443];
    return { name: e.name?.trim() || `Entry ${i + 1}`, to, ports };
  });
  if (parsed.enforced !== true) return { mode: "unenforced", always: [], entries };
  return {
    mode: entries.length > 0 ? "allowlist" : "any-https",
    always: ["DNS (port 53)", "The Optio API"],
    entries,
  };
}

/** Whether the chart's allowlist replaces upstream's "any host on 443 and 80". */
export function agentEgressAllowlistOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return agentEgress(env).mode === "allowlist";
}

// ── The levels ──────────────────────────────────────────────────────────────

export class AgentPolicyAccessError extends Error {
  constructor(
    message: string,
    readonly statusCode: 403 | 404,
  ) {
    super(message);
    this.name = "AgentPolicyAccessError";
  }
}

export async function getWorkspacePolicy(workspaceId: string): Promise<AgentPolicy | null> {
  const [row] = await db
    .select({ p: workspaces.agentPolicy })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return row?.p ?? null;
}

/** A team of the actor's workspace, or a 404. */
async function teamIn(teamId: string, actor: Actor) {
  const [row] = await db
    .select({ id: teams.id, workspaceId: teams.workspaceId, p: teams.agentPolicy })
    .from(teams)
    .where(eq(teams.id, teamId));
  if (!row || row.workspaceId !== actor.workspaceId) {
    throw new AgentPolicyAccessError("Team not found", 404);
  }
  return row;
}

/** A repo of the actor's workspace, or a 404. */
async function repoIn(repoId: string, actor: Actor) {
  const [row] = await db
    .select({ id: repos.id, workspaceId: repos.workspaceId, p: repos.agentPolicy })
    .from(repos)
    .where(eq(repos.id, repoId));
  if (!row || (actor.workspaceId && row.workspaceId !== actor.workspaceId)) {
    throw new AgentPolicyAccessError("Repo not found", 404);
  }
  return row;
}

/** Who may change a team's rules: its admins, and the workspace's (as for the team itself). */
export function canManageTeamPolicy(teamId: string, actor: Actor): boolean {
  return actor.isAdmin || (actor.adminTeamIds ?? []).includes(teamId);
}

export async function getTeamPolicy(teamId: string, actor: Actor): Promise<AgentPolicy | null> {
  return (await teamIn(teamId, actor)).p ?? null;
}

export async function getRepoPolicy(repoId: string, actor: Actor): Promise<AgentPolicy | null> {
  return (await repoIn(repoId, actor)).p ?? null;
}

/** What changed, for the audit trail: the rules added and removed, and the switches. */
export function policyChange(
  before: AgentPolicy | null,
  after: AgentPolicy | null,
): Record<string, unknown> {
  const was = new Set(before?.denyRules ?? []);
  const now = new Set(after?.denyRules ?? []);
  return {
    added: [...now].filter((r) => !was.has(r)),
    removed: [...was].filter((r) => !now.has(r)),
    ...((before?.defaults ?? null) !== (after?.defaults ?? null)
      ? { defaults: after?.defaults ?? null }
      : {}),
    ...((before?.runtimeClassName ?? null) !== (after?.runtimeClassName ?? null)
      ? { runtimeClassName: after?.runtimeClassName ?? null }
      : {}),
  };
}

/**
 * Saves a level's policy: the fields sent replace the stored ones (null
 * clears one), the others stay. Returns the stored policy and the one before.
 */
async function save(
  level: AgentPolicyLevel,
  id: string,
  input: AgentPolicy,
  before: AgentPolicy | null,
): Promise<{ before: AgentPolicy | null; policy: AgentPolicy | null }> {
  const merged: AgentPolicy = { ...(before ?? {}) };
  if (input.defaults !== undefined) merged.defaults = input.defaults;
  if (input.denyRules !== undefined) merged.denyRules = input.denyRules;
  if (input.runtimeClassName !== undefined) merged.runtimeClassName = input.runtimeClassName;
  const policy = cleanAgentPolicy(merged, level);
  if (level === "repo" && policy?.runtimeClassName) {
    assertRuntimeClassAvailable(policy.runtimeClassName);
  }
  const set = { agentPolicy: policy, updatedAt: new Date() };
  if (level === "workspace") await db.update(workspaces).set(set).where(eq(workspaces.id, id));
  else if (level === "team") await db.update(teams).set(set).where(eq(teams.id, id));
  else await db.update(repos).set(set).where(eq(repos.id, id));
  return { before, policy };
}

/** A workspace admin sets the workspace's policy (the route checks the role). */
export async function setWorkspacePolicy(workspaceId: string, input: AgentPolicy) {
  return save("workspace", workspaceId, input, await getWorkspacePolicy(workspaceId));
}

/** The team's admins or a workspace admin set the team's rules. */
export async function setTeamPolicy(teamId: string, actor: Actor, input: AgentPolicy) {
  const team = await teamIn(teamId, actor);
  if (!canManageTeamPolicy(teamId, actor)) {
    throw new AgentPolicyAccessError(
      "Only the team's admins (or a workspace admin) can change its agent policy",
      403,
    );
  }
  return save("team", teamId, input, team.p ?? null);
}

/** A workspace admin sets a repo's rules and RuntimeClass (the route checks the role). */
export async function setRepoPolicy(repoId: string, actor: Actor, input: AgentPolicy) {
  const repo = await repoIn(repoId, actor);
  return save("repo", repoId, input, repo.p ?? null);
}

// ── Resolution for a run ────────────────────────────────────────────────────

async function repoPolicyByUrl(
  repoUrl: string | null | undefined,
  workspaceId: string | null,
): Promise<AgentPolicy | null> {
  if (!repoUrl) return null;
  const [row] = await db
    .select({ p: repos.agentPolicy })
    .from(repos)
    .where(
      and(
        eq(repos.repoUrl, normalizeRepoUrl(repoUrl)),
        workspaceId ? eq(repos.workspaceId, workspaceId) : isNull(repos.workspaceId),
      ),
    );
  return row?.p ?? null;
}

async function teamPolicyById(teamId: string | null | undefined): Promise<AgentPolicy | null> {
  if (!teamId) return null;
  const [row] = await db.select({ p: teams.agentPolicy }).from(teams).where(eq(teams.id, teamId));
  return row?.p ?? null;
}

/** The policy for work in `repoUrl`, owned by `ownerTeamId`, in `workspaceId`. */
export async function resolvePolicyFor(input: {
  workspaceId: string | null;
  ownerTeamId?: string | null;
  repoUrl?: string | null;
}): Promise<EffectiveAgentPolicy> {
  const [workspace, team, repo] = await Promise.all([
    input.workspaceId ? getWorkspacePolicy(input.workspaceId) : Promise.resolve(null),
    teamPolicyById(input.ownerTeamId),
    repoPolicyByUrl(input.repoUrl, input.workspaceId),
  ]);
  return resolveAgentPolicy({
    workspace,
    team,
    repo,
    deploymentRuntimeClass: deploymentRuntimeClass(),
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A run's team when the caller didn't say: the `tasks` row's (a Repo Task or a Job run). */
async function runTeam(runId: string | null | undefined): Promise<string | null> {
  if (!runId || !UUID.test(runId)) return null;
  const [row] = await db
    .select({ team: workRuns.ownerTeamId })
    .from(workRuns)
    .where(eq(workRuns.id, runId));
  return row?.team ?? null;
}

export interface ApplyPolicyInput {
  repoUrl: string | null;
  agentType: string | null;
  workspaceId: string | null;
  /** The work's team; undefined = read from the run's row. */
  ownerTeamId?: string | null;
  runId?: string | null;
  /** The Ask Optio assistant: no repo, Optio's own tools (it runs in the API pod). */
  controllerOnly?: boolean;
}

/**
 * The hook in `buildAgentEnvironment`: writes the policy into the run's
 * setup files and env, and records what the run got. An agent with no rules
 * (the default: OPTIO_AGENT_POLICY_DEFAULTS off, nothing set) gets no file and no config, as upstream;
 * only a Claude Code run's note to remove an earlier run's file, which does
 * nothing where there is none.
 */
export async function applyAgentPolicy(
  input: ApplyPolicyInput,
  setupFiles: SetupFile[],
  env: Record<string, string>,
): Promise<RunAgentPolicy | null> {
  if (!input.agentType || input.controllerOnly) return null;
  const ownerTeamId =
    input.ownerTeamId !== undefined ? input.ownerTeamId : await runTeam(input.runId);
  const policy = await resolvePolicyFor({
    workspaceId: input.workspaceId,
    ownerTeamId,
    repoUrl: input.repoUrl,
  });
  const run = policyForRuntime(policy, input.agentType, setupFiles, env);
  if (input.runId && UUID.test(input.runId)) {
    await recordRunPolicy(input.runId, input.workspaceId, run);
  }
  return run;
}

/** Writes `policy` for one runtime; what the run got. */
export function policyForRuntime(
  policy: EffectiveAgentPolicy,
  agentType: string,
  setupFiles: SetupFile[],
  env: Record<string, string>,
): RunAgentPolicy {
  const rules = policy.rules.map((r) => r.rule);
  let enforcedBy: RunAgentPolicy["enforcedBy"] = null;
  let notEnforced: string[] = [];
  if (agentType === "claude-code") {
    const settings = claudeManagedSettings(policy);
    if (settings) {
      // The marker first: a later run with no rules removes only a file Optio wrote.
      setupFiles.push({
        path: claudePolicyMarkerPath(),
        content: "Written by Optio's agent policy (docs/agent-policy.md)\n",
      });
      setupFiles.push({
        path: CLAUDE_MANAGED_SETTINGS_PATH,
        content: JSON.stringify(settings, null, 2),
      });
      enforcedBy = "claude-managed-settings";
    }
    // No rules: the pod removes an earlier run's file (utils/agent-policy-pod.ts).
    env[CLAUDE_POLICY_CLEAR_ENV] = settings ? "" : "1";
  } else if (agentType === "opencode") {
    const deny = opencodeDenyPermission(rules);
    notEnforced = rules.filter((r) => !opencodeSupportsRule(r));
    // The pod merges these into the work's own OPENCODE_CONFIG_CONTENT (a pod
    // secret's provider stays): the inline config comes after the repo's own
    // opencode.json, so the repo can't loosen it; the headless block
    // (opencode-headless.ts) stays under the work's own permission.
    env[OPENCODE_POLICY_ENV] =
      Object.keys(deny).length > 0
        ? JSON.stringify({ base: opencodeHeadlessPermission(), deny })
        : "";
    if (env[OPENCODE_POLICY_ENV]) enforcedBy = "opencode-config";
  } else {
    notEnforced = rules;
  }
  return { ...policy, agentType, enforcedBy, notEnforced, appliedAt: new Date().toISOString() };
}

// ── What a run got ──────────────────────────────────────────────────────────

/** Keeps what `runId` started with (a `tasks` row; other ids are skipped). */
export async function recordRunPolicy(
  runId: string,
  workspaceId: string | null,
  policy: RunAgentPolicy,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO run_agent_policies (run_id, workspace_id, policy)
    SELECT ${runId}::uuid, ${workspaceId}::uuid, ${JSON.stringify(policy)}::jsonb
    WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ${runId}::uuid)
    ON CONFLICT (run_id) DO UPDATE
      SET policy = EXCLUDED.policy, workspace_id = EXCLUDED.workspace_id, created_at = now()
  `);
}

export async function getRunPolicy(runId: string): Promise<RunAgentPolicy | null> {
  const [row] = await db
    .select({ policy: runAgentPolicies.policy })
    .from(runAgentPolicies)
    .where(eq(runAgentPolicies.runId, runId));
  return row?.policy ?? null;
}

// ── Pods and remote workspaces ──────────────────────────────────────────────

/**
 * A repo pod's RuntimeClass when the repo picks one over the deployment's.
 * A class the deployment no longer lists fails the pod at once, naming the
 * classes there are, rather than leaving it Pending.
 */
export async function repoRuntimeClass(
  repoUrl: string,
  workspaceId: string | null | undefined,
): Promise<{ runtimeClassName?: string }> {
  const policy = await repoPolicyByUrl(repoUrl, workspaceId ?? null);
  const name = policy?.runtimeClassName?.trim();
  if (!name) return {};
  assertRuntimeClassAvailable(name);
  return { runtimeClassName: name };
}

/** The team in a work spec's owner (`"team:<id>"`), else null. */
export function teamOfOwner(owner: string | null | undefined): string | null {
  return owner?.startsWith("team:") ? owner.slice("team:".length) || null : null;
}

/**
 * The parameters that carry the policy to a remote workspace
 * (docs/remote-workspaces.md): a Coder template's, and the start script's
 * OPTIO_CLAUDE_MANAGED_SETTINGS / OPTIO_OPENCODE_MANAGED_CONFIG.
 */
export const REMOTE_WORKSPACE_POLICY_PARAMETERS = {
  claude: "optio_claude_managed_settings",
  opencode: "optio_opencode_managed_config",
} as const;

/**
 * The policy for work in a remote workspace, as its parameters: Claude
 * Code's managed settings and OpenCode's managed config, which the workspace
 * writes read-only into /etc/claude-code and /etc/opencode (a Coder
 * template, examples/coder/optio-workspace; the start script for the other
 * providers); blank when there are no rules. A Coder template without them
 * gets nothing (`parameterValues` passes only the parameters a template
 * declares).
 */
export async function remoteWorkspacePolicyParameters(input: {
  workspaceId: string | null;
  ownerTeamId?: string | null;
  repoUrl?: string | null;
}): Promise<Record<string, string>> {
  const policy = await resolvePolicyFor(input);
  const settings = claudeManagedSettings(policy);
  const deny = opencodeDenyPermission(policy.rules.map((r) => r.rule));
  // Blank when there are none, so a workspace built with rules loses them.
  return {
    [REMOTE_WORKSPACE_POLICY_PARAMETERS.claude]: settings ? JSON.stringify(settings) : "",
    [REMOTE_WORKSPACE_POLICY_PARAMETERS.opencode]:
      Object.keys(deny).length > 0 ? JSON.stringify({ permission: deny }) : "",
  };
}

export { AgentPolicyError };
