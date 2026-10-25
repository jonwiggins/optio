"use client";

import { isGatewayBudgetPeriod, modelGatewayTypeOf, type ModelGatewayType } from "@optio/shared";
import { cn } from "@/lib/utils";
import { inputClass } from "@/components/ui/input";

/**
 * A budget in USD and the period it resets in, for a gateway key's or a
 * team's budget (docs/model-gateway.md "Keys Optio makes"), offered as the
 * gateway's type takes them. An empty amount is no cap.
 */

/** Durations offered for a budget's period ("" = never resets). */
export const BUDGET_PERIODS: Array<{ value: string; label: string }> = [
  { value: "1d", label: "per day" },
  { value: "7d", label: "per week" },
  { value: "30d", label: "per 30 days" },
  { value: "1mo", label: "per month" },
  { value: "", label: "never resets" },
];

/** The calendar periods OpenRouter and Portkey reset a limit on (UTC). */
const CALENDAR_PERIODS: Array<{ value: string; label: string }> = [
  { value: "1d", label: "per day" },
  { value: "1w", label: "per week" },
  { value: "1mo", label: "per month" },
];

/**
 * The periods a gateway type takes, for its budget pickers: any duration on
 * LiteLLM (the list above); OpenRouter's daily, weekly and monthly resets;
 * Portkey's weekly and monthly resets and whole days.
 */
export function budgetPeriodsFor(
  type: ModelGatewayType | null | undefined,
): Array<{ value: string; label: string }> {
  const t = modelGatewayTypeOf(type);
  if (t === "litellm" || t === "generic") return BUDGET_PERIODS;
  const days = t === "portkey" ? BUDGET_PERIODS.filter((p) => /d$/.test(p.value)) : [];
  return [
    ...CALENDAR_PERIODS.filter((p) => isGatewayBudgetPeriod(t, p.value)),
    ...days.filter((p) => p.value !== "1d"),
    { value: "", label: "never resets" },
  ];
}

/** How long a key Optio makes lives ("" = until rotated or revoked). */
export const KEY_LIVES: Array<{ value: string; label: string }> = [
  { value: "", label: "No expiry" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "180d", label: "180 days" },
  { value: "365d", label: "1 year" },
];

/** The options, with `current` added when it is a value the list doesn't name ("14d"). */
export function withCurrent(
  options: Array<{ value: string; label: string }>,
  current: string | null | undefined,
): Array<{ value: string; label: string }> {
  const v = current ?? "";
  return options.some((o) => o.value === v) ? options : [...options, { value: v, label: v }];
}

/** The amount typed, as the API takes it: null for empty, NaN for garbage. */
export function amountOf(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}

export function BudgetInputs({
  amount,
  period,
  onAmount,
  onPeriod,
  label = "Budget",
  idPrefix,
  disabled = false,
  placeholder = "No cap",
  periods = BUDGET_PERIODS,
}: {
  /** The amount as typed (USD). */
  amount: string;
  /** A duration ("30d", "1mo"), "" = never resets. */
  period: string;
  onAmount: (v: string) => void;
  onPeriod: (v: string) => void;
  label?: string;
  idPrefix: string;
  disabled?: boolean;
  placeholder?: string;
  /** The periods the gateway takes (`budgetPeriodsFor`). */
  periods?: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={`${idPrefix}-amount`} className="text-xs text-text-muted">
        {label}
      </label>
      <div className="relative">
        <span className="absolute left-2 top-1.5 text-xs text-text-muted">$</span>
        <input
          id={`${idPrefix}-amount`}
          inputMode="decimal"
          value={amount}
          onChange={(e) => onAmount(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={`${label} in USD`}
          className={cn(inputClass({ size: "sm" }), "w-28 pl-5 tabular-nums")}
        />
      </div>
      <select
        aria-label={`${label} period`}
        value={period}
        onChange={(e) => onPeriod(e.target.value)}
        disabled={disabled || !amount.trim()}
        className={inputClass({ size: "sm", className: "w-auto" })}
      >
        {withCurrent(periods, period).map((p) => (
          <option key={p.value || "never"} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
    </div>
  );
}
