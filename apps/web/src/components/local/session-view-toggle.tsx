"use client";

import { MessagesSquare, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionView } from "./session-view";

/** Chat ⇄ Terminal segmented control for a session's header. */
export function SessionViewToggle({
  view,
  onChange,
  className,
  compact = false,
}: {
  view: SessionView;
  onChange: (view: SessionView) => void;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center p-0.5 rounded-lg bg-bg border border-border/70",
        className,
      )}
      role="radiogroup"
      aria-label="Session view"
    >
      {(
        [
          ["transcript", MessagesSquare, "Chat"],
          ["screen", Terminal, "Terminal"],
        ] as Array<[SessionView, typeof Terminal, string]>
      ).map(([value, Icon, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={view === value}
          aria-label={label}
          title={
            value === "transcript"
              ? "The conversation — read it and reply"
              : "The terminal, as it runs"
          }
          onClick={() => onChange(value)}
          className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors",
            view === value
              ? "bg-primary/15 text-primary shadow-sm"
              : "text-text-muted hover:text-text hover:bg-bg-hover/50",
          )}
        >
          <Icon className="w-3.5 h-3.5" />
          <span className={compact ? "hidden @xl:inline" : undefined}>{label}</span>
        </button>
      ))}
    </div>
  );
}
