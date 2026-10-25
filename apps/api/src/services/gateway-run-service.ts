import {
  MODEL_PROVIDER_MODEL_ROLES,
  gatewayModelOptionKey,
  gatewayModelPick,
  type GatewayModelPick,
  type LocalTerminalSpec,
  type ModelProviderAgent,
} from "@optio/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { tasks, workflowRuns } from "../db/schema.js";
import { defaultGateway, resolveGatewayToken } from "./model-gateway-service.js";
import {
  ModelProviderError,
  gatewayOf,
  getModelProviderRow,
  podProviderRuntime,
  providerLaunch,
  type ModelProviderRow,
} from "./model-provider-service.js";
import { withPriceCatalog } from "./usage-pricing.js";
// The gateway pre-flight (docs/credential-health.md).
import { gatewayPreflight } from "./credential-health/gateway-preflight.js";

/**
 * A run through the model gateway (docs/model-gateway.md): which gateway
 * the work goes through — the provider it picked when that is one, else the
 * workspace's default — the model and effort it takes from the catalog, the
 * owner's own token, and the env the agent CLI gets. One resolver for every
 * place an agent starts: Repo Tasks, PR reviews, Jobs, persistent agents,
 * sessions and a spawn on a machine.
 *
 * A gateway run signs in nowhere else: `applyGatewayEnv` drops the vendor
 * key and OAuth token the deployment may hold, so the gateway's spend ledger
 * stays per person. A missing token is a `GatewayTokenMissingError` from
 * `resolveGatewayToken`, whose message says where to add it; the workers
 * fail the run with it.
 */

/** `OPTIO_AUTH_MODE` / `claudeAuthMode` of a gateway run. */
export const GATEWAY_AUTH_MODE = "gateway";

/** The agents the gateway's env (`gatewayRuntime`) is wired for. */
const GATEWAY_RUN_AGENTS: readonly string[] = ["claude-code", "opencode"];

export interface GatewayRunUse {
  agentType: string;
  agentOptions: Record<string, unknown> | null | undefined;
  /** The legacy single `model` column, honored when the options name none. */
  fallbackModel?: string | null;
  workspaceId: string | null | undefined;
  /** The work's owner (null = the organization's). */
  ownerUserId: string | null | undefined;
  /** The work's team, when it is a team's: its token, not the owner's. */
  ownerTeamId?: string | null;
  /**
   * The provider the work picked (`resolveProviderForWork`), if any: a
   * gateway is used as picked, Bedrock rules the gateway out. Absent or null
   * = the workspace's default gateway, when it serves the agent.
   */
  provider?: ModelProviderRow | null;
  /**
   * What to do with a model the gateway doesn't serve (after the Claude
   * Code aliases are mapped by role): refuse the run, or take the catalog's
   * first model. Absent = refuse when the options name the model (someone
   * picked it for this work), else take the first (the legacy `model`
   * column, a repo's default, a review's or a chat's setting may predate
   * the gateway).
   */
  unservedModel?: "fail" | "first";
}

/** A resolved gateway run: what `podProviderRuntime` gives, with its parts. */
export interface GatewayRunRuntime {
  row: ModelProviderRow;
  agent: ModelProviderAgent;
  pick: GatewayModelPick;
  token: string;
  env: Record<string, string>;
  codexConfig: string[];
}

function gatewayAgent(agentType: string): ModelProviderAgent | null {
  return GATEWAY_RUN_AGENTS.includes(agentType) ? (agentType as ModelProviderAgent) : null;
}

/**
 * The gateway `use` runs through: the picked provider when it is one, else
 * the workspace's default when it serves the agent. Null when the work
 * picked another kind of provider, or there is no gateway for it.
 */
export async function gatewayForWork(
  use: Pick<GatewayRunUse, "agentType" | "workspaceId" | "provider">,
): Promise<ModelProviderRow | null> {
  const agent = gatewayAgent(use.agentType);
  if (!agent) return null;
  if (use.provider) return use.provider.kind === "gateway" ? use.provider : null;
  const row = await defaultGateway(use.workspaceId);
  return row && row.agents.includes(agent) ? row : null;
}

/**
 * The model the work takes from the gateway's catalog — its option
 * (`claudeModel` / `opencodeModel`, else `fallbackModel`), a Claude Code
 * alias (`sonnet`) standing for the catalog model with that `role`, else the
 * first model the gateway still serves — with the effort the model takes
 * (`gatewayModelPick`). A model the gateway doesn't serve is refused, or
 * replaced by the first one with `unservedModel: "first"`; an empty catalog
 * is always refused.
 */
