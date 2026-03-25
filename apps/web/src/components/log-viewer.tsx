"use client";

import { Fragment, useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useLogs, type LogEntry } from "@/hooks/use-logs";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  ArrowDown,
  ArrowUp,
  Trash2,
  Terminal,
  AlertCircle,
  Info,
  Wrench,
  ChevronRight,
  ChevronDown,
  DollarSign,
  FileText,
  Pencil,
  Search,
  X,
  Download,
  Filter,
} from "lucide-react";

const TOOL_ICONS: Record<string, any> = {
  Bash: Terminal,
  Read: FileText,
  Edit: Pencil,
  Write: FileText,
  Grep: Search,
  Glob: Search,
};

const LOG_TYPES = [
  { value: "", label: "All types" },
  { value: "text", label: "Text" },
  { value: "tool_use", label: "Tool use" },
  { value: "tool_result", label: "Tool result" },
  { value: "thinking", label: "Thinking" },
  { value: "system", label: "System" },
  { value: "error", label: "Error" },
  { value: "info", label: "Info" },
];

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs > 0 ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function TimeGap({ ms }: { ms: number }) {
  return (
    <div className="flex items-center gap-2 py-1 my-0.5">
      <div className="flex-1 border-t border-dashed border-text-muted/15" />
      <span className="text-[10px] text-text-muted/30 font-sans tabular-nums px-1">
        {formatDuration(ms)}
      </span>
      <div className="flex-1 border-t border-dashed border-text-muted/15" />
    </div>
  );
}

