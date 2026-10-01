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

export function SegmentedGroup({
  size = "sm",
  surface = "bg",
  wrap = false,
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
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
}) {
  return (
    <SizeContext.Provider value={size}>
      <div
        role="group"
        {...aria}
        className={cn(
          "flex gap-1.5 p-1 rounded-lg border border-border w-fit",
          surface === "card" ? "bg-bg-card" : "bg-bg",
          wrap && "flex-wrap max-w-full",
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
        "flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors",
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