export function gatewayPickForWork(
  row: ModelProviderRow,
  agent: ModelProviderAgent,
  agentOptions: Record<string, unknown> | null | undefined,
  fallbackModel?: string | null,
  unservedModel: "fail" | "first" = "fail",
): GatewayModelPick {
  const gateway = gatewayOf(row);
  const models = gateway.models[agent] ?? [];
  const key = gatewayModelOptionKey(agent);
  const asked = agentOptions?.[key];
  let wanted: string | undefined =
    typeof asked === "string" && asked.trim() ? asked.trim() : fallbackModel?.trim() || undefined;
  if (wanted && !models.some((m) => m.id === wanted)) {
    const role = MODEL_PROVIDER_MODEL_ROLES.find((r) => r === wanted);
    const stand = role ? models.find((m) => m.role === role && !m.missing) : undefined;
    if (stand) {
      wanted = stand.id;
    } else if (unservedModel === "first") {
      wanted = undefined;
    } else {
      throw new ModelProviderError(`"${row.name}" doesn't serve the model "${wanted}"`);
    }
  }
  const pick = gatewayModelPick(gateway, agent, { ...(agentOptions ?? {}), [key]: wanted });
  if (!pick) throw new ModelProviderError(`"${row.name}" has no models for ${agent} yet`);
  return pick;
}

/**
 * The gateway run for a piece of work, or null when it runs through no
 * gateway. Throws a `ModelProviderError` for a model the gateway doesn't
 * serve and a `GatewayTokenMissingError` for a missing token.
 */
export async function resolveGatewayRun(use: GatewayRunUse): Promise<GatewayRunRuntime | null> {
  const row = await gatewayForWork(use);
  if (!row) return null;
  const agent = use.agentType as ModelProviderAgent;
  const asked = use.agentOptions?.[gatewayModelOptionKey(agent)];
  const pick = gatewayPickForWork(
    row,
    agent,
    use.agentOptions,
    use.fallbackModel,
    use.unservedModel ?? (typeof asked === "string" && asked.trim() ? "fail" : "first"),
  );
  const token = await resolveGatewayToken({
    provider: row,
    workspaceId: use.workspaceId,
    ownerUserId: use.ownerUserId,
    ownerTeamId: use.ownerTeamId,
  });
  // Before any pod: a token the gateway already refuses (spent budget,
  // expired, rejected) fails the run now, saying whose it is and where to fix it.
  await gatewayPreflight({
    row,
    token,
    workspaceId: use.workspaceId,
    ownerUserId: use.ownerUserId,
    ownerTeamId: use.ownerTeamId,
    model: pick.model,
  });
  const { env, codexConfig } = podProviderRuntime(row, agent, pick, token);
  return { row, agent, pick, token, env, codexConfig };
}

/**
 * The gateway's env over `env`, and no other sign-in beside it:
 * `ANTHROPIC_API_KEY` goes when the token travels as `ANTHROPIC_AUTH_TOKEN`
 * (Claude Code would take the key first), `CLAUDE_CODE_OAUTH_TOKEN` always.
 */
export function applyGatewayEnv(
  env: Record<string, string>,
  run: Pick<GatewayRunRuntime, "env">,
): Record<string, string> {
  Object.assign(env, run.env);
  if (env.ANTHROPIC_AUTH_TOKEN) delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

/**
 * Claude Code's settings for a gateway run: no WebFetch preflight (it would
 * call api.anthropic.com) and the picked effort, which `gatewayModelPick`
 * already limited to what the model takes (the settings key persists up to
 * xhigh; `CLAUDE_CODE_EFFORT_LEVEL` in the env carries max).
 */
export function gatewayClaudeSettings(pick: GatewayModelPick): Record<string, unknown> {
  const settings: Record<string, unknown> = { skipWebFetchPreflight: true };
  if (pick.effort && pick.effort !== "max") settings.effortLevel = pick.effort;
  return settings;
}

/**
 * A pooled pod's env (a Job, a persistent agent, a session) for a gateway
 * run, over what `agentOptionsEnv` built: the gateway's env and nothing
 * that signs in elsewhere, the catalog's model as the CLI's `--model` with
 * no `[1m]` suffix, the effort only when the model takes it, the gateway's
 * settings, and no custom OpenCode endpoint beside the gateway's.
 */
export function applyGatewayRun(
  env: Record<string, string>,
  run: Pick<GatewayRunRuntime, "agent" | "pick" | "env">,
): Record<string, string> {
  delete env.CLAUDE_CODE_EFFORT_LEVEL;
  delete env.OPTIO_CLAUDE_CONTEXT_WINDOW;
  applyGatewayEnv(env, run);
  if (run.agent === "claude-code") {
    env.OPTIO_CLAUDE_MODEL = run.pick.model;
    let prior: Record<string, unknown> = {};
    try {
      const parsed: unknown = env.OPTIO_CLAUDE_SETTINGS_JSON
        ? JSON.parse(env.OPTIO_CLAUDE_SETTINGS_JSON)
        : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        prior = parsed as Record<string, unknown>;
      }
    } catch {
      prior = {};
    }
    delete prior.effortLevel;
    env.OPTIO_CLAUDE_SETTINGS_JSON = JSON.stringify({
      ...prior,
      ...gatewayClaudeSettings(run.pick),
    });
  } else if (run.agent === "opencode") {
    env.OPTIO_OPENCODE_MODEL = run.pick.model;
    delete env.OPTIO_OPENCODE_BASE_URL;
  }
  return env;
}

