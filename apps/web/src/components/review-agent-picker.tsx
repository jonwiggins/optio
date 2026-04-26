"use client";

/**
 * Two-step picker for the code-review agent: agent type → model.
 *
 * Used on /repos/new, /repos/[id], and /settings. When `allowInherit` is true
 * (per-repo pages) an "Inherit from repo default" option appears at the top of
 * the agent dropdown that sets `agentType = null`. The settings page passes
 * `allowInherit=false` since the workspace-level default is the bottom of the
 * inheritance chain — there's nothing above it to inherit from.
 */

import {
  AGENT_TYPES,
  PROVIDER_CATALOGS,
  providerForAgentType,
  resolveModelId,
  type AgentType,
} from "@optio/shared";

const AGENT_LABELS: Record<AgentType, string> = {
  "claude-code": "Claude Code",
  codex: "OpenAI Codex",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
  gemini: "Google Gemini",
  openclaw: "OpenClaw",
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

const DEFAULT_SELECT_CLASS =
  "w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20";

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

  // When inheriting, the model dropdown is meaningless — the resolver picks it.
  const inheriting = agentType === null;
  const catalog = inheriting ? null : PROVIDER_CATALOGS[providerForAgentType(agentType!)];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-text-muted mb-1">Review Agent</label>
          <select
            value={inheriting ? "__inherit__" : (agentType ?? "")}
            onChange={(e) => handleAgentChange(e.target.value)}
            className={selectClass}
          >
            {allowInherit && <option value="__inherit__">Inherit from repo default</option>}
            {AGENT_TYPES.map((t) => (
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
