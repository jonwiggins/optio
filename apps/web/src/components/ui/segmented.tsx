"use client";

import { createContext, useContext, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The pill toggle for either/or choices (New work form, run-location
 * picker, trigger type, Work views). The active pill is `bg-primary
 * text-white`; a disabled pill carries its reason as a tooltip and is never
 * disabled while it is the active one.
 *
 * `Segmented` covers the common case from an `options` array. For callers
 * that need to mix in their own pills, compose `SegmentedGroup` +
 * `SegmentedButton` directly — they render the same markup.
 */

export type SegmentedSize = "sm" | "md";

const SizeContext = createContext<SegmentedSize>("sm");

/**
 * How many columns lay `count` pills out in rows as even as possible, never
 * more than `maxPerRow` per row: 8 pills with 6 per row at most is two rows
 * of 4 (not 6 + 2); 9 is 5 + 4; 11 is 6 + 5.
 */
export function evenColumns(count: number, maxPerRow: number): number {
  if (count <= 0) return 1;
  const rows = Math.ceil(count / maxPerRow);
  return Math.ceil(count / rows);
}

// Static class names so Tailwind sees them (the column count is computed).
const GRID_COLUMNS: Record<number, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-3",
  4: "sm:grid-cols-4",
  5: "sm:grid-cols-5",
  6: "sm:grid-cols-6",
  7: "sm:grid-cols-7",
  8: "sm:grid-cols-8",
};

export function SegmentedGroup({
  size = "sm",
  surface = "bg",
  wrap = false,
  columns,
  className,
  children,
  ...aria
}: {
  /** `sm` = text-xs pills (forms), `md` = text-sm pills (page-level views). */
  size?: SegmentedSize;
  /** The track colour: `bg` inside cards, `card` on the page background. */
  surface?: "bg" | "card";
  /** Let the pills wrap onto a second line on narrow screens. */
  wrap?: boolean;
  /**
   * Lay the pills out in a grid of this many equal columns (two on phones),
   * filling the width, so many pills make even rows instead of a full first
   * row and a short second one. See `evenColumns`.
   */
  columns?: number;
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
}) {
  const grid = columns !== undefined;
  return (
    <SizeContext.Provider value={size}>
      <div
        role="group"
        {...aria}
        className={cn(
          "gap-1.5 p-1 rounded-lg border border-border",
          grid
            ? cn(
                "grid grid-cols-2 w-full [&>button]:justify-center",
                GRID_COLUMNS[Math.min(Math.max(columns, 1), 8)],
              )
            : "flex w-fit max-w-full",
          surface === "card" ? "bg-bg-card" : "bg-bg",
          !grid && (wrap ? "flex-wrap" : "overflow-x-auto"),
          className,
        )}
      >
        {children}
      </div>
    </SizeContext.Provider>
  );
}

export function SegmentedButton({
  active,
  onClick,
  disabled,
  icon,
  count,
  className,
  children,
}: {
  active: boolean;
  onClick: () => void;
  /** Why it can't be picked right now (tooltip); ignored while active. */
  disabled?: string;
  icon?: ReactNode;
  /** Optional count pill after the label. */
  count?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const size = useContext(SizeContext);
  const blocked = !!disabled && !active;
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={blocked}
      title={blocked ? disabled : undefined}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors",
        size === "md" ? "text-sm" : "text-xs",
        active
          ? "bg-primary text-white"
          : blocked
            ? "text-text-muted/40 cursor-not-allowed"
            : "text-text-muted hover:text-text",
        className,
      )}
    >
      {icon}
      {children}
      {count !== undefined && (
        <span
          className={cn(
            "text-[10px] tabular-nums px-1 rounded",
            active ? "bg-white/20" : "bg-bg text-text-muted/70",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** The reason the option can't be picked right now. */
  disabled?: string;
  count?: ReactNode;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size,
  surface,
  wrap,
  className,
  "aria-label": ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<SegmentedOption<T>>;
  size?: SegmentedSize;
  surface?: "bg" | "card";
  wrap?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <SegmentedGroup
      size={size}
      surface={surface}
      wrap={wrap}
      className={className}
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        <SegmentedButton
          key={o.value}
          active={value === o.value}
          onClick={() => onChange(o.value)}
          disabled={o.disabled}
          icon={o.icon}
          count={o.count}
        >
          {o.label}
        </SegmentedButton>
      ))}
    </SegmentedGroup>
  );
}
