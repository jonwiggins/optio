"use client";

import type { ReactNode } from "react";
import { CornerDownRight } from "lucide-react";
import { providerForAgentType, type AgentType, type ModelProviderModel } from "@optio/shared";
import { cn } from "@/lib/utils";
import { AgentIcon } from "@/components/brand-icon";
import { AgentOptionsPicker, type AgentOptionsValues } from "@/components/agent-options-picker";
import {
  RUNTIMES,
  TERMINAL,
  defaultModelFor,
  reviewModelField,
  runtimeLabel,
} from "@/components/agent-choice-model";

/**
 * Pick an agent runtime and its parameters: the logo button grid, a note
 * under it, then "<agent> parameters" — the model provider (where one
 * serves the runtime) and the live model / effort / option controls from
 * `GET /api/agents/:provider/options`. The New work form's Who section and
 * a repo's default-agent settings both render this, so the choices and the
 * options they offer are always the same.
 *
 * The "" choice (`TERMINAL`) is "no agent": a bare terminal in the work
 * form, "same as coding" for a review agent. It shows only when `runtimes`
 * lists it.
 */
export interface AgentChoiceProps {
  runtime: string;
  agentOptions: AgentOptionsValues;
  onRuntimeChange: (runtime: string) => void;
  onOptionsChange: (options: AgentOptionsValues) => void;
  /** The choices in order, each with why it can't be picked (if it can't). Default: every agent. */
  runtimes?: Array<{ value: string; disabled?: string }>;
  /** Label and icon of the "" choice. Default "Terminal" with the terminal mark. */
  emptyLabel?: string;
  emptyIcon?: ReactNode;
  /** The line under the grid; the first disabled choice's reason is appended. */
  note?: ReactNode;
  /** Right side of the "<agent> parameters" heading. */
  paramsHint?: ReactNode;
  /** Shown instead of the picker for a runtime with nothing to set here. */
  paramsNote?: ReactNode;
  /** Below the picker (e.g. "Repo defaults · Reset"). */
  footer?: ReactNode;
  /** The "Signed in with" row (the agent's credentials and model providers), above the parameters. */
  signIn?: ReactNode;
  /** A picked provider's models, which replace the catalog's. */
  providerModels?: ModelProviderModel[];
  runsOn?: "pod" | "local";
  hostId?: string;
  /** Only the model control (a review agent takes just a model). */
  modelOnly?: boolean;
  hideRefresh?: boolean;
  "aria-label"?: string;
}

export const ALL_AGENT_RUNTIMES = RUNTIMES.map((r) => ({ value: r.value }));

export function choiceLabel(value: string, emptyLabel = "Terminal"): string {
  return value === TERMINAL ? emptyLabel : runtimeLabel(value);
}

export function AgentChoice({
  runtime,
  agentOptions,
  onRuntimeChange,
  onOptionsChange,
  runtimes = ALL_AGENT_RUNTIMES,
  emptyLabel = "Terminal",
  emptyIcon,
  note,
  paramsHint,
  paramsNote,
  footer,
  signIn,
  providerModels,
  runsOn = "pod",
  hostId,
  modelOnly = false,
  hideRefresh = true,
  "aria-label": ariaLabel,
}: AgentChoiceProps) {
  const disabled = runtimes.filter((r) => r.disabled);
  const label = (v: string) => choiceLabel(v, emptyLabel);
  return (
    <div className="space-y-3">
      <div
        role="group"
        aria-label={ariaLabel}
        className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 p-1 rounded-lg bg-bg border border-border"
      >
        {runtimes.map((r) => (
          <button
            key={r.value || "terminal"}
            type="button"
            title={r.disabled ? `${label(r.value)} ${r.disabled}` : undefined}
            disabled={!!r.disabled}
            aria-pressed={runtime === r.value}
            onClick={() => onRuntimeChange(r.value)}
            className={cn(
              "flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors whitespace-nowrap",
              runtime === r.value
                ? "bg-primary text-white"
                : r.disabled
                  ? "text-text-muted/40 cursor-not-allowed"
                  : "text-text-muted hover:text-text",
            )}
          >
            {r.value === TERMINAL && emptyIcon ? emptyIcon : <AgentIcon runtime={r.value} />}
            {label(r.value)}
          </button>
        ))}
      </div>
      {(note || disabled.length > 0) && (
        <p className="text-[11px] text-text-muted/80">
          {note}
          {disabled.length > 0 &&
            ` ${disabled.map((r) => label(r.value)).join(", ")} — ${disabled[0].disabled!.replace(/\.$/, "")}.`}
        </p>
      )}

      {runtime !== TERMINAL && (
        <div className="pt-3 border-t border-border">
          <div className="flex items-baseline justify-between mb-2">
            <span className="inline-flex items-center gap-1.5 text-sm text-text-muted">
              <AgentIcon runtime={runtime} />
              {runtimeLabel(runtime)} parameters
            </span>
            {paramsHint && <span className="text-[11px] text-text-muted/70">{paramsHint}</span>}
          </div>
          {paramsNote ? (
            <p className="text-xs text-text-muted">{paramsNote}</p>
          ) : (
            <>
              {signIn && <div className="mb-3">{signIn}</div>}
              <AgentOptionsPicker
                key={runtime}
                providerModels={providerModels}
                provider={providerForAgentType(runtime)}
                values={agentOptions}
                onChange={onOptionsChange}
                runsOn={runsOn}
                hostId={hostId}
                modelOnly={modelOnly}
                hideRefresh={hideRefresh}
              />
            </>
          )}
          {footer}
        </div>
      )}
    </div>
  );
}

/** "Repo defaults · Reset" / "Changed from the repo's defaults · Reset" (and kin). */
export function DefaultsHint({
  children,
  onReset,
  testId,
}: {
  children: ReactNode;
  onReset: () => void;
  testId?: string;
}) {
  return (
    <p className="mt-2 text-[11px] text-text-muted/70" data-testid={testId}>
      {children} ·{" "}
      <button type="button" onClick={onReset} className="text-primary hover:underline">
        Reset
      </button>
    </p>
  );
}

/**
 * The code-review agent, in the same controls: the runtime grid with a
 * "Repo default" choice first (`agentType` null — the review runs with what
 * the repo's coding agent resolves to), then that agent's model only.
 * Picking an agent starts its model at the catalog default.
 */
export function ReviewAgentChoice({
  agentType,
  model,
  onChange,
  inheritedHint,
}: {
  agentType: AgentType | null;
  model: string;
  onChange: (agentType: AgentType | null, model: string) => void;
  inheritedHint?: string;
}) {
  const runtime = agentType ?? TERMINAL;
  const field = reviewModelField(runtime);
  return (
    <div>
      <span className="block text-xs text-text-muted mb-1">Review agent</span>
      <AgentChoice
        aria-label="Review agent"
        runtime={runtime}
        runtimes={[{ value: TERMINAL }, ...ALL_AGENT_RUNTIMES]}
        emptyLabel="Repo default"
        emptyIcon={<CornerDownRight className="w-3.5 h-3.5" />}
        agentOptions={field ? { [field]: model } : {}}
        onRuntimeChange={(r) =>
          onChange(r === TERMINAL ? null : (r as AgentType), defaultModelFor(r))
        }
        onOptionsChange={(v) => {
          const next = field ? v[field] : undefined;
          onChange(agentType, typeof next === "string" ? next : "");
        }}
        note={runtime === TERMINAL ? inheritedHint : undefined}
        paramsHint="The review agent takes a model; the rest are its defaults"
        modelOnly
      />
    </div>
  );
}
