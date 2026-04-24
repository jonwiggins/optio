"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, AlertCircle } from "lucide-react";
import {
  getProviderCatalog,
  groupModelsByFamily,
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
}

const DEFAULT_INPUT_CLASS =
  "w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20";

interface LiveState {
  catalog: ProviderCatalog;
  source: "baseline" | "live";
  cached: boolean;
  refreshedAt: number | null;
  error?: string;
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
}: Props) {
  const baseline = getProviderCatalog(provider);

  const [live, setLive] = useState<LiveState | null>(
    baseline ? { catalog: baseline, source: "baseline", cached: false, refreshedAt: null } : null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const didFetchForProvider = useRef<AgentProviderId | null>(null);

  const fetchOptions = useCallback(
    async (forceRefresh = false) => {
      if (!baseline) return;
      setRefreshing(true);
      try {
        const res = await api.getAgentProviderOptions(provider, {
          refresh: forceRefresh,
        });
        setLive({
          catalog: res.catalog as ProviderCatalog,
          source: res.source,
          cached: res.cached,
          refreshedAt: res.refreshedAt,
          error: res.error,
        });
      } catch (err) {
        setLive((prev) =>
          prev ? { ...prev, error: err instanceof Error ? err.message : "Refresh failed" } : null,
        );
      } finally {
        setRefreshing(false);
      }
    },
    [baseline, provider],
  );

  // Auto-fetch once per provider change. For providers that don't support
  // live refresh the backend just echoes the baseline, which is cheap.
  useEffect(() => {
    if (didFetchForProvider.current === provider) return;
    didFetchForProvider.current = provider;
    fetchOptions(false).catch(() => {});
  }, [provider, fetchOptions]);

  if (!baseline) {
    return <div className="text-xs text-text-muted italic">Unknown provider: {provider}</div>;
  }

  const catalog = live?.catalog ?? baseline;
  const modelValue = String(values[catalog.modelField] ?? "");
  const canRefresh = catalog.liveRefreshSupported && !hideRefresh;

  const setField = (key: string, value: string | boolean) => {
    onChange({ ...values, [key]: value });
  };

  const modelGroups = groupModelsByFamily(catalog);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs text-text-muted">Model</label>
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
              value={modelValue}
              onChange={(e) => setField(catalog.modelField, e.target.value)}
              className={inputClass}
            >
              {!modelValue && <option value="">Default</option>}
              {modelGroups.length === 1 && modelGroups[0].family === modelGroups[0].models[0].id
                ? modelGroups[0].models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
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
        </div>

        {catalog.options
          .filter((f) => f.kind === "select")
          .map((field) => {
            const v = values[field.key];
            const val = typeof v === "string" ? v : String(field.default ?? "");
            return (
              <div key={field.key}>
                <label className="block text-xs text-text-muted mb-1">{field.label}</label>
                <select
                  value={val}
                  onChange={(e) => setField(field.key, e.target.value)}
                  className={inputClass}
                >
                  {field.choices?.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                {field.helpText && <p className="text-xs text-text-muted mt-1">{field.helpText}</p>}
              </div>
            );
          })}

        {catalog.options
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

      {catalog.options.some((f) => f.kind === "text") && (
        <div className="space-y-3">
          {catalog.options
            .filter((f) => f.kind === "text")
            .map((field) => {
              const v = values[field.key];
              const val = typeof v === "string" ? v : "";
              return (
                <div key={field.key}>
                  <label className="block text-xs text-text-muted mb-1">{field.label}</label>
                  <input
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
