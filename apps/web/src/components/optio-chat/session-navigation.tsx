"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Check, List, Loader2, Search } from "lucide-react";
import type { OptioSessionSummary } from "@/lib/api-client";
import type { OptioConversationStore } from "@/hooks/use-optio-chat";
import { cn } from "@/lib/utils";

type SessionsProps = {
  sessions: OptioSessionSummary[];
  active: string;
  storeFor: (id: string) => OptioConversationStore;
  seen: Map<string, string>;
  visible: boolean;
  select: (id: string) => void;
};

function sessionTitle(session: OptioSessionSummary, conversation: OptioConversationStore) {
  if (session.title === "Ask Optio") return "Optio Agent";
  if (session.title !== "New session") return session.title;
  return (
    conversation
      .getState()
      .messages.find((message) => message.role === "user")
      ?.content.slice(0, 60) || session.title
  );
}

function SessionItem({
  session,
  conversation,
  selected,
  seen,
  visible,
  select,
  list = false,
  hidden = false,
}: {
  session: OptioSessionSummary;
  conversation: OptioConversationStore;
  selected: boolean;
  seen: Map<string, string>;
  visible: boolean;
  select: () => void;
  list?: boolean;
  hidden?: boolean;
}) {
  const { status, messages, queuedMessages } = conversation();
  const last = messages.at(-1)?.content;
  const signature = `${messages.length}:${last ?? ""}`;
  const unread = !!last && seen.get(session.id) !== signature;
  useEffect(() => {
    if (selected && visible && !list) seen.set(session.id, signature);
  }, [selected, visible, signature, seen, session.id, list]);
  const pending = messages.some((m) => m.action?.decision === null);
  const busy = status === "thinking" || queuedMessages.length > 0;
  const label = pending
    ? "Needs approval"
    : busy
      ? "Working"
      : status === "starting"
        ? "Connecting"
        : status === "disconnected"
          ? "Disconnected"
          : unread && !selected
            ? "New reply"
            : "Ready";
  const title = sessionTitle(session, conversation);
  return (
    <button
      type="button"
      role={list ? undefined : "tab"}
      hidden={hidden}
      aria-label={title}
      aria-description={label}
      tabIndex={list || selected ? 0 : -1}
      id={list ? undefined : `optio-tab-${session.id}`}
      aria-controls={list ? undefined : `optio-session-${session.id}`}
      aria-selected={list ? undefined : selected}
      aria-current={list && selected ? "true" : undefined}
      onClick={select}
      title={`${title} · ${label}`}
      className={cn(
        "min-w-0 items-center gap-2 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
        hidden ? "hidden" : "flex",
        list ? "w-full rounded-xl border p-3" : "h-11 flex-1 border-b-2 px-3 text-xs",
        selected
          ? "border-primary/60 bg-primary/5 text-text-heading"
          : "border-transparent text-text-muted hover:bg-bg-hover",
      )}
    >
      {busy || status === "starting" ? (
        <Loader2 aria-label={label} className="h-3 w-3 shrink-0 animate-spin text-primary" />
      ) : (
        <span
          aria-label={label}
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            pending
              ? "bg-warning"
              : unread && !selected
                ? "bg-primary"
                : status === "disconnected"
                  ? "bg-error"
                  : "bg-success/60",
          )}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className={cn("block", list ? "break-words text-sm font-medium" : "truncate")}>
          {title}
        </span>
        {list && <span className="mt-1 block text-xs text-text-muted">{label}</span>}
      </span>
      {list && selected && <Check className="h-4 w-4 shrink-0 text-primary" />}
    </button>
  );
}