/**
 * The shell lines a pod's Claude Code command starts with on a gateway run:
 * the pod's own `ANTHROPIC_API_KEY`, if it has one, is unset when the token
 * travels as `ANTHROPIC_AUTH_TOKEN` — the same guard max-subscription mode
 * has.
 */
export function gatewayAuthSetup(env: Record<string, string>): string[] {
  return env.OPTIO_AUTH_MODE === GATEWAY_AUTH_MODE && env.ANTHROPIC_AUTH_TOKEN
    ? [`unset ANTHROPIC_API_KEY 2>/dev/null || true`]
    : [];
}

/** Whether a pod command may add the `[1m]` context suffix to the model: never on a gateway run. */
export function allowsContextSuffix(env: Record<string, string>): boolean {
  return env.OPTIO_AUTH_MODE !== GATEWAY_AUTH_MODE;
}

// ── Optio Local (docs/model-gateway.md, "On a machine") ─────────────────────

/**
 * The team whose work a terminal runs — a team's Repo Task or Job — so the
 * spawn carries the team's token rather than the person's.
 */
export async function terminalWorkTeam(row: {
  taskId: string | null;
  workflowRunId: string | null;
}): Promise<string | null> {
  if (row.taskId) {
    const [task] = await db
      .select({ ownerTeamId: tasks.ownerTeamId })
      .from(tasks)
      .where(eq(tasks.id, row.taskId));
    return task?.ownerTeamId ?? null;
  }
  if (row.workflowRunId) {
    const [run] = await db
      .select({ ownerTeamId: workflowRuns.ownerTeamId })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, row.workflowRunId));
    return run?.ownerTeamId ?? null;
  }
  return null;
}

/**
 * The spawn frame's spec for a terminal that runs through a gateway: the
 * provider launch with the owner's own token in its env — it is their token
 * going to their own machine — the catalog's model, and the effort only
 * when the model takes it. Resolved at spawn time and never stored on the
 * row. Any other spec passes through; `{ error }` says why the terminal
 * can't start.
 */
export async function gatewaySpawnSpec(
  row: {
    userId: string | null;
    workspaceId: string | null;
    taskId: string | null;
    workflowRunId: string | null;
  },
  spec: LocalTerminalSpec,
): Promise<{ spec: LocalTerminalSpec } | { error: string }> {
  if (spec.kind !== "agent" || spec.provider?.kind !== "gateway") return { spec };
  const providerRow = await getModelProviderRow(spec.provider.providerId);
  if (!providerRow || providerRow.kind !== "gateway") {
    return { error: "The model gateway this session uses was removed — pick another" };
  }
  const agent = gatewayAgent(spec.agent);
  if (!agent || !providerRow.agents.includes(agent)) {
    return { error: `"${providerRow.name}" isn't set up for ${spec.agent}` };
  }
  try {
    const pick = gatewayPickForWork(providerRow, agent, {
      [gatewayModelOptionKey(agent)]: spec.model,
      claudeEffort: spec.effort,
    });
    const token = await resolveGatewayToken({
      provider: providerRow,
      workspaceId: row.workspaceId,
      ownerUserId: row.userId,
      ownerTeamId: await terminalWorkTeam(row),
    });
    const { effort: _effort, ...rest } = spec;
    return {
      spec: {
        ...rest,
        model: pick.model,
        ...(pick.effort ? { effort: pick.effort } : {}),
        // With the catalog's prices, so the machine's usage tracker prices
        // the session at the gateway's rates (`createTerminal` did the same).
        provider: withPriceCatalog(
          providerLaunch(providerRow, { agent, pick, token }),
          providerRow,
          agent,
        ),
      },
    };
  } catch (err) {
    if (err instanceof ModelProviderError) return { error: err.message };
    throw err;
  }
}
