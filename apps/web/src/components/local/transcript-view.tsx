"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { LocalTranscriptEntry } from "@optio/shared";
import {
  AlertCircle,
  Brain,
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  Pencil,
  Search,
  Sparkles,
  Terminal,
  User,
  Wrench,
  MessagesSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LogMarkdown } from "@/components/log-markdown";

const TOOL_ICONS: Record<string, typeof Wrench> = {
  Bash: Terminal,
  Read: FileText,
  Write: FileText,
  Edit: Pencil,
  NotebookEdit: Pencil,
  Grep: Search,
  Glob: Search,
  WebFetch: Globe,
  WebSearch: Globe,
  Agent: Sparkles,
  Task: Sparkles,
};

/** A tool call joined with its result, or a lone entry. */
export type TranscriptItem =
  | { kind: "entry"; entry: LocalTranscriptEntry }
  | { kind: "tool"; use: LocalTranscriptEntry; result: LocalTranscriptEntry | null };

/**
 * Pair every `tool_use` with the `tool_result` that answers it (by
 * toolUseId) so the result renders under its call. Unmatched results —
 * a call whose entry was capped away — stay as their own rows.
 */
export function groupTranscript(entries: LocalTranscriptEntry[]): TranscriptItem[] {
  const results = new Map<string, LocalTranscriptEntry>();
  for (const e of entries) {
    if (e.kind === "tool_result" && e.toolUseId && !results.has(e.toolUseId)) {
      results.set(e.toolUseId, e);
    }
  }
  const claimed = new Set<number>();
  for (const e of entries) {
    if (e.kind === "tool_use" && e.toolUseId) {
      const r = results.get(e.toolUseId);
      if (r) claimed.add(r.seq);
    }
  }
  const out: TranscriptItem[] = [];
  for (const e of entries) {
    if (e.kind === "tool_use") {
      const result = e.toolUseId ? (results.get(e.toolUseId) ?? null) : null;
      out.push({ kind: "tool", use: e, result });
    } else if (e.kind !== "tool_result" || !claimed.has(e.seq)) {
      out.push({ kind: "entry", entry: e });
    }
  }
  return out;
}

