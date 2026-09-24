"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { RefreshCw, AlertCircle } from "lucide-react";
import {
  getProviderCatalog,
  groupModelsByFamily,
  optionChoicesFor,
  optionRunsOn,
  type AgentProviderId,
  type ProviderCatalog,
} from "@optio/shared";
import { api } from "@/lib/api-client";

/**
 * Picker state — one map of field-name → value covering the model plus every
 * provider-specific option. Keys match `ProviderCatalog.modelField` and
 * `OptionField.key`, which in turn mirror the DB columns on `repos`.
 */
export type AgentOptionsValues = Record<string, string | boolean>;

interface Props {
  provider: AgentProviderId;
  values: AgentOptionsValues;
  onChange: (values: AgentOptionsValues) => void;
  /** Optional class applied to all select/input controls. */
  inputClass?: string;
  /** Hide the Refresh button (e.g. in wizards). */
  hideRefresh?: boolean;
  /** Render only the model control (e.g. the Optio agent, which takes just a model). */
  modelOnly?: boolean;
  /**
   * Where the run executes: an Optio pod (default, every field) or the
   * user's machine, which takes only the fields the daemon passes to the
   * agent CLI (model, effort, Claude Code's permission mode).
   */
  runsOn?: "pod" | "local";
  /**
   * A run on this paired machine: offer the models its own agent CLI lists
   * (Codex), rather than the freshest list any machine reported.
   */
  hostId?: string;
  /**
   * Offer each alias ("opus") as an "always the latest" choice and keep a
   * stored alias as the alias, instead of showing the model it names today.
   */
  latestAliases?: boolean;
}

const DEFAULT_INPUT_CLASS =
  "w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20";

interface LiveState {
  catalog: ProviderCatalog;
  source: "baseline" | "live";
  cached: boolean;
  refreshedAt: number | null;
  error?: string;
  /** Where a machine-reported list came from ("Codex on MacBook-Pro"). */
  liveFrom?: string;
}