function HighlightedText({ text, search }: { text: string; search: string }) {
  if (!search) return <>{text}</>;
  const regex = new RegExp(`(${search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="bg-warning/40 text-inherit rounded-sm px-0.5">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

export function LogViewer({ taskId }: { taskId: string }) {
  const { logs, connected, clear } = useLogs(taskId);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showThinking, setShowThinking] = useState(false);
  const [showResults, setShowResults] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [now, setNow] = useState(Date.now());

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Filter state
  const [logTypeFilter, setLogTypeFilter] = useState("");

  // Export state
  const [showExportMenu, setShowExportMenu] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50);
  };

  const toggleCollapse = useCallback((index: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  // Keyboard shortcut for search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setSearchQuery("");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [searchOpen]);

  // Build filtered logs: apply log type filter + thinking/results toggles
  const filteredLogs = useMemo(() => {
    return logs.filter((l) => {
      if (logTypeFilter && l.logType !== logTypeFilter) return false;
      if (l.logType === "thinking" && !showThinking) return false;
      return true;
    });
  }, [logs, logTypeFilter, showThinking]);

  // Search match indices (indices into filteredLogs that match the search query)
  const searchMatches = useMemo(() => {
    if (!searchQuery) return [];
    const q = searchQuery.toLowerCase();
    const matches: number[] = [];
    filteredLogs.forEach((l, i) => {
      if (l.content.toLowerCase().includes(q)) {
        matches.push(i);
      }
    });
    return matches;
  }, [filteredLogs, searchQuery]);

  // Clamp currentMatchIndex
  useEffect(() => {
    if (searchMatches.length === 0) {
      setCurrentMatchIndex(0);
    } else if (currentMatchIndex >= searchMatches.length) {
      setCurrentMatchIndex(searchMatches.length - 1);
    }
  }, [searchMatches.length, currentMatchIndex]);

  // Scroll to current match
  useEffect(() => {
    if (searchMatches.length === 0) return;
    const matchIdx = searchMatches[currentMatchIndex];
    if (matchIdx == null) return;
    const el = containerRef.current?.querySelector(`[data-log-index="${matchIdx}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setAutoScroll(false);
    }
  }, [currentMatchIndex, searchMatches]);

  const goToNextMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    setCurrentMatchIndex((prev) => (prev + 1) % searchMatches.length);
  }, [searchMatches.length]);

  const goToPrevMatch = useCallback(() => {
    if (searchMatches.length === 0) return;
    setCurrentMatchIndex((prev) => (prev - 1 + searchMatches.length) % searchMatches.length);
  }, [searchMatches.length]);

  const handleExport = useCallback(
    (format: string) => {
      const url = api.exportTaskLogs(taskId, { format });
      window.open(url, "_blank");
      setShowExportMenu(false);
    },
    [taskId],
  );

  // Group consecutive tool_use + tool_result pairs
  type LogGroup =
    | { type: "single"; entry: LogEntry; index: number }
    | { type: "tool_call"; use: LogEntry; result?: LogEntry; index: number };

  const groups: LogGroup[] = [];
  let i = 0;
  while (i < filteredLogs.length) {
    const entry = filteredLogs[i];
    if (entry.logType === "tool_use") {
      const next = i + 1 < filteredLogs.length ? filteredLogs[i + 1] : null;
      if (next?.logType === "tool_result") {
        groups.push({ type: "tool_call", use: entry, result: next, index: i });
        i += 2;
        continue;
      }
      groups.push({ type: "tool_call", use: entry, index: i });
      i++;
      continue;
    }
    if (entry.logType === "tool_result" && !showResults) {
      i++;
      continue;
    }
    groups.push({ type: "single", entry, index: i });
    i++;
  }

  // Create a set of match indices for highlight
  const matchIndexSet = useMemo(() => new Set(searchMatches), [searchMatches]);
  const currentHighlightIdx = searchMatches.length > 0 ? searchMatches[currentMatchIndex] : -1;

  return (
    <div className="flex flex-col h-full border border-border rounded-xl overflow-hidden bg-bg">
      {/* Search bar */}
      {searchOpen && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg-card">
          <Search className="w-3.5 h-3.5 text-text-muted shrink-0" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setCurrentMatchIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (e.shiftKey) goToPrevMatch();
                else goToNextMatch();
              }
            }}
            placeholder="Search logs..."
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-text-muted/40"
            autoFocus
          />
          {searchQuery && (
            <span className="text-[10px] text-text-muted tabular-nums shrink-0">
              {searchMatches.length > 0
                ? `${currentMatchIndex + 1}/${searchMatches.length}`
                : "No matches"}
            </span>
          )}
          <button
            onClick={goToPrevMatch}
            disabled={searchMatches.length === 0}
            className="p-1 rounded hover:bg-bg-hover text-text-muted disabled:opacity-30"
            title="Previous match (Shift+Enter)"
          >
            <ArrowUp className="w-3 h-3" />
          </button>
          <button
            onClick={goToNextMatch}
            disabled={searchMatches.length === 0}
            className="p-1 rounded hover:bg-bg-hover text-text-muted disabled:opacity-30"
            title="Next match (Enter)"
          >
            <ArrowDown className="w-3 h-3" />
          </button>
          <button
            onClick={() => {
              setSearchOpen(false);
              setSearchQuery("");
            }}
            className="p-1 rounded hover:bg-bg-hover text-text-muted"
            title="Close search (Esc)"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-bg-card">
        <div className="flex items-center gap-2.5 text-xs text-text-muted">
          <span
            className={cn(
              "w-2 h-2 rounded-full",
              connected ? "bg-success animate-pulse" : "bg-text-muted/30",
            )}
          />
          <span className="font-medium">{connected ? "Live" : "Ended"}</span>
          <span className="text-text-muted/30">&middot;</span>
          <span className="tabular-nums">{logs.length} events</span>
          {logs.length > 1 && (
            <>
              <span className="text-text-muted/30">&middot;</span>
              <span className="tabular-nums">
                {formatDuration(
                  new Date(logs[logs.length - 1].timestamp).getTime() -
                    new Date(logs[0].timestamp).getTime(),
                )}{" "}
                elapsed
              </span>
            </>
          )}
          {logs.length > 0 &&
            now - new Date(logs[logs.length - 1].timestamp).getTime() > 30_000 && (
              <>
                <span className="text-text-muted/30">&middot;</span>
                <span className="tabular-nums">
                  last {formatDuration(now - new Date(logs[logs.length - 1].timestamp).getTime())}{" "}
                  ago
                </span>
              </>
            )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Log type filter */}
          <div className="relative">
            <select
              value={logTypeFilter}
              onChange={(e) => setLogTypeFilter(e.target.value)}
              className={cn(
                "appearance-none pl-6 pr-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer bg-transparent border-none outline-none",
                logTypeFilter
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted/50 hover:text-text-muted hover:bg-bg-hover",
              )}
            >
              {LOG_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <Filter className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none text-text-muted/50" />
          </div>
          <button
            onClick={() => setShowThinking(!showThinking)}
            className={cn(
              "px-3 py-1 rounded-md text-xs font-medium transition-colors",
              showThinking
                ? "bg-bg-hover text-text"
                : "text-text-muted/50 hover:text-text-muted hover:bg-bg-hover",
            )}
          >
            Thinking
          </button>
          <button
            onClick={() => setShowResults(!showResults)}
            className={cn(
              "px-3 py-1 rounded-md text-xs font-medium transition-colors",
              showResults
                ? "bg-bg-hover text-text"
                : "text-text-muted/50 hover:text-text-muted hover:bg-bg-hover",
            )}
          >
            Results
          </button>
          <div className="w-px h-4 bg-border mx-1" />
          <button
            onClick={() => {
              setSearchOpen(true);
              setTimeout(() => searchInputRef.current?.focus(), 0);
            }}
            className={cn(
              "p-1.5 rounded-md hover:bg-bg-hover transition-colors",
              searchOpen ? "text-primary" : "text-text-muted/50 hover:text-text-muted",
            )}
            title="Search (Ctrl+F)"
          >
            <Search className="w-3.5 h-3.5" />
          </button>
          {/* Export dropdown */}
          <div className="relative">
            <button
              onClick={() => setShowExportMenu(!showExportMenu)}
              className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted/50 hover:text-text-muted transition-colors"
              title="Export logs"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
            {showExportMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowExportMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-20 bg-bg-card border border-border rounded-lg shadow-lg py-1 min-w-[140px]">
                  <button
                    onClick={() => handleExport("json")}
                    className="w-full px-3 py-1.5 text-left text-xs hover:bg-bg-hover transition-colors"
                  >
                    Export as JSON
                  </button>
                  <button
                    onClick={() => handleExport("plaintext")}
                    className="w-full px-3 py-1.5 text-left text-xs hover:bg-bg-hover transition-colors"
                  >
                    Export as Text
                  </button>
                  <button
                    onClick={() => handleExport("markdown")}
                    className="w-full px-3 py-1.5 text-left text-xs hover:bg-bg-hover transition-colors"
                  >
                    Export as Markdown
                  </button>
                </div>
              </>
            )}
          </div>
          <button
            onClick={clear}
            className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted/50 hover:text-text-muted transition-colors"
            title="Clear"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Log content */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto px-4 py-3 font-mono text-xs leading-6 relative"
      >
        {groups.length === 0 ? (
          <div className="text-text-muted/40 text-center py-12 font-sans">
            {logTypeFilter || searchQuery ? "No matching logs" : "Waiting for output..."}
          </div>
        ) : (
          groups.map((group, gi) => {
            const ts = group.type === "tool_call" ? group.use.timestamp : group.entry.timestamp;
            const prevGroup = gi > 0 ? groups[gi - 1] : null;
            const prevEnd = prevGroup
              ? prevGroup.type === "tool_call"
                ? (prevGroup.result?.timestamp ?? prevGroup.use.timestamp)
                : prevGroup.entry.timestamp
              : null;
            const gapMs = prevEnd ? new Date(ts).getTime() - new Date(prevEnd).getTime() : 0;

            const isMatch =
              group.type === "tool_call"
                ? matchIndexSet.has(group.index) ||
                  (group.result && matchIndexSet.has(group.index + 1))
                : matchIndexSet.has(group.index);
            const isCurrent =
              group.type === "tool_call"
                ? currentHighlightIdx === group.index || currentHighlightIdx === group.index + 1
                : currentHighlightIdx === group.index;

            return (
              <Fragment key={group.index}>
                {gapMs > 10000 && <TimeGap ms={gapMs} />}
                <div
                  className={cn(
                    "flex gap-2.5",
                    isMatch && "bg-warning/5 -mx-2 px-2 rounded",
                    isCurrent && "ring-1 ring-warning/50 bg-warning/10",
                  )}
                  data-log-index={group.index}
                >
                  <span
                    className="text-[10px] leading-6 text-text-muted/25 tabular-nums shrink-0 select-none w-[54px] text-right"
                    title={new Date(ts).toLocaleString()}
                  >
                    {formatTime(ts)}
                  </span>
                  <div className="flex-1 min-w-0">
                    {group.type === "tool_call" ? (
                      <ToolCallGroup
                        group={group}
                        isCollapsed={collapsed.has(group.index)}
                        onToggle={() => toggleCollapse(group.index)}
                        showResults={showResults}
                        searchQuery={searchQuery}
                      />
                    ) : (
                      <LogLine log={group.entry} searchQuery={searchQuery} />
                    )}
                  </div>
                </div>
              </Fragment>
            );
          })
        )}
      </div>

      {/* Scroll to bottom */}
      {!autoScroll && (
        <button
          onClick={() => {
            setAutoScroll(true);
            containerRef.current?.scrollTo({
              top: containerRef.current.scrollHeight,
              behavior: "smooth",
            });
          }}
          className="absolute bottom-14 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-bg-card border border-border text-xs text-text-muted hover:text-text shadow-lg transition-colors flex items-center gap-1.5 font-sans"
        >
          <ArrowDown className="w-3 h-3" />
          Scroll to bottom
        </button>
      )}
    </div>
  );
}

