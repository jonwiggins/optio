import {
  catalogPrice,
  costForTokens,
  modelProviderIdFrom,
  stripModelContextSuffix,
  type AgentModelUsage,
  type AgentResult,
  type ModelPrice,
  type ModelProviderModel,
} from "@optio/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { prReviews, workDefinitions, workflowRuns } from "../db/schema.js";
import { implicitGateway } from "./model-gateway-service.js";
import { getModelProviderRow, type ModelProviderRow } from "./model-provider-service.js";
import { logger } from "../logger.js";

/**
 * What a run cost, as the usage ledger should see it (docs/model-gateway.md
 * "Usage"). Claude Code's `total_cost_usd` is its own guess from the public
 * price list — wrong for a gateway's internal model name, and wrong for a
 * negotiated rate. A run through a gateway is priced here from the
 * catalog's prices for each model it called (`modelUsage`): that is an
 * **estimate**; a model the catalog doesn't price leaves the cost
 * **unknown** (never zero). A run with no gateway keeps the figure the agent
 * reported, as before. The recorded model is the gateway model that took
 * the most tokens, named as the gateway names it (no `[1m]`).
 *
 * The workers call `priceRun` once, right before `addUsage`, and spread its
 * answer over the agent's result; the ledger trigger reads `cost_usd`,
 * `cost_basis` and `model_used` from the row.
 */

export type CostBasis = "reported" | "estimated" | "unknown";

export interface PricedModel {
  model: string;
  tokens: AgentModelUsage;
  /** USD at the catalog's prices; null when the catalog doesn't price it. */
  costUsd: number | null;
}

export interface PricedRun {
  /** Undefined when unknown — spread over the result, it leaves the row's cost alone. */
  costUsd: number | undefined;
  costBasis: CostBasis;
  model: string | undefined;
  perModel: PricedModel[];
  /** The gateway that priced the run, when one did. */
  gatewayId?: string;
}

/**
 * Where the run came from, enough to find its gateway: the task's own
 * workspace and agent options, or a Job run / review the pricing looks up
 * (their workers don't carry the work definition at settle time).
 */
export type RunScope =
  | {
      workspaceId: string | null | undefined;
      agentOptions?: Record<string, unknown> | null;
      /** An explicit provider id wins over the agent options. */
      providerId?: string | null;
      /** The run's agent: the default gateway priced it only if it serves this agent. */
      agentType?: string | null;
    }
  | { workflowRunId: string }
  | { prReviewId: string; agentType?: string | null };

export interface PriceRunInput {
  scope: RunScope;
  /** The agent's result: `modelUsage` when it reported one, else the totals. */
  result: Pick<
    AgentResult,
    | "modelUsage"
    | "costUsd"
    | "costBasis"
    | "model"
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
  >;
}

/** The id + prices of a gateway's catalog, every agent's models together. */
export function gatewayPriceCatalog(
  row: Pick<ModelProviderRow, "kind" | "models">,
  agent?: string,
): ModelProviderModel[] {
  if (row.kind !== "gateway") return [];
  const models = (row.models ?? {}) as Record<string, ModelProviderModel[] | undefined>;
  const lists = agent ? [models[agent] ?? []] : Object.values(models);
  const out: ModelProviderModel[] = [];
  for (const list of lists) {
    for (const m of list ?? []) {
      if (!m || typeof m.id !== "string" || out.some((o) => o.id === m.id)) continue;
      out.push(m.prices ? { id: m.id, prices: m.prices } : { id: m.id });
    }
  }
  return out;
}

/**
 * The run's gateway: the one it picked, else the workspace's default when it
 * serves the run's agent — the gateway the run went through
 * (gateway-run-service.ts `gatewayForWork`), whatever OPTIO_MODEL_ACCESS says.
 */
async function gatewayFor(scope: RunScope): Promise<ModelProviderRow | null> {
  let workspaceId: string | null | undefined;
  let providerId: string | undefined;
  let agentType: string | null | undefined;
  if ("workflowRunId" in scope) {
    const [row] = await db
      .select({
        workspaceId: workDefinitions.workspaceId,
        agentOptions: workDefinitions.agentOptions,
        agentType: workflowRuns.agentType,
      })
      .from(workflowRuns)
      .innerJoin(workDefinitions, eq(workDefinitions.id, workflowRuns.workflowId))
      .where(eq(workflowRuns.id, scope.workflowRunId));
    if (!row) return null;
    workspaceId = row.workspaceId;
    providerId = modelProviderIdFrom(row.agentOptions as Record<string, unknown> | null);
    agentType = row.agentType;
  } else if ("prReviewId" in scope) {
    const [row] = await db
      .select({ workspaceId: prReviews.workspaceId })
      .from(prReviews)
      .where(eq(prReviews.id, scope.prReviewId));
    if (!row) return null;
    workspaceId = row.workspaceId;
    agentType = scope.agentType;
  } else {
    workspaceId = scope.workspaceId;
    providerId = scope.providerId ?? modelProviderIdFrom(scope.agentOptions);
    agentType = scope.agentType;
  }
  if (providerId) {
    const row = await getModelProviderRow(providerId);
    return row?.kind === "gateway" ? row : null;
  }
  // No pick: in a gateway-only deployment the default gateway took the run
  // if it serves the run's agent (`implicitGateway`); otherwise the vendor
  // did, as reported.
  const row = await implicitGateway(workspaceId);
  if (!row) return null;
  if (agentType && !(row.agents ?? []).includes(agentType)) return null;
  return row;
}

