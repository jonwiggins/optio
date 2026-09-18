"use client";

import { cn } from "@/lib/utils";

/**
 * A small hover / focus popover for header chips. Pure CSS (group-hover +
 * focus-within) so it opens instantly, unlike the browser's `title` delay.
 * `children` is the trigger; `content` the card. Right-aligned by default
 * because the chips live at the right edge of the header.
 */
export function HoverCard({
  content,
  children,
  align = "right",
  className,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex group/hc", className)} tabIndex={0}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute top-full mt-1.5 z-40 min-w-[14rem] rounded-lg border border-border bg-bg-card shadow-xl shadow-black/30 p-3 text-[11px] leading-5 text-text-muted whitespace-nowrap",
          "opacity-0 translate-y-1 transition-all duration-100",
          "group-hover/hc:opacity-100 group-hover/hc:translate-y-0 group-focus-within/hc:opacity-100 group-focus-within/hc:translate-y-0",
          align === "right" ? "right-0" : "left-0",
        )}
      >
        {content}
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