function ToolCallGroup({
  group,
  isCollapsed,
  onToggle,
  showResults,
  searchQuery,
}: {
  group: { use: LogEntry; result?: LogEntry };
  isCollapsed: boolean;
  onToggle: () => void;
  showResults: boolean;
  searchQuery: string;
}) {
  const toolName = (group.use.metadata?.toolName as string) ?? "Tool";
  const Icon = TOOL_ICONS[toolName] ?? Wrench;
  const showBody = !isCollapsed && group.result && showResults;

  return (
    <div className="rounded-lg border border-border/50 my-1.5 overflow-hidden">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 w-full px-3 py-2 text-left bg-bg-card hover:bg-bg-card-hover transition-colors"
      >
        {group.result ? (
          isCollapsed ? (
            <ChevronRight className="w-3 h-3 text-text-muted/40 shrink-0" />
          ) : (
            <ChevronDown className="w-3 h-3 text-text-muted/40 shrink-0" />
          )
        ) : (
          <span className="w-3 h-3 shrink-0" />
        )}
        <Icon className="w-3 h-3 text-primary shrink-0" />
        <span className="text-[11px] font-medium text-primary font-sans">{toolName}</span>
        <span className="text-text-muted/60 truncate flex-1">
          <HighlightedText text={group.use.content} search={searchQuery} />
        </span>
      </button>
      {showBody && (
        <div className="px-3 py-2 border-t border-border/30 bg-bg max-h-60 overflow-auto">
          <pre className="text-text-muted/50 whitespace-pre-wrap break-all">
            <HighlightedText text={group.result!.content} search={searchQuery} />
          </pre>
        </div>
      )}
    </div>
  );
}