function formatTime(at: string | null): string {
  if (!at) return "";
  const d = new Date(at);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * The conversation of an agent session, as a reading column: prompts,
 * replies (markdown), tool calls with their results folded underneath,
 * thinking collapsed. Text reflows to the viewport, so a session run on a
 * 132×40 grid reads on a phone; nothing here depends on the terminal size.
 * Sticks to the bottom while `live` and the reader hasn't scrolled up.
 */
export function TranscriptView({
  entries,
  live,
  className,
}: {
  entries: LocalTranscriptEntry[];
  live: boolean;
  className?: string;
}) {
  const items = useMemo(() => groupTranscript(entries), [entries]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showThinking, setShowThinking] = useState(false);

  // Land at the end (the latest exchange is what you came for), then follow
  // new entries only while the reader is already at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [items.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const thinkingCount = entries.reduce((n, e) => n + (e.kind === "thinking" ? 1 : 0), 0);

  if (entries.length === 0) {
    return (
      <div
        className={cn(
          "h-full flex flex-col items-center justify-center gap-2 text-text-muted text-sm px-6 text-center",
          className,
        )}
      >
        <MessagesSquare className="w-6 h-6 opacity-30" />
        {live ? "The conversation shows up here as the agent works." : "No conversation recorded."}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={cn("h-full overflow-y-auto overscroll-contain bg-bg", className)}
      data-testid="local-transcript"
    >
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 flex flex-col gap-3">
        {thinkingCount > 0 && (
          <button
            type="button"
            onClick={() => setShowThinking((v) => !v)}
            className="self-end text-[11px] text-text-muted hover:text-text transition-colors"
          >
            {showThinking ? "Hide" : "Show"} thinking ({thinkingCount})
          </button>
        )}
        {items.map((item) =>
          item.kind === "tool" ? (
            <ToolCallRow key={item.use.seq} use={item.use} result={item.result} />
          ) : item.entry.kind === "thinking" ? (
            showThinking ? (
              <ThinkingRow key={item.entry.seq} entry={item.entry} />
            ) : null
          ) : item.entry.role === "user" ? (
            <UserRow key={item.entry.seq} entry={item.entry} />
          ) : item.entry.kind === "tool_result" ? (
            <ToolCallRow key={item.entry.seq} use={null} result={item.entry} />
          ) : (
            <AssistantRow key={item.entry.seq} entry={item.entry} />
          ),
        )}
        {live && (
          <div className="flex items-center gap-2 text-[11px] text-text-muted py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            Session in progress
          </div>
        )}
      </div>
    </div>
  );
}

const UserRow = memo(function UserRow({ entry }: { entry: LocalTranscriptEntry }) {
  return (
    <div className="flex gap-2.5" data-role="user">
      <span className="mt-1 shrink-0 w-6 h-6 rounded-full bg-primary/15 text-primary flex items-center justify-center">
        <User className="w-3.5 h-3.5" />
      </span>
      <div className="min-w-0 flex-1 rounded-lg bg-bg-card border border-border px-3 py-2">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[11px] font-medium text-primary">You</span>
          <span className="text-[10px] text-text-muted tabular-nums">{formatTime(entry.at)}</span>
        </div>
        <div className="text-[13px] leading-relaxed whitespace-pre-wrap break-words text-text">
          {entry.text}
        </div>
      </div>
    </div>
  );
});

const AssistantRow = memo(function AssistantRow({ entry }: { entry: LocalTranscriptEntry }) {
  return (
    <div className="flex gap-2.5" data-role="assistant">
      <span className="mt-1 shrink-0 w-6 h-6 rounded-full bg-bg-hover text-text-muted flex items-center justify-center">
        <Sparkles className="w-3.5 h-3.5" />
      </span>
      <div className="min-w-0 flex-1 px-1 py-1">
        <LogMarkdown content={entry.text} className="text-text/90" />
      </div>
    </div>
  );
});

const ThinkingRow = memo(function ThinkingRow({ entry }: { entry: LocalTranscriptEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex gap-2.5 pl-8" data-role="thinking">
      <div className="min-w-0 flex-1 rounded-md border border-dashed border-border/60 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] text-text-muted hover:text-text"
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <Brain className="w-3 h-3" />
          Thinking
        </button>
        {open && (
          <div className="mt-1.5 text-[12px] leading-relaxed text-text-muted whitespace-pre-wrap break-words">
            {entry.text}
          </div>
        )}
      </div>
    </div>
  );
});

const ToolCallRow = memo(function ToolCallRow({
  use,
  result,
}: {
  use: LocalTranscriptEntry | null;
  result: LocalTranscriptEntry | null;
}) {
  const [open, setOpen] = useState(false);
  const toolName = use?.toolName ?? "Tool result";
  const Icon = (use && TOOL_ICONS[use.toolName ?? ""]) ?? Wrench;
  const isError = result?.isError === true;
  const hasBody = !!(use?.detail || result);
  return (
    <div
      className={cn(
        "ml-8 rounded-lg border overflow-hidden",
        isError ? "border-error/40" : "border-border/60",
      )}
      data-role="tool"
    >
      <button
        type="button"
        onClick={() => hasBody && setOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left bg-bg-card/60 hover:bg-bg-card-hover transition-colors"
        aria-expanded={open}
      >
        {hasBody ? (
          open ? (
            <ChevronDown className="w-3 h-3 text-text-muted/50 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-text-muted/50 shrink-0" />
          )
        ) : (
          <span className="w-3 h-3 shrink-0" />
        )}
        {isError ? (
          <AlertCircle className="w-3 h-3 text-error shrink-0" />
        ) : (
          <Icon className="w-3 h-3 text-primary shrink-0" />
        )}
        <span
          className={cn(
            "text-[11px] font-medium shrink-0",
            isError ? "text-error" : "text-primary",
          )}
        >
          {toolName}
        </span>
        <span className="text-[11px] font-mono text-text-muted truncate flex-1 min-w-0">
          {use?.text}
        </span>
      </button>
      {open && (
        <div className="border-t border-border/40 bg-bg divide-y divide-border/40">
          {use?.detail && (
            <pre className="px-3 py-2 text-[11px] leading-relaxed font-mono text-text-muted/80 whitespace-pre-wrap break-all max-h-72 overflow-auto">
              {use.detail}
            </pre>
          )}
          {result && (
            <pre
              className={cn(
                "px-3 py-2 text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-all max-h-96 overflow-auto",
                isError ? "text-error/80" : "text-text-muted/70",
              )}
            >
              {result.text || "(no output)"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});
