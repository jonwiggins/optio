"use client";

import { MessagesSquare, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionView } from "./session-view";

/** Transcript ⇄ Screen segmented control for a session's header. */
export function SessionViewToggle({
  view,
  onChange,
  className,
}: {
  view: SessionView;
  onChange: (view: SessionView) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center p-0.5 rounded-md bg-bg-card border border-border",
        className,
      )}
      role="radiogroup"
      aria-label="Session view"
    >
      {(
        [
          ["transcript", MessagesSquare, "Transcript"],
          ["screen", Terminal, "Screen"],
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
              ? "The conversation: every prompt, reply, and tool call"
              : "The terminal as it ran"
          }
          onClick={() => onChange(value)}
          className={cn(
            "inline-flex items-center gap-1 px-1.5 py-1 rounded text-[11px] font-medium transition-colors",
            view === value ? "bg-primary/15 text-primary" : "text-text-muted hover:text-text",
          )}
        >
          <Icon className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}