function LogLine({
  log,
  searchQuery,
}: {
  log: { content: string; logType?: string; metadata?: Record<string, unknown> };
  searchQuery: string;
}) {
  const type = log.logType ?? "text";

  if (type === "system") {
    return (
      <div className="flex items-center gap-2 py-1 text-info/50 font-sans text-[11px]">
        <Info className="w-3 h-3 shrink-0" />
        <span>
          <HighlightedText text={log.content} search={searchQuery} />
        </span>
      </div>
    );
  }

  if (type === "thinking") {
    return (
      <div className="py-1.5 pl-4 border-l-2 border-text-muted/20 text-text-muted/50 italic bg-bg-subtle/30 rounded-r-md my-0.5">
        <HighlightedText text={log.content} search={searchQuery} />
      </div>
    );
  }

  if (type === "tool_result") {
    let display = log.content;
    const patchIdx = display.indexOf('","structuredPatch":');
    if (patchIdx !== -1) display = display.slice(0, patchIdx);
    display = display.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
    return (
      <div className="py-0.5 pl-5 text-text-muted/50 overflow-auto max-h-60">
        <pre className="whitespace-pre-wrap break-all text-[11px] leading-relaxed">
          <HighlightedText text={display} search={searchQuery} />
        </pre>
      </div>
    );
  }

  if (type === "info") {
    const cost = log.metadata?.cost as number | undefined;
    return (
      <div className="flex items-start gap-2 py-1.5 text-success/80">
        <ChevronRight className="w-3 h-3 mt-0.5 shrink-0" />
        <div>
          <span className="whitespace-pre-wrap">
            <HighlightedText text={log.content} search={searchQuery} />
          </span>
          {cost != null && cost > 0 && (
            <span className="ml-2 text-text-muted/40 inline-flex items-center gap-0.5 tabular-nums">
              <DollarSign className="w-2.5 h-2.5" />
              {cost.toFixed(4)}
            </span>
          )}
        </div>
      </div>
    );
  }

  if (type === "error") {
    return (
      <div className="flex items-start gap-2 py-1.5 px-2 -mx-1 rounded-md bg-error/5 text-error my-0.5">
        <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
        <span className="whitespace-pre-wrap">
          <HighlightedText text={log.content} search={searchQuery} />
        </span>
      </div>
    );
  }

  // Text — default agent output
  return (
    <div className="py-0.5 text-text/90 whitespace-pre-wrap break-words">
      <HighlightedText text={log.content} search={searchQuery} />
    </div>
  );
}
