"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { LocalTranscriptEntry } from "@optio/shared";
import {
  AlertCircle,
  ArrowDown,
  Bell,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  FileText,
  FoldVertical,
  Globe,
  Info,
  ListChecks,
  Pencil,
  ScrollText,
  Search,
  Sparkles,
  SlidersHorizontal,
  Terminal,
  Undo2,
  User,
  Wrench,
  MessagesSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LogMarkdown } from "@/components/log-markdown";
import { CHAT_WIDTH_PX, DEFAULT_CHAT_FONT_SIZE, useChatDisplayStore } from "./chat-display-store";
import { ChatDisplayControls } from "./chat-display-controls";

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
  // Codex (codex-transcript.ts names its calls these)
  Shell: Terminal,
  exec: Terminal,
  Patch: Pencil,
  Plan: ListChecks,
  ViewImage: FileText,
};

/** How a `system` entry reads: what put it there, and its icon. */
const SYSTEM_TURNS: Record<string, { label: string; icon: typeof Info; collapse?: boolean }> = {
  task: { label: "Background task", icon: Bell },
  agent: { label: "Message from another agent", icon: Bot },
  compact: { label: "Earlier conversation summarized", icon: FoldVertical, collapse: true },
  interrupt: { label: "Interrupted", icon: CircleSlash },
  rewind: { label: "Rolled back", icon: Undo2 },
  other: { label: "From the agent CLI", icon: Info, collapse: true },
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

/**
 * What reads as the conversation: what you (or a background task, another
 * agent, a compaction) put in, and the agent's last reply to it. Everything
 * between — tool calls, thinking, the agent's running commentary — folds into
 * one "steps" block, so a turn with a hundred tool calls reads as your
 * message, one folded line, and the answer.
 */
export type TranscriptBlock =
  | { kind: "item"; item: TranscriptItem }
  | { kind: "steps"; items: TranscriptItem[] };

function opensTurn(item: TranscriptItem): boolean {
  return item.kind === "entry" && (item.entry.role === "user" || item.entry.role === "system");
}

function isReply(item: TranscriptItem): boolean {
  return item.kind === "entry" && item.entry.kind === "text" && item.entry.role === "assistant";
}

/**
 * Per turn (what follows each `opensTurn` item): the steps before the
 * turn's last reply, the reply, then the steps after it — a turn still at
 * work has those. A run of one step isn't folded (a tool call is a folded
 * row already).
 */
export function foldTranscript(items: TranscriptItem[]): TranscriptBlock[] {
  const out: TranscriptBlock[] = [];
  const pushSteps = (steps: TranscriptItem[]) => {
    if (steps.length === 1) out.push({ kind: "item", item: steps[0]! });
    else if (steps.length > 1) out.push({ kind: "steps", items: steps });
  };
  let turn: TranscriptItem[] = [];
  const flush = () => {
    let reply = -1;
    for (let i = turn.length - 1; i >= 0; i--) {
      if (isReply(turn[i]!)) {
        reply = i;
        break;
      }
    }
    if (reply < 0) {
      pushSteps(turn);
    } else {
      pushSteps(turn.slice(0, reply));
      out.push({ kind: "item", item: turn[reply]! });
      pushSteps(turn.slice(reply + 1));
    }
    turn = [];
  };
  for (const item of items) {
    if (opensTurn(item)) {
      flush();
      out.push({ kind: "item", item });
    } else {
      turn.push(item);
    }
  }
  flush();
  return out;
}

/** "12 tool calls · 3 messages · thinking" — what a folded steps block holds. */
export function stepsSummary(items: TranscriptItem[]): string {
  let tools = 0;
  let messages = 0;
  let thinking = 0;
  for (const item of items) {
    if (
      item.kind === "tool" ||
      item.entry.kind === "tool_result" ||
      item.entry.kind === "tool_use"
    ) {
      tools++;
    } else if (item.entry.kind === "thinking") thinking++;
    else messages++;
  }
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  return [
    tools > 0 && plural(tools, "tool call"),
    messages > 0 && plural(messages, "message"),
    thinking > 0 && "thinking",
  ]
    .filter(Boolean)
    .join(" · ");
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
  compact = false,
}: {
  entries: LocalTranscriptEntry[];
  live: boolean;
  className?: string;
  compact?: boolean;
}) {
  const items = useMemo(() => groupTranscript(entries), [entries]);
  const blocks = useMemo(() => foldTranscript(items), [items]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  // Every steps block open or shut at once; each one still toggles on its own.
  const [allSteps, setAllSteps] = useState(false);

  // Land at the end (the latest exchange is what you came for), then follow
  // new entries only while the reader is already at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  // Expanded steps and display preferences change the column's height too.
  // Follow those changes only while the reader is already at the end.
  useEffect(() => {
    const el = scrollRef.current;
    const column = columnRef.current;
    if (!el || !column) return;
    const resize = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
      setShowLatest(el.scrollHeight - el.scrollTop - el.clientHeight >= 48);
    });
    resize.observe(column);
    resize.observe(el);
    return () => resize.disconnect();
  }, [entries.length > 0]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setShowLatest(!stickToBottom.current);
  };

  const fontSize = useChatDisplayStore((s) => s.fontSize);
  const width = useChatDisplayStore((s) => s.width);
  useEffect(() => useChatDisplayStore.getState().hydrate(), []);

  // ⌘/Ctrl + = / − / 0 while the chat has focus: font size, like a browser's zoom.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const store = useChatDisplayStore.getState();
    if (e.key === "=" || e.key === "+") store.stepFontSize(1);
    else if (e.key === "-") store.stepFontSize(-1);
    else if (e.key === "0") store.setFontSize(DEFAULT_CHAT_FONT_SIZE);
    else return;
    e.preventDefault();
  };

  const stepsCount = blocks.reduce((n, b) => n + (b.kind === "steps" ? 1 : 0), 0);
  const displayControls = (
    <>
      {stepsCount > 0 && (
        <button
          type="button"
          onClick={() => setAllSteps((v) => !v)}
          className="text-[11px] text-text-muted hover:text-text transition-colors"
        >
          {allSteps ? "Collapse" : "Expand"} all steps
        </button>
      )}
      <ChatDisplayControls className="ml-auto" />
    </>
  );

  if (entries.length === 0) {
    return (
      <div
        className={cn(
          "h-full flex flex-col items-center justify-center gap-2 text-text-muted text-sm px-6 text-center",
          className,
        )}
      >
        <span className="mb-2 flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10 text-primary">
          <MessagesSquare className="w-5 h-5" />
        </span>
        <p className="font-medium text-text-heading">
          {live ? "Your conversation starts here" : "No conversation recorded"}
        </p>
        <p className="max-w-xs text-xs leading-relaxed">
          {live
            ? "Messages and activity appear as the agent works. You can switch to Terminal at any time."
            : "Switch to Terminal to view this session’s output."}
        </p>
      </div>
    );
  }

  return (
    <div
      onKeyDown={onKeyDown}
      className={cn("relative h-full min-h-0 flex flex-col bg-bg", className)}
    >
      {compact ? (
        <details
          className="absolute right-3 top-2 z-20"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.currentTarget.open = false;
              e.currentTarget.querySelector("summary")?.focus();
            }
          }}
        >
          <summary
            aria-label="Chat display settings"
            title="Chat display settings"
            className="ml-auto flex h-6 w-6 cursor-pointer list-none items-center justify-center rounded-md border border-border/70 bg-bg-card text-text-muted hover:text-text [&::-webkit-details-marker]:hidden"
          >
            <SlidersHorizontal className="h-3 w-3" />
          </summary>
          <div className="mt-1 flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-lg border border-border bg-bg-card p-2 shadow-lg">
            {displayControls}
          </div>
        </details>
      ) : (
        <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 @xl:px-5 py-1.5 border-b border-border/40 bg-bg-card/15">
          <span className="hidden @md:inline text-[11px] font-medium text-text-muted">
            Conversation
          </span>
          {displayControls}
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        tabIndex={-1}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain outline-none"
        data-testid="local-transcript"
      >
        <div
          ref={columnRef}
          className={cn("mx-auto px-4 @xl:px-6 flex flex-col gap-5", compact ? "py-3" : "py-6")}
          style={{ fontSize, maxWidth: CHAT_WIDTH_PX[width] ?? "none" }}
          data-testid="local-transcript-column"
        >
          {blocks.map((block) =>
            block.kind === "steps" ? (
              <StepsRow
                // Keyed on its first entry, which stays put as the turn grows;
                // `allSteps` in the key resets a block's own toggle.
                key={`steps-${itemSeq(block.items[0]!)}-${allSteps}`}
                items={block.items}
                defaultOpen={allSteps}
                working={live && block === blocks[blocks.length - 1]}
              />
            ) : (
              <TranscriptItemRow key={itemSeq(block.item)} item={block.item} />
            ),
          )}
          {live && !compact && (
            <div className="flex items-center gap-2 text-[0.85em] text-text-muted py-2 pl-10">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              Session in progress
            </div>
          )}
        </div>
      </div>
      {showLatest && (
        <button
          type="button"
          aria-label="Scroll to latest message"
          onClick={() => {
            const el = scrollRef.current;
            if (!el) return;
            stickToBottom.current = true;
            el.scrollTop = el.scrollHeight;
            setShowLatest(false);
          }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-bg-card px-3 py-2 text-xs font-medium text-primary shadow-lg hover:bg-bg-hover"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          Latest
        </button>
      )}
    </div>
  );
}