/** The run's tokens per model: `modelUsage`, else the totals under the reported model. */
function tokensPerModel(result: PriceRunInput["result"]): Record<string, AgentModelUsage> {
  if (result.modelUsage && Object.keys(result.modelUsage).length > 0) return result.modelUsage;
  const model = result.model ? stripModelContextSuffix(result.model) : "";
  const input = result.inputTokens ?? 0;
  const cacheRead = result.cacheReadTokens ?? 0;
  const cacheWrite = result.cacheWriteTokens ?? 0;
  if (!model || (input === 0 && (result.outputTokens ?? 0) === 0)) return {};
  return {
    [model]: {
      // `inputTokens` on a result counts the cache tokens too.
      inputTokens: Math.max(0, input - cacheRead - cacheWrite),
      outputTokens: result.outputTokens ?? 0,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    },
  };
}

/** The agent's figures, as today (no gateway). */
function reported(result: PriceRunInput["result"]): PricedRun {
  const costUsd = typeof result.costUsd === "number" ? result.costUsd : undefined;
  return {
    costUsd,
    costBasis: costUsd === undefined ? "unknown" : (result.costBasis ?? "reported"),
    model: result.model ? stripModelContextSuffix(result.model) : undefined,
    perModel: [],
  };
}

/** Price `tokens` at a gateway's catalog; the pure part of `priceRun`. */
export function priceAtCatalog(
  catalog: ReadonlyArray<ModelProviderModel>,
  tokens: Record<string, AgentModelUsage>,
): Omit<PricedRun, "gatewayId"> {
  const perModel: PricedModel[] = Object.entries(tokens).map(([model, t]) => {
    const price: ModelPrice | null = catalogPrice(model, catalog);
    return { model, tokens: t, costUsd: price ? costForTokens(t, price) : null };
  });
  const busiest = perModel.reduce<PricedModel | null>((best, m) => {
    const n = (x: PricedModel) =>
      x.tokens.inputTokens +
      x.tokens.outputTokens +
      x.tokens.cacheReadTokens +
      x.tokens.cacheWriteTokens;
    return !best || n(m) > n(best) ? m : best;
  }, null);
  // A single unpriced model leaves the whole run unknown: a partial sum
  // would read as the run's cost and be wrong.
  const unpriced = perModel.some((m) => m.costUsd === null);
  const total = perModel.reduce((sum, m) => sum + (m.costUsd ?? 0), 0);
  return {
    costUsd: perModel.length > 0 && !unpriced ? Math.round(total * 1e6) / 1e6 : undefined,
    costBasis: perModel.length > 0 && !unpriced ? "estimated" : "unknown",
    model: busiest?.model,
    perModel,
  };
}

/**
 * The agent's result with the priced cost, basis and model in place of the
 * reported ones — what the workers hand `addUsage`. An unknown cost leaves
 * `costUsd` and `costBasis` out, so the row's columns stay as they were
 * (the ledger records a run without a cost as `unknown` on its own).
 */
export async function pricedUsage(
  scope: RunScope,
  result: AgentResult,
): Promise<Omit<AgentResult, "costBasis"> & { costBasis?: CostBasis }> {
  const priced = await priceRun({ scope, result });
  const { costBasis: _reportedBasis, ...rest } = result;
  return {
    ...rest,
    costUsd: priced.costUsd,
    ...(priced.costUsd !== undefined ? { costBasis: priced.costBasis } : {}),
    model: priced.model,
  };
}

/** `providerLaunch(row)` plus the catalog's ids and prices, for a machine's usage tracker. */
export function withPriceCatalog<T extends object>(
  launch: T,
  row: Pick<ModelProviderRow, "kind" | "models">,
  agent?: string,
): T & { models?: ModelProviderModel[] } {
  const models = gatewayPriceCatalog(row, agent);
  return models.length > 0 ? { ...launch, models } : launch;
}

/**
 * A run's cost, basis and model for its row: at the gateway's prices when
 * it ran through one, else as the agent reported. Never throws — a lookup
 * that fails leaves the reported figures (and logs why).
 */
export async function priceRun(input: PriceRunInput): Promise<PricedRun> {
  let gateway: ModelProviderRow | null = null;
  try {
    gateway = await gatewayFor(input.scope);
  } catch (err) {
    logger.warn({ err }, "Could not find the run's gateway; recording the reported cost");
  }
  if (!gateway) return reported(input.result);
  const tokens = tokensPerModel(input.result);
  if (Object.keys(tokens).length === 0) {
    // Nothing measured: no cost can be estimated, and the agent's own
    // guess is not the gateway's price.
    return {
      costUsd: undefined,
      costBasis: "unknown",
      model: input.result.model ? stripModelContextSuffix(input.result.model) : undefined,
      perModel: [],
      gatewayId: gateway.id,
    };
  }
  return { ...priceAtCatalog(gatewayPriceCatalog(gateway), tokens), gatewayId: gateway.id };
}