function formatRefreshed(unixSeconds: number | null): string {
  if (!unixSeconds) return "";
  const ageMs = Date.now() - unixSeconds * 1000;
  const ageMin = Math.floor(ageMs / 60_000);
  if (ageMin < 1) return "just now";
  if (ageMin < 60) return `${ageMin}m ago`;
  const ageH = Math.floor(ageMin / 60);
  if (ageH < 24) return `${ageH}h ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

/**
 * Unified picker for every agent provider. Renders the model dropdown (or
 * free-text input, for OpenCode/OpenClaw) plus provider-specific options like
 * context window, effort, approval mode, extended-thinking, etc.
 *
 * Loads the hardcoded baseline synchronously on first paint, then fires
 * `GET /api/agents/:provider/options` in the background to merge in a live
 * list-models probe. A manual Refresh button invalidates the server cache.
 */
export function AgentOptionsPicker({
  provider,
  values,
  onChange,
  inputClass = DEFAULT_INPUT_CLASS,
  hideRefresh = false,
  modelOnly = false,
  latestAliases = false,
  runsOn = "pod",
  hostId,
}: Props) {
  const baseline = getProviderCatalog(provider);
  const idBase = useId();
  const controlId = (key: string) => `${idBase}-${key}`;

  const [live, setLive] = useState<LiveState | null>(
    baseline ? { catalog: baseline, source: "baseline", cached: false, refreshedAt: null } : null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const didFetchFor = useRef<string | null>(null);

  const fetchOptions = useCallback(
    async (forceRefresh = false) => {
      if (!baseline) return;
      setRefreshing(true);
      try {
        const res = await api.getAgentProviderOptions(provider, {
          refresh: forceRefresh,
          hostId,
        });
        setLive({
          catalog: res.catalog as ProviderCatalog,
          source: res.source,
          cached: res.cached,
          refreshedAt: res.refreshedAt,
          error: res.error,
          liveFrom: res.liveFrom,
        });
      } catch (err) {
        setLive((prev) =>
          prev ? { ...prev, error: err instanceof Error ? err.message : "Refresh failed" } : null,
        );
      } finally {
        setRefreshing(false);
      }
    },
    [baseline, provider, hostId],
  );

  // Auto-fetch once per provider (and machine) change. For providers that
  // don't support live refresh the backend just echoes the baseline, which
  // is cheap.
  useEffect(() => {
    const key = `${provider}:${hostId ?? ""}`;
    if (didFetchFor.current === key) return;
    didFetchFor.current = key;
    fetchOptions(false).catch(() => {});
  }, [provider, hostId, fetchOptions]);

  if (!baseline) {
    return <div className="text-xs text-text-muted italic">Unknown provider: {provider}</div>;
  }

  const catalog = live?.catalog ?? baseline;
  // A stored alias ("opus") shows as the model it resolves to, so the select
  // matches an option instead of silently displaying the first one — unless
  // the aliases are choices of their own.
  const rawModel = String(values[catalog.modelField] ?? "");
  const isAlias = Object.hasOwn(catalog.aliases, rawModel);
  const modelValue = isAlias && !latestAliases ? catalog.aliases[rawModel] : rawModel;
  const canRefresh = catalog.liveRefreshSupported && !hideRefresh;
  const labelOf = (id: string) => catalog.models.find((m) => m.id === id)?.label ?? id;
  // A saved model the list doesn't offer (the live list is down, or it was
  // retired) still shows as itself rather than as whichever option is first.
  const unlisted =
    !!modelValue && !(latestAliases && isAlias) && !catalog.models.some((m) => m.id === modelValue);

  const selectedModel = catalog.models.find((m) => m.id === modelValue);
  // Fields this run takes: all of them in a pod; on a machine, only what the
  // daemon hands the agent CLI.
  const fields = modelOnly ? [] : catalog.options.filter((f) => optionRunsOn(f, runsOn));

  const setField = (key: string, value: string | boolean) => {
    const next = { ...values, [key]: value };
    if (key === catalog.modelField) {
      // A reasoning effort the newly picked model doesn't take goes back to
      // its default rather than riding along into a run it would fail.
      const model = catalog.models.find((m) => m.id === value);
      for (const f of catalog.options) {
        const v = next[f.key];
        if (f.modelEfforts && model?.efforts && typeof v === "string" && v) {
          if (!model.efforts.includes(v)) next[f.key] = "";
        }
      }
    }
    onChange(next);
  };

  const modelGroups = groupModelsByFamily(catalog);
  // A catalog without families (Codex) reads as one list, in its own order.
  const flat = catalog.models.every((m) => !m.family);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor={controlId("model")} className="block text-xs text-text-muted">
              Model
            </label>
            {canRefresh && (
              <button
                type="button"
                onClick={() => fetchOptions(true)}
                disabled={refreshing}
                title={
                  live?.refreshedAt
                    ? `Last refreshed ${formatRefreshed(live.refreshedAt)}`
                    : "Refresh model list"
                }
                className="flex items-center gap-1 text-[10px] text-primary hover:underline disabled:opacity-50 disabled:cursor-wait"
              >
                <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
                {refreshing ? "Refreshing" : "Refresh"}
              </button>
            )}
          </div>
          {catalog.modelIsFreeText ? (
            <>
              <input
                id={controlId("model")}
                value={modelValue}
                onChange={(e) => setField(catalog.modelField, e.target.value)}
                placeholder={catalog.modelPlaceholder ?? ""}
                className={inputClass}
              />
              {catalog.modelHelpText && (
                <p className="text-xs text-text-muted mt-1">{catalog.modelHelpText}</p>
              )}
            </>
          ) : (
            <select
              id={controlId("model")}
              value={modelValue}
              onChange={(e) => setField(catalog.modelField, e.target.value)}
              className={inputClass}
            >
              {!modelValue && <option value="">Default</option>}
              {unlisted && <option value={modelValue}>{modelValue}</option>}
              {latestAliases && Object.keys(catalog.aliases).length > 0 && (
                <optgroup label="Always the latest">
                  {Object.entries(catalog.aliases).map(([alias, id]) => (
                    <option key={alias} value={alias}>
                      {alias.charAt(0).toUpperCase() + alias.slice(1)} · now {labelOf(id)}
                    </option>
                  ))}
                </optgroup>
              )}
              {flat
                ? catalog.models.map((m) => (
                    <option key={m.id} value={m.id} title={m.description}>
                      {m.label}
                      {m.latest && catalog.models.length > 1 ? " (latest)" : ""}
                      {m.preview ? " (Preview)" : ""}
                      {m.source === "live" ? " •" : ""}
                    </option>
                  ))
                : modelGroups.map((group) => (
                    <optgroup key={group.family} label={group.family}>
                      {group.models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                          {m.latest ? " (latest)" : ""}
                          {m.preview ? " (Preview)" : ""}
                          {m.source === "live" ? " •" : ""}
                        </option>
                      ))}
                    </optgroup>
                  ))}
            </select>
          )}
          {latestAliases && !catalog.modelIsFreeText && (
            <p className="text-[11px] text-text-muted mt-1">
              &ldquo;Always the latest&rdquo; moves to each new release on its own; a specific
              version stays put.
            </p>
          )}
          {live?.liveFrom && (
            <p className="text-[11px] text-text-muted mt-1">
              Models from {live.liveFrom}
              {live.refreshedAt ? ` · ${formatRefreshed(live.refreshedAt)}` : ""}
            </p>
          )}
        </div>

        {fields
          .filter((f) => f.kind === "select")
          .map((field) => {
            const choices = optionChoicesFor(field, selectedModel);
            // A field shared with pods carries the pod default; on a machine,
            // unset means the machine's own config (no flag is passed).
            const fieldDefault =
              runsOn === "local" && optionRunsOn(field, "pod") ? undefined : field.default;
            const v = values[field.key];
            const val = typeof v === "string" ? v : String(fieldDefault ?? "");
            // Blank means the CLI's default — for effort per model, the model's own.
            const modelDefault = field.modelEfforts ? selectedModel?.defaultEffort : undefined;
            const defaultLabel =
              fieldDefault === undefined
                ? modelDefault
                  ? `Default (${choices.find((c) => c.value === modelDefault)?.label ?? modelDefault})`
                  : "Default"
                : null;
            const help = choices.find((c) => c.value === val)?.description ?? field.helpText;
            return (
              <div key={field.key}>
                <label
                  htmlFor={controlId(field.key)}
                  className="block text-xs text-text-muted mb-1"
                >
                  {field.label}
                </label>
                <select
                  id={controlId(field.key)}
                  value={val}
                  onChange={(e) => setField(field.key, e.target.value)}
                  className={inputClass}
                >
                  {defaultLabel && <option value="">{defaultLabel}</option>}
                  {val && !choices.some((c) => c.value === val) && (
                    <option value={val}>{val}</option>
                  )}
                  {choices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                {help && <p className="text-xs text-text-muted mt-1">{help}</p>}
              </div>
            );
          })}

        {fields
          .filter((f) => f.kind === "boolean")
          .map((field) => {
            const v = values[field.key];
            const checked = typeof v === "boolean" ? v : Boolean(field.default);
            return (
              <div key={field.key} className="flex items-end pb-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setField(field.key, e.target.checked)}
                    className="w-4 h-4 rounded"
                  />
                  <span className="text-sm">{field.label}</span>
                </label>
              </div>
            );
          })}
      </div>

      {fields.some((f) => f.kind === "text") && (
        <div className="space-y-3">
          {fields
            .filter((f) => f.kind === "text")
            .map((field) => {
              const v = values[field.key];
              const val = typeof v === "string" ? v : "";
              return (
                <div key={field.key}>
                  <label
                    htmlFor={controlId(field.key)}
                    className="block text-xs text-text-muted mb-1"
                  >
                    {field.label}
                  </label>
                  <input
                    id={controlId(field.key)}
                    value={val}
                    onChange={(e) => setField(field.key, e.target.value)}
                    placeholder={field.placeholder ?? ""}
                    className={inputClass}
                  />
                  {field.helpText && (
                    <p className="text-xs text-text-muted mt-1">{field.helpText}</p>
                  )}
                </div>
              );
            })}
        </div>
      )}

      {live?.error && (
        <p className="flex items-start gap-1 text-[10px] text-warning">
          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
          Live model list unavailable — showing built-in defaults. ({live.error})
        </p>
      )}
    </div>
  );
}