function itemSeq(item: TranscriptItem): number {
  return item.kind === "tool" ? item.use.seq : item.entry.seq;
}

function TranscriptItemRow({ item }: { item: TranscriptItem }) {
  if (item.kind === "tool") return <ToolCallRow use={item.use} result={item.result} />;
  const entry = item.entry;
  if (entry.kind === "thinking") return <ThinkingRow entry={entry} />;
  if (entry.role === "system") return <SystemRow entry={entry} />;
  if (entry.role === "user") {
    return entry.source === "prompt" ? <PromptRow entry={entry} /> : <UserRow entry={entry} />;
  }
  if (entry.kind === "tool_result") return <ToolCallRow use={null} result={entry} />;
  return <AssistantRow entry={entry} />;
}

/**
 * A turn's in-between work, folded to one line: what it holds, and — while
 * the agent is at it — the step it's on. Open, it lists every step as the
 * rows they'd be on their own.
 */
function StepsRow({
  items,
  defaultOpen,
  working,
}: {
  items: TranscriptItem[];
  defaultOpen: boolean;
  working: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const errors = items.filter((i) => i.kind === "tool" && i.result?.isError).length;
  const last = items[items.length - 1]!;
  const current =
    working && last.kind === "tool"
      ? `${last.use.toolName ?? "Tool"}${last.use.text ? ` · ${last.use.text}` : ""}`
      : null;
  return (
    <div
      className="ml-10 rounded-lg border border-border/50 bg-bg-card/30 px-3 py-1.5"
      data-role="steps"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 w-full text-left text-[0.85em] text-text-muted hover:text-text transition-colors py-0.5"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 shrink-0" />
        )}
        <Wrench className="w-3 h-3 shrink-0" />
        <span className="min-w-0 break-words">{stepsSummary(items)}</span>
        {errors > 0 && <span className="shrink-0 text-error">· {errors} failed</span>}
        {current && !open && (
          <span className="min-w-0 truncate font-mono text-text-muted/70">· {current}</span>
        )}
      </button>
      {open && (
        <div className="mt-3 -ml-10 flex flex-col gap-3">
          {items.map((item) => (
            <TranscriptItemRow key={itemSeq(item)} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

const UserRow = memo(function UserRow({ entry }: { entry: LocalTranscriptEntry }) {
  return (
    <div className="flex gap-3" data-role="user">
      <span className="mt-1 shrink-0 w-7 h-7 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
        <User className="w-3.5 h-3.5" />
      </span>
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-primary/5 border border-primary/15 px-4 py-3">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="text-[0.85em] font-medium text-primary">You</span>
          <span className="text-[0.77em] text-text-muted tabular-nums">{formatTime(entry.at)}</span>
        </div>
        <div className="text-[1em] leading-relaxed whitespace-pre-wrap break-words text-text">
          {entry.text}
        </div>
      </div>
    </div>
  );
});

/**
 * The prompt the session started with — from the New work form, an
 * automation's template, a headless run — rather than a turn typed into the
 * running session.
 */
const PromptRow = memo(function PromptRow({ entry }: { entry: LocalTranscriptEntry }) {
  return (
    <div className="flex gap-3" data-role="prompt">
      <span className="mt-1 shrink-0 w-7 h-7 rounded-lg bg-bg-hover text-text-muted flex items-center justify-center">
        <ScrollText className="w-3.5 h-3.5" />
      </span>
      <div className="min-w-0 flex-1 rounded-xl bg-bg-card/50 border border-dashed border-border px-4 py-3">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[0.85em] font-medium text-text-muted">Prompt</span>
          <span className="text-[0.77em] text-text-muted tabular-nums">{formatTime(entry.at)}</span>
        </div>
        <div className="text-[1em] leading-relaxed whitespace-pre-wrap break-words text-text">
          {entry.text}
        </div>
      </div>
    </div>
  );
});

/**
 * A turn the agent CLI filed as the person's but isn't: a background task
 * reporting back, another agent's message, a compaction summary, an
 * interruption. Its first line reads inline; the rest folds away.
 */
const SystemRow = memo(function SystemRow({ entry }: { entry: LocalTranscriptEntry }) {
  const turn = SYSTEM_TURNS[entry.source ?? "other"] ?? SYSTEM_TURNS.other!;
  const Icon = turn.icon;
  const newline = entry.text.indexOf("\n");
  const head = turn.collapse
    ? turn.label
    : newline >= 0
      ? entry.text.slice(0, newline)
      : entry.text;
  const rest = turn.collapse
    ? entry.text
    : newline >= 0
      ? entry.text.slice(newline + 1).trim()
      : "";
  const [open, setOpen] = useState(false);
  return (
    <div className="flex gap-2.5 pl-10" data-role="system" data-source={entry.source ?? "other"}>
      <div className="min-w-0 flex-1 rounded-md border border-border/60 bg-bg-card/40 px-3 py-1.5">
        <button
          type="button"
          onClick={() => rest && setOpen((v) => !v)}
          className={cn(
            "flex items-start gap-1.5 w-full text-left text-[0.85em] text-text-muted",
            rest && "hover:text-text",
          )}
          aria-expanded={rest ? open : undefined}
        >
          {rest ? (
            open ? (
              <ChevronDown className="w-3 h-3 mt-0.5 shrink-0" />
            ) : (
              <ChevronRight className="w-3 h-3 mt-0.5 shrink-0" />
            )
          ) : null}
          <Icon className="w-3 h-3 mt-0.5 shrink-0" />
          <span className="min-w-0">
            {!turn.collapse && <span className="font-medium">{turn.label} · </span>}
            <span className={cn(turn.collapse && "font-medium")}>{head}</span>
          </span>
          <span className="ml-auto pl-2 text-[0.9em] tabular-nums shrink-0">
            {formatTime(entry.at)}
          </span>
        </button>
        {open && rest && (
          <div className="mt-1.5 text-[0.92em] leading-relaxed text-text-muted whitespace-pre-wrap break-words max-h-96 overflow-auto">
            {rest}
          </div>
        )}
      </div>
    </div>
  );
});

const AssistantRow = memo(function AssistantRow({ entry }: { entry: LocalTranscriptEntry }) {
  return (
    <div className="flex gap-3" data-role="assistant">
      <span className="mt-1 shrink-0 w-7 h-7 rounded-lg border border-border/70 bg-bg-card text-primary flex items-center justify-center">
        <Sparkles className="w-3.5 h-3.5" />
      </span>
      <div className="min-w-0 flex-1 py-1">
        <div className="mb-2 flex items-center gap-2 text-[0.85em]">
          <span className="font-medium text-text-heading">Agent</span>
          <span className="text-[0.9em] text-text-muted tabular-nums">{formatTime(entry.at)}</span>
        </div>
        <LogMarkdown content={entry.text} className="chat-md text-text/90" breaks />
      </div>
    </div>
  );
});

const ThinkingRow = memo(function ThinkingRow({ entry }: { entry: LocalTranscriptEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex gap-2.5 pl-10" data-role="thinking">
      <div className="min-w-0 flex-1 rounded-md border border-dashed border-border/60 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[0.85em] text-text-muted hover:text-text"
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <Brain className="w-3 h-3" />
          Thinking
        </button>
        {open && (
          <div className="mt-1.5 text-[0.92em] leading-relaxed text-text-muted whitespace-pre-wrap break-words">
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
        "ml-10 rounded-lg border overflow-hidden",
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
            "text-[0.85em] font-medium shrink-0",
            isError ? "text-error" : "text-primary",
          )}
        >
          {toolName}
        </span>
        <span className="text-[0.85em] font-mono text-text-muted truncate flex-1 min-w-0">
          {use?.text}
        </span>
      </button>
      {open && (
        <div className="border-t border-border/40 bg-bg divide-y divide-border/40">
          {use?.detail && (
            <pre className="px-3 py-2 text-[0.85em] leading-relaxed font-mono text-text-muted/80 whitespace-pre-wrap break-all max-h-72 overflow-auto">
              {use.detail}
            </pre>
          )}
          {result && (
            <pre
              className={cn(
                "px-3 py-2 text-[0.85em] leading-relaxed font-mono whitespace-pre-wrap break-all max-h-96 overflow-auto",
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
