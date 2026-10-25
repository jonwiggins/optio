import {
  MODEL_PROVIDER_OPTION_KEY,
  getProviderCatalog,
  gatewayModelOptionKey,
  isModelProviderAgent,
  modelProviderIdFrom,
  providerForAgentType,
  type ModelProvider,
  type ModelProviderModel,
} from "@optio/shared";
import { TERMINAL } from "@/components/agent-choice-model";
import type { WorkDraft } from "./model";

/**
 * The New work form's side of the model gateway (docs/model-gateway.md):
 * which gateway a draft runs through when it names none — the workspace's
 * default, as `GET /api/gateway/me` reports it, else the organization's
 * first that serves the runtime, the way the server stands one in — and
 * the model it then picks from that gateway's catalog.
 */

/** The gateways the draft could run through: the organization's and yours, serving the runtime. */
export function gatewayChoices(d: WorkDraft, providers: ModelProvider[]): ModelProvider[] {
  if (d.runtime === TERMINAL || !isModelProviderAgent(d.runtime)) return [];
  const runtime = d.runtime;
  return providers.filter(
    (p) => p.kind === "gateway" && p.agents.includes(runtime) && (p.ownerUserId === null || p.mine),
  );
}

/**
 * The gateway the draft runs through: the provider it picked when that is
 * a gateway; else, in a gateway-only deployment, the default one (or the
 * organization's first). Null when it picked another kind, or none serves
 * the runtime.
 */
export function gatewayFor(
  d: WorkDraft,
  providers: ModelProvider[],
  defaultGatewayId: string | null,
  gatewayOnly: boolean,
): ModelProvider | null {
  const choices = gatewayChoices(d, providers);
  const pickedId = modelProviderIdFrom(d.agentOptions);
  if (pickedId) {
    const picked = providers.find((p) => p.id === pickedId);
    return picked?.kind === "gateway" && choices.includes(picked) ? picked : null;
  }
  if (!gatewayOnly) return null;
  return (
    choices.find((p) => p.id === defaultGatewayId) ??
    choices.find((p) => p.ownerUserId === null) ??
    null
  );
}

/** The gateway's models for the draft's runtime. */
export function gatewayModelsFor(
  d: WorkDraft,
  gateway: ModelProvider | null,
): ModelProviderModel[] {
  if (!gateway || d.runtime === TERMINAL || !isModelProviderAgent(d.runtime)) return [];
  return gateway.models[d.runtime] ?? [];
}

/**
 * The draft with a model the gateway serves: its own when the catalog has
 * it, else the first model still served (the server refuses an id the
 * gateway doesn't serve, and the picker would show "Pick a model"). The
 * context-window option goes too — the catalog says it per model.
 */
export function withGatewayModel(d: WorkDraft, gateway: ModelProvider | null): WorkDraft {
  if (!gateway || d.runtime === TERMINAL || !isModelProviderAgent(d.runtime)) return d;
  const models = gatewayModelsFor(d, gateway);
  const key = gatewayModelOptionKey(d.runtime);
  const catalogField = getProviderCatalog(providerForAgentType(d.runtime))?.modelField ?? key;
  const current = d.agentOptions[catalogField];
  const options = { ...d.agentOptions };
  let changed = false;
  if (typeof current !== "string" || !models.some((m) => m.id === current)) {
    const first = models.find((m) => !m.missing) ?? models[0];
    if (first) {
      options[catalogField] = first.id;
      changed = true;
    }
  }
  if ("claudeContextWindow" in options && d.runtime === "claude-code") {
    delete options.claudeContextWindow;
    changed = true;
  }
  return changed ? { ...d, agentOptions: options } : d;
}

/** Whether the draft names this gateway explicitly (vs. riding the default). */
export function picksGateway(d: WorkDraft, gateway: ModelProvider | null): boolean {
  return !!gateway && d.agentOptions[MODEL_PROVIDER_OPTION_KEY] === gateway.id;
}
