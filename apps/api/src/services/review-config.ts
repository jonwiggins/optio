/**
 * Resolves the review agent type and model for a repo, applying the inheritance
 * chain described in the agent-aware review configuration design.
 *
 * Both `review-service.ts` (subtask reviews on Optio-opened PRs) and
 * `pr-review-worker.ts` (external PR review runs) call this helper so there
 * is one source of truth for the resolution order.
 *
 * Resolution order (first non-null wins):
 *   1. repos.reviewAgentType                     (per-repo override)
 *   2. repos.defaultAgentType                    (the repo's primary agent)
 *   3. global defaultReviewAgentType             (workspace-level setting)
 *   4. global defaultAgentType                   (not currently exposed; reserved)
 *   5. "claude-code"                             (final fallback)
 *
 * Model uses the same chain — repos.reviewModel → global defaultReviewModel →
 * the resolved agent's catalog default. If a stored model doesn't belong to
 * the resolved agent's catalog (e.g. legacy "sonnet" with a Gemini agent) we
 * silently drop it and fall back to the catalog default rather than erroring.
 */

import {
  PROVIDER_CATALOGS,
  modelBelongsToAgentCatalog,
  providerForAgentType,
  resolveModelId,
  type AgentType,
} from "@optio/shared";

export interface ReviewConfigInputs {
  /** Per-repo review override (column `repos.review_agent_type`). */
  repoReviewAgentType?: string | null;
  /** Repo's primary agent (column `repos.default_agent_type`). */
  repoDefaultAgentType?: string | null;
  /** Per-repo review model (column `repos.review_model`). */
  repoReviewModel?: string | null;
  /** Global default review agent (column `optio_settings.default_review_agent_type`). */
  globalDefaultReviewAgentType?: string | null;
  /** Global default review model (column `optio_settings.default_review_model`). */
  globalDefaultReviewModel?: string | null;
}

export interface ReviewConfigResolved {
  agentType: AgentType;
  model: string;
}

const FALLBACK_AGENT: AgentType = "claude-code";

function pickAgentType(inputs: ReviewConfigInputs): AgentType {
  const candidates = [
    inputs.repoReviewAgentType,
    inputs.repoDefaultAgentType,
    inputs.globalDefaultReviewAgentType,
  ];
  for (const c of candidates) {
    if (c && typeof c === "string") return c as AgentType;
  }
  return FALLBACK_AGENT;
}

function defaultModelForAgent(agentType: AgentType): string {
  const provider = providerForAgentType(agentType);
  const catalog = PROVIDER_CATALOGS[provider];
  if (!catalog) return "";
  // Resolve with empty input so resolveModelId picks the latest-of-family / first.
  return resolveModelId(provider, undefined) ?? catalog.models[0]?.id ?? "";
}

export function resolveReviewConfig(inputs: ReviewConfigInputs): ReviewConfigResolved {
  const agentType = pickAgentType(inputs);

  const candidates = [inputs.repoReviewModel, inputs.globalDefaultReviewModel];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (modelBelongsToAgentCatalog(agentType, candidate)) {
      return { agentType, model: candidate };
    }
    // Stored model belongs to a different agent's catalog — ignore and keep
    // looking. This is the "legacy reviewModel=sonnet on Gemini repo" path
    // described in the design doc.
  }

  return { agentType, model: defaultModelForAgent(agentType) };
}
