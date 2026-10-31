"use client";

import { Plus, Trash2 } from "lucide-react";
import {
  MODEL_PROVIDER_MODEL_ROLES,
  type ModelProviderModel,
  type ModelProviderPrices,
} from "@optio/shared";
import { cn } from "@/lib/utils";
import { inputClass } from "@/components/ui/input";
import {
  EFFORT_LABELS,
  GATEWAY_EFFORTS,
  PRICE_KEYS,
  PRICE_LABELS,
  ROLE_LABELS,
  claudeNameWindowWarning,
  emptyGatewayModel,
  withEffort,
  withPrice,
  withRole,
} from "./gateway-form";

const CELL = inputClass({ size: "sm" });
const NUM = cn(CELL, "font-mono tabular-nums w-24");

/**
 * A gateway's catalog for one agent (docs/model-gateway.md), one row per
 * model: the id the gateway knows it by, a label for the pickers, the
 * Claude Code alias it stands in for, its limits, the efforts it takes and
 * the default, what the organization pays for it. The first row is the
 * model work gets when it picks none; a row the last sync didn't find is
 * flagged, kept so old work still names it.
 */
export function GatewayCatalogTable({
  models,
  onChange,
  /** OpenCode takes no effort or role: those columns go. */
  efforts = true,
}: {
  models: ModelProviderModel[];
  onChange: (models: ModelProviderModel[]) => void;
  efforts?: boolean;
}) {
  const update = (i: number, next: ModelProviderModel) =>
    onChange(models.map((m, j) => (j === i ? next : m)));
  const remove = (i: number) => onChange(models.filter((_, j) => j !== i));
  const add = () => onChange([...models, emptyGatewayModel()]);

  return (
    <div className="space-y-2" data-testid="gateway-catalog">
      {models.length === 0 ? (
        <p className="text-xs text-text-muted">
          No models yet — Sync reads them from the gateway, or add them by hand.
        </p>
      ) : (
        <div className="overflow-x-auto -mx-1 px-1">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-text-muted/70 text-left">
                <th className="pb-1 pr-2 font-medium">Model id</th>
                <th className="pb-1 pr-2 font-medium">Label</th>
                {efforts && <th className="pb-1 pr-2 font-medium">Stands in for</th>}
                <th className="pb-1 pr-2 font-medium">Context</th>
                <th className="pb-1 pr-2 font-medium">Max output</th>
                {efforts && <th className="pb-1 pr-2 font-medium">Efforts</th>}
                {efforts && <th className="pb-1 pr-2 font-medium">Default</th>}
                <th className="pb-1 pr-2 font-medium">USD / 1M tokens</th>
                <th className="pb-1" />
              </tr>
            </thead>
            <tbody>
              {models.map((m, i) => (
                <tr key={i} className="align-top border-t border-border/40">
                  <td className="py-1.5 pr-2 min-w-[12rem]">
                    <input
                      aria-label={`Model ${i + 1} id`}
                      value={m.id}
                      onChange={(e) => update(i, { ...m, id: e.target.value })}
                      placeholder="claude-sonnet-internal"
                      className={cn(CELL, "font-mono")}
                    />
                    <div className="flex flex-wrap gap-1 mt-1">
                      {i === 0 && (
                        <span className="px-1 py-0.5 rounded bg-bg-hover text-[10px] text-text-muted">
                          default
                        </span>
                      )}
                      {m.missing && (
                        <span
                          className="px-1 py-0.5 rounded bg-warning/10 text-[10px] text-warning"
                          title="The last sync didn't find it on the gateway"
                        >
                          missing
                        </span>
                      )}
                      {claudeNameWindowWarning(m) && (
                        <span
                          className="px-1 py-0.5 rounded bg-warning/10 text-[10px] text-warning"
                          title={claudeNameWindowWarning(m) ?? undefined}
                        >
                          context not applied
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-1.5 pr-2 min-w-[9rem]">
                    <input
                      aria-label={`Model ${i + 1} label`}
                      value={m.label ?? ""}
                      onChange={(e) => update(i, { ...m, label: e.target.value })}
                      placeholder={m.id || "Sonnet (internal)"}
                      className={CELL}
                    />
                  </td>
                  {efforts && (
                    <td className="py-1.5 pr-2">
                      <select
                        aria-label={`Model ${i + 1} role`}
                        value={m.role ?? ""}
                        onChange={(e) => update(i, withRole(m, e.target.value))}
                        className={cn(CELL, "w-24")}
                      >
                        <option value="">—</option>
                        {MODEL_PROVIDER_MODEL_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                  <td className="py-1.5 pr-2">
                    <input
                      aria-label={`Model ${i + 1} context window`}
                      inputMode="numeric"
                      value={m.contextWindow ?? ""}
                      onChange={(e) =>
                        update(i, { ...m, contextWindow: numberOrUndefined(e.target.value) })
                      }
                      placeholder="200000"
                      className={NUM}
                    />
                  </td>
                  <td className="py-1.5 pr-2">
                    <input
                      aria-label={`Model ${i + 1} max output`}
                      inputMode="numeric"
                      value={m.maxOutputTokens ?? ""}
                      onChange={(e) =>
                        update(i, { ...m, maxOutputTokens: numberOrUndefined(e.target.value) })
                      }
                      placeholder="32000"
                      className={NUM}
                    />
                  </td>
                  {efforts && (
                    <td className="py-1.5 pr-2">
                      <div className="flex flex-wrap gap-x-2 gap-y-1 pt-1.5">
                        {GATEWAY_EFFORTS.map((e) => (
                          <label
                            key={e}
                            className="flex items-center gap-1 cursor-pointer whitespace-nowrap"
                          >
                            <input
                              type="checkbox"
                              aria-label={`Model ${i + 1} effort ${e}`}
                              checked={!!m.efforts?.includes(e)}
                              onChange={(ev) => update(i, withEffort(m, e, ev.target.checked))}
                              className="w-3.5 h-3.5 rounded"
                            />
                            {EFFORT_LABELS[e] ?? e}
                          </label>
                        ))}
                      </div>
                    </td>
                  )}
                  {efforts && (
                    <td className="py-1.5 pr-2">
                      <select
                        aria-label={`Model ${i + 1} default effort`}
                        value={m.defaultEffort ?? ""}
                        onChange={(e) =>
                          update(i, { ...m, defaultEffort: e.target.value || undefined })
                        }
                        disabled={!m.efforts?.length}
                        className={cn(CELL, "w-28")}
                      >
                        {!m.efforts?.length && <option value="">—</option>}
                        {(m.efforts ?? []).map((e) => (
                          <option key={e} value={e}>
                            {EFFORT_LABELS[e] ?? e}
                          </option>
                        ))}
                      </select>
                    </td>
                  )}
                  <td className="py-1.5 pr-2">
                    <div className="grid grid-cols-2 gap-1 min-w-[11rem]">
                      {PRICE_KEYS.map((k) => (
                        <input
                          key={k}
                          aria-label={`Model ${i + 1} ${PRICE_LABELS[k].toLowerCase()} price`}
                          inputMode="decimal"
                          title={`${PRICE_LABELS[k]}, USD per million tokens`}
                          value={priceText(m.prices, k)}
                          onChange={(e) => update(i, withPrice(m, k, e.target.value))}
                          placeholder={PRICE_LABELS[k]}
                          className={cn(CELL, "font-mono tabular-nums")}
                        />
                      ))}
                    </div>
                  </td>
                  <td className="py-1.5">
                    <button
                      type="button"
                      onClick={() => remove(i)}
                      className="p-1.5 mt-0.5 rounded text-text-muted hover:text-error hover:bg-bg-hover"
                      aria-label={`Remove model ${m.id || i + 1}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
      >
        <Plus className="w-3 h-3" />
        Add model
      </button>
    </div>
  );
}

function numberOrUndefined(text: string): number | undefined {
  const n = Number(text.trim());
  return text.trim() && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function priceText(prices: ModelProviderPrices | undefined, key: keyof ModelProviderPrices) {
  const v = prices?.[key];
  return typeof v === "number" ? String(v) : "";
}
