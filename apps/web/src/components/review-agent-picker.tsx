"use client";

/**
 * Two-step picker for the code-review agent: agent type → model.
 *
 * Used on /repos/new, /repos/[id], and /settings. When `allowInherit` is true
 * (per-repo pages) an "Inherit from repo default" option appears at the top of
 * the agent dropdown that sets `agentType = null`. The settings page passes
 * `allowInherit=false` since the workspace-level default is the bottom of the
 * inheritance chain — there's nothing above it to inherit from.
 *
 * The model list is the same live catalog the agent and repo pickers show
 * (`GET /api/agents/:provider/options`, #644): the baseline until it loads,
 * and still the baseline when the live probe is unavailable.
 *
 * The deployment features narrows the agents to those it offers, and a
 * gateway-only deployment (the restricted deployment) lists the default model
 * gateway's catalog (`useDefaultGateway`), the way the New work form does.
 */

import { useEffect, useState } from "react";
import { AgentIcon } from "@/components/brand-icon";
import { inputClass } from "@/components/ui/input";
import { api } from "@/lib/api-client";
import { useFeatures } from "@/hooks/use-features";
import { useDefaultGateway } from "@/hooks/use-default-gateway";
import { gatewayCatalogFor } from "@/components/gateway-catalog";
import {
  AGENT_TYPES,
  featureFilter,
  PROVIDER_CATALOGS,
  providerForAgentType,
  resolveModelId,
  type AgentProviderId,
  type AgentType,
  type ProviderCatalog,
} from "@optio/shared";

const AGENT_LABELS: Record<AgentType, string> = {
  "claude-code": "Claude Code",
  codex: "OpenAI Codex",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
  gemini: "Google Gemini",
  openclaw: "OpenClaw",
  cursor: "Cursor",
};

export interface ReviewAgentPickerProps {
  /** Currently selected agent type. `null` means "inherit". */
  agentType: AgentType | null;
  onAgentTypeChange: (next: AgentType | null) => void;
  /** Currently selected model (or alias). Empty string means "use catalog default". */
  model: string;
  onModelChange: (next: string) => void;
  /** Show the "Inherit" option in the agent dropdown. */
  allowInherit?: boolean;
  /**
   * When `agentType === null`, render this hint underneath the model dropdown.
   * Intended to be the resolved effective value, e.g. "Reviews will run with:
   * gemini · gemini-2.5-pro".
   */
  inheritedHint?: string;
  /** Optional class applied to all select controls. */
  selectClass?: string;
}

const DEFAULT_SELECT_CLASS = inputClass();

export function ReviewAgentPicker({
  agentType,
  onAgentTypeChange,
  model,
  onModelChange,
  allowInherit = false,
  inheritedHint,
  selectClass = DEFAULT_SELECT_CLASS,
}: ReviewAgentPickerProps) {
  const handleAgentChange = (value: string) => {
    if (value === "__inherit__") {
      onAgentTypeChange(null);
      // Reset the model when switching to inherit so we don't carry stale ids.
      onModelChange("");
      return;
    }
    const next = value as AgentType;
    onAgentTypeChange(next);
    // Reset model to that agent's catalog default whenever the agent changes.
    const defaultModelId = resolveModelId(providerForAgentType(next), undefined) ?? "";
    onModelChange(defaultModelId);
  };

  const { features, gatewayOnly } = useFeatures();
  // A saved agent the runtime list no longer offers stays listed, so the select shows it.
  const offered = featureFilter("runtimes", AGENT_TYPES, features);
  const agentTypes = agentType && !offered.includes(agentType) ? [...offered, agentType] : offered;

  // When inheriting, the model dropdown is meaningless — the resolver picks it.
  const inheriting = agentType === null;
  const provider: AgentProviderId | null = inheriting ? null : providerForAgentType(agentType!);
  const { gateway, models: gatewayModels } = useDefaultGateway(
    agentType ?? "",
    gatewayOnly && !inheriting,
  );
  const baseline = provider
    ? gateway
      ? gatewayCatalogFor(PROVIDER_CATALOGS[provider], gateway.name, gatewayModels ?? [])
      : PROVIDER_CATALOGS[provider]
    : null;
  // Through a gateway the list is its catalog, cached apart from the vendor's.
  const liveKey = provider && gateway ? `${provider}:${gateway.id}` : provider;

  // The live list per provider, fetched once each; the baseline meanwhile.
  const [live, setLive] = useState<Partial<Record<string, ProviderCatalog>>>({});
  useEffect(() => {
    if (!provider || !liveKey || live[liveKey]) return;
    let cancelled = false;
    (gateway
      ? api.getAgentProviderOptions(provider, { gateway: gateway.id })
      : api.getAgentProviderOptions(provider)
    )
      .then((res) => {
        if (!cancelled && res.catalog) {
          setLive((prev) => ({ ...prev, [liveKey]: res.catalog as ProviderCatalog }));
        }
      })
      .catch(() => {
        // The baseline stays on; the server says why in its own log.
      });
    return () => {
      cancelled = true;
    };
  }, [provider, liveKey, gateway?.id, live]);

  const catalog = provider && liveKey ? (live[liveKey] ?? baseline) : null;
  // A saved model the list doesn't offer (an alias, or the live list is
  // down): keep it selectable rather than silently showing another.
  const unlisted =
    !!catalog && !!model && !catalog.modelIsFreeText && !catalog.models.some((m) => m.id === model);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="flex items-center gap-1.5 text-xs text-text-muted mb-1">
            {!inheriting && agentType && <AgentIcon runtime={agentType} className="w-3 h-3" />}
            Review Agent
          </label>
          <select
            value={inheriting ? "__inherit__" : (agentType ?? "")}
            onChange={(e) => handleAgentChange(e.target.value)}
            className={selectClass}
          >
            {allowInherit && <option value="__inherit__">Inherit from repo default</option>}
            {agentTypes.map((t) => (
              <option key={t} value={t}>
                {AGENT_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Review Model</label>
          {inheriting || !catalog ? (
            <select value="" disabled className={selectClass}>
              <option value="">—</option>
            </select>
          ) : catalog.modelIsFreeText ? (
            <input
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              placeholder={catalog.modelPlaceholder ?? ""}
              className={selectClass}
            />
          ) : (
            <select
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              className={selectClass}
            >
              {!model && <option value="">Default</option>}
              {unlisted && (
                <option value={model}>
                  {catalog.aliases[model] ? `${model} (latest ${catalog.aliases[model]})` : model}
                </option>
              )}
              {catalog.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.latest ? " (latest)" : ""}
                  {m.preview ? " (Preview)" : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      {inheriting && inheritedHint && (
        <p className="text-[10px] text-text-muted/70">{inheritedHint}</p>
      )}
    </div>
  );
}
