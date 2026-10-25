"use client";

import { useEffect, useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";
import type { LogEntry } from "@/hooks/use-logs";
import { thinkingSummary } from "./log-groups";

/**
 * A run of consecutive "thinking" entries as one collapsed row — "Thinking
 * (N blocks · M tokens)" — that opens on click to show each block, the way
 * the Local transcript's ThinkingRow does. `defaultOpen` (the viewer's
 * Thinking toggle) opens every fold at once; a click still works per fold.
 */
export function ThinkingFold({
  entries,
  defaultOpen = false,
  renderEntry,
}: {
  entries: LogEntry[];
  defaultOpen?: boolean;
  /** One block's body (the viewer's own line rendering, search highlight included). */
  renderEntry: (entry: LogEntry) => React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // The toggle moves every fold; a fold opened by hand follows it too.
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  return (
    <div
      className="my-0.5 rounded-md border border-dashed border-border/60 px-3 py-1.5 log-thinking"
      data-testid="thinking-fold"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-[11px] font-sans text-text-muted hover:text-text"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        <Brain className="w-3 h-3" />
        {thinkingSummary(entries)}
      </button>
      {open && (
        <div className="mt-1.5 space-y-2">
          {entries.map((e, i) => (
            <div key={e.id ?? i}>{renderEntry(e)}</div>
          ))}
        </div>
      )}
    </div>
  );
}
