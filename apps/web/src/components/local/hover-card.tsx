"use client";

import { cn } from "@/lib/utils";

/**
 * A small hover / focus popover for header chips. Pure CSS (group-hover +
 * focus-within) so it opens instantly, unlike the browser's `title` delay.
 * `children` is the trigger; `content` the card. Right-aligned by default
 * because the chips live at the right edge of the header.
 *
 * The card's gap from the trigger is padding, not margin, so the pointer
 * can travel into an `interactive` card (one with buttons) without the
 * hover breaking over the gap.
 */
export function HoverCard({
  content,
  children,
  align = "right",
  interactive = false,
  className,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  align?: "left" | "right";
  /** The card has controls: keep it clickable while hovered. */
  interactive?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex group/hc", className)} tabIndex={0}>
      {children}
      <span
        className={cn(
          "absolute top-full pt-1.5 z-40",
          "opacity-0 translate-y-1 transition-all duration-100",
          "group-hover/hc:opacity-100 group-hover/hc:translate-y-0 group-focus-within/hc:opacity-100 group-focus-within/hc:translate-y-0",
          interactive
            ? "pointer-events-none group-hover/hc:pointer-events-auto group-focus-within/hc:pointer-events-auto"
            : "pointer-events-none",
          align === "right" ? "right-0" : "left-0",
        )}
      >
        <span
          role="tooltip"
          className="block min-w-[14rem] rounded-lg border border-border bg-bg-card shadow-xl shadow-black/30 p-3 text-[11px] leading-5 text-text-muted whitespace-nowrap"
        >
          {content}
        </span>
      </span>
    </span>
  );
}

export function HoverRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span className="flex items-center justify-between gap-6">
      <span>{label}</span>
      <span className="font-mono tabular-nums text-text">{value}</span>
    </span>
  );
}