export function SessionNavigation({
  sessions,
  active,
  storeFor,
  seen,
  visible,
  select,
  showSessions,
  browsing,
}: SessionsProps & { showSessions: () => void; browsing: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    setWidth(element.clientWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Keep titles readable. Overflow is a session directory, never a clipped or
  // horizontally scrolling tab strip. The selected session always has a tab.
  const capacity = Math.max(1, Math.floor((width - 48) / 144));
  const index = Math.max(
    0,
    sessions.findIndex((s) => s.id === active),
  );
  const start = Math.max(0, Math.min(index - Math.floor(capacity / 2), sessions.length - capacity));
  const overflow = Math.max(0, sessions.length - capacity);
  const subscribe = useCallback(
    (notify: () => void) => {
      const stops = sessions.map((session) => storeFor(session.id).subscribe(notify));
      return () => stops.forEach((stop) => stop());
    },
    [sessions, storeFor],
  );
  const activity = useSyncExternalStore(
    subscribe,
    () => {
      let approvals = 0,
        replies = 0;
      sessions.forEach((session, i) => {
        if (i >= start && i < start + capacity) return;
        const { messages } = storeFor(session.id).getState();
        if (messages.some((message) => message.action?.decision === null)) approvals++;
        else {
          const last = messages.at(-1)?.content;
          if (last && seen.get(session.id) !== `${messages.length}:${last}`) replies++;
        }
      });
      return approvals
        ? `${approvals} ${approvals === 1 ? "session needs" : "sessions need"} approval`
        : replies
          ? `${replies} ${replies === 1 ? "session has a new reply" : "sessions have new replies"}`
          : "";
    },
    () => "",
  );
  return (
    <div ref={ref} className="flex min-w-0 flex-1 items-center gap-1">
      <button
        type="button"
        aria-label="All sessions"
        aria-expanded={browsing}
        aria-description={activity || undefined}
        title={`All ${sessions.length} sessions`}
        onClick={showSessions}
        className={cn(
          "relative flex h-8 w-11 shrink-0 items-center justify-center gap-1 rounded-lg text-text-muted hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-primary",
          browsing && "bg-primary/10 text-primary",
        )}
      >
        <List className="h-4 w-4" />
        {activity && (
          <span
            className={cn(
              "absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full",
              activity.includes("approval") ? "bg-warning" : "bg-primary",
            )}
          />
        )}
        {overflow > 0 && <span className="text-[10px] tabular-nums">{sessions.length}</span>}
      </button>
      <div
        role="tablist"
        aria-label="Optio agent sessions"
        className="flex min-w-0 flex-1 overflow-hidden"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !sessions.length)
            return;
          event.preventDefault();
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? sessions.length - 1
                : (index + (event.key === "ArrowRight" ? 1 : -1) + sessions.length) %
                  sessions.length;
          select(sessions[next].id);
          requestAnimationFrame(() =>
            document.getElementById(`optio-tab-${sessions[next].id}`)?.focus(),
          );
        }}
      >
        {sessions.map((session, i) => (
          <SessionItem
            key={session.id}
            session={session}
            conversation={storeFor(session.id)}
            selected={session.id === active}
            seen={seen}
            visible={visible}
            select={() => select(session.id)}
            hidden={i < start || i >= start + capacity}
          />
        ))}
      </div>
    </div>
  );
}

export function SessionDirectory(props: SessionsProps) {
  const [query, setQuery] = useState("");
  const matches = props.sessions.filter((session) =>
    sessionTitle(session, props.storeFor(session.id))
      .toLowerCase()
      .includes(query.toLowerCase().trim()),
  );
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 rounded-lg border border-border bg-bg-card px-3 py-2 text-text-muted">
        <Search className="h-4 w-4 shrink-0" />
        <input
          autoFocus
          aria-label="Find a session"
          placeholder="Find a session…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none"
        />
      </label>
      <p className="text-xs text-text-muted">
        {props.sessions.length} sessions · work continues when you switch
      </p>
      <div className="space-y-1" aria-label="Session directory">
        {matches.map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            conversation={props.storeFor(session.id)}
            selected={session.id === props.active}
            seen={props.seen}
            visible={false}
            select={() => props.select(session.id)}
            list
          />
        ))}
        {!matches.length && (
          <p className="py-6 text-center text-sm text-text-muted">No sessions match “{query}”.</p>
        )}
      </div>
    </div>
  );
}
