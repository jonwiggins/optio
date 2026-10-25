import {
  effortFor,
  getProviderCatalog,
  providerForAgentType,
  type ProviderCatalog,
} from "@optio/shared";
import { getProviderOptions } from "./agent-options-service.js";
import type { GatewayRunRuntime } from "./gateway-run-service.js";
import { gatewayOf } from "./model-provider-service.js";

/**
 * The effort a run hands its agent, checked against the model it runs
 * (`effortFor`): a model that takes none (Claude Haiku 4.5, a gateway model
 * that lists no efforts) gets no `--effort`, no `CLAUDE_CODE_EFFORT_LEVEL`
 * and no `effortLevel`, instead of a CLI that refuses to start. A repo's
 * `claudeEffort` defaults to "high", so without this every run on such a
 * model would carry one.
 */

/** The option key that holds an agent's effort, when it has one. */
function effortKey(agentType: string): "claudeEffort" | "copilotEffort" | null {
  if (agentType === "claude-code") return "claudeEffort";
  // Codex shares Copilot's columns (copilotModel / copilotEffort).
  if (agentType === "copilot" || agentType === "codex") return "copilotEffort";
  return null;
}

/**
 * The catalog a run's effort is checked against: the live one (the
 * workspace's gateway's, or the vendor's with its per-model efforts), else
 * the baseline when the probe can't be reached.
 */
export async function effortCatalog(
  agentType: string,
  workspaceId?: string | null,
): Promise<ProviderCatalog | undefined> {
  const provider = providerForAgentType(agentType);
  try {
    return (await getProviderOptions(provider, { workspaceId })).catalog;
  } catch {
    return getProviderCatalog(provider);
  }
}

/** `effort` when `model` takes it, by the agent's catalog. */
export async function runEffort(
  agentType: string,
  model: string | null | undefined,
  effort: string | null | undefined,
  workspaceId?: string | null,
): Promise<string | undefined> {
  if (!effort) return undefined;
  return effortFor(await effortCatalog(agentType, workspaceId), model, effort);
}

/**
 * A gateway run's effort, by the gateway's own catalog: a model that lists
 * no efforts takes none (the gateway's "absent = none offered"), even when
 * it names a default.
 */
export function gatewayEffort(
  run: Pick<GatewayRunRuntime, "row" | "agent" | "pick">,
): string | undefined {
  return effortFor(gatewayOf(run.row).models[run.agent], run.pick.model, run.pick.effort, {
    strict: true,
  });
}

/**
 * A pooled run's options without an effort its model doesn't take, for
 * `agentOptionsEnv`. The model is the options' own (`claudeModel`,
 * `copilotModel`), else `fallbackModel` (the legacy `model` column).
 */
export async function withModelEfforts<T extends Record<string, string | boolean>>(
  agentType: string,
  options: T | null,
  fallbackModel: string | null | undefined,
  workspaceId?: string | null,
): Promise<T | null> {
  const key = effortKey(agentType);
  const effort = key && options ? options[key] : undefined;
  if (!key || !options || typeof effort !== "string" || !effort) return options;
  const catalog = await effortCatalog(agentType, workspaceId);
  const named = catalog ? options[catalog.modelField] : undefined;
  const model = typeof named === "string" && named ? named : fallbackModel;
  if (effortFor(catalog, model, effort)) return options;
  const { [key]: _dropped, ...rest } = options;
  return rest as T;
}
