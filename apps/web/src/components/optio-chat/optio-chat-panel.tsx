"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, Check, Loader2, Pencil, Plus, X } from "lucide-react";
import { api, type OptioSessionSummary } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  createOptioChatStore,
  useOptioChatStore,
  type OptioConversationStore,
} from "@/hooks/use-optio-chat";
import { useCurrentUser } from "@/hooks/use-current-user";
import { OptioConversation } from "./optio-conversation";
import { usePanelSize } from "./use-panel-size";

function SessionTab({
  session,
  conversation,
  selected,
  select,
  seen,
  visible,
}: {
  session: OptioSessionSummary;
  conversation: OptioConversationStore;
  selected: boolean;
  select: () => void;
  seen: Map<string, string>;
  visible: boolean;
}) {
  const { status, messages, queuedMessages } = conversation();
  const tabRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const tab = tabRef.current;
    if (!selected || !tab) return;
    const reveal = () => tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(tab);
    if (tab.parentElement) observer.observe(tab.parentElement);
    return () => observer.disconnect();
  }, [selected]);
  const last = messages.at(-1)?.content;
  const signature = `${messages.length}:${last ?? ""}`;
  const unread = !!last && seen.get(session.id) !== signature;
  useEffect(() => {
    if (selected && visible) seen.set(session.id, signature);
  }, [selected, visible, signature, seen, session.id]);
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
  const displayTitle =
    session.title === "New session"
      ? messages.find((m) => m.role === "user")?.content.slice(0, 60) || session.title
      : session.title === "Ask Optio"
        ? "Optio Agent"
        : session.title;
  return (
    <button
      type="button"
      role="tab"
      ref={tabRef}
      aria-label={displayTitle}
      aria-description={label}
      tabIndex={selected ? 0 : -1}
      id={`optio-tab-${session.id}`}
      aria-controls={`optio-session-${session.id}`}
      aria-selected={selected}
      onClick={select}
      title={`${displayTitle} · ${label}`}
      className={cn(
        "flex max-w-[min(10rem,100%)] shrink-0 items-center gap-2 rounded-t-lg border-b-2 px-3 py-3 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-primary",
        selected
          ? "border-primary bg-primary/5 text-text-heading"
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
      <span className="truncate">{displayTitle}</span>
    </button>
  );
}

function EndSessionButton({
  conversation,
  onEnd,
}: {
  conversation: OptioConversationStore;
  onEnd: () => Promise<void>;
}) {
  const { status, messages, queuedMessages } = conversation();
  const [ending, setEnding] = useState(false);
  const disabled =
    ending ||
    status !== "ready" ||
    queuedMessages.length > 0 ||
    messages.some((m) => m.action?.decision === null);
  return (
    <button
      aria-label="End session"
      title={
        disabled
          ? "Finish this session's work and approvals before ending it"
          : "End session · saved history stays in Work"
      }
      disabled={disabled}
      onClick={async () => {
        setEnding(true);
        try {
          await onEnd();
        } finally {
          setEnding(false);
        }
      }}
      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-text-muted hover:bg-bg-hover disabled:opacity-30"
    >
      <Archive className="h-3.5 w-3.5" /> End session
    </button>
  );
}

export function OptioChatPanel() {
  const { user, loaded } = useCurrentUser();
  // A different viewer/workspace must never inherit sockets or drafts from this one.
  return loaded ? (
    <AgentPanel
      key={`${user?.id}:${user?.workspaceId}`}
      scope={`${user?.id}:${user?.workspaceId}`}
    />
  ) : null;
}

function AgentPanel({ scope }: { scope: string }) {
  const isOpen = useOptioChatStore((s) => s.isOpen);
  const [started, setStarted] = useState(false);
  const [sessions, setSessions] = useState<OptioSessionSummary[]>([]);
  const [active, setActive] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [docked, setDocked] = useState(false);
  const stores = useRef(new Map<string, OptioConversationStore>());
  const seen = useRef(new Map<string, string>());
  const mounted = useRef(true);
  const size = usePanelSize();
  const selectionKey = `optio.agent.active.${scope}`;
  const storeFor = useCallback((id: string) => {
    let store = stores.current.get(id);
    if (!store) {
      store = createOptioChatStore();
      store.getState().open();
      stores.current.set(id, store);
    }
    return store;
  }, []);
  const select = (id: string) => {
    setActive(id);
    setRenaming(false);
    try {
      sessionStorage.setItem(selectionKey, id);
    } catch {
      /* Optional preference. */
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    try {
      setDocked(localStorage.getItem("optio.assistant.docked") === "true");
    } catch {
      /* Optional preference. */
    }
  }, []);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      let { sessions: rows } = await api.listOptioSessions();
      if (!rows.length) rows = [(await api.createOptioSession(true)).session];
      if (!mounted.current) return;
      rows.forEach((s) => storeFor(s.id));
      setSessions(rows);
      setActive((current) => {
        let saved = current;
        try {
          saved ||= sessionStorage.getItem(selectionKey) || "";
        } catch {
          /* Optional preference. */
        }
        return rows.some((s) => s.id === saved) ? saved : rows[0].id;
      });
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : "Could not load sessions");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [selectionKey, storeFor]);
  useEffect(() => {
    if (isOpen) setStarted(true);
  }, [isOpen]);
  useEffect(() => {
    if (!started) return;
    void refresh();
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [started, refresh]);
  useEffect(() => {
    const update = () =>
      useOptioChatStore
        .getState()
        .setStatus(
          sessions.some((s) => storeFor(s.id).getState().status === "thinking")
            ? "thinking"
            : (stores.current.get(active)?.getState().status ?? "ready"),
        );
    const unsubscribe = sessions.map((s) => storeFor(s.id).subscribe(update));
    update();
    return () => unsubscribe.forEach((stop) => stop());
  }, [sessions, active, storeFor]);
  const create = async () => {
    setCreating(true);
    setError("");
    try {
      const { session } = await api.createOptioSession();
      if (!mounted.current) return;
      storeFor(session.id);
      setSessions((rows) => [...rows, session]);
      select(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create session");
    } finally {
      setCreating(false);
    }
  };
  const rename = async () => {
    if (!title.trim()) return;
    try {
      const { session } = await api.renameOptioSession(active, title.trim());
      setSessions((rows) => rows.map((s) => (s.id === session.id ? session : s)));
      setRenaming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename session");
    }
  };
  const end = async () => {
    const id = active;
    try {
      await api.endOptioSession(id);
      try {
        sessionStorage.removeItem(`optio.agent.draft.${id}`);
      } catch {
        /* Optional storage. */
      }
      setSessions((rows) => rows.filter((s) => s.id !== id));
      stores.current.delete(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not end session");
    }
  };
  const toggleDocked = () =>
    setDocked((value) => {
      try {
        localStorage.setItem("optio.assistant.docked", String(!value));
      } catch {
        /* Optional preference. */
      }
      return !value;
    });
  const tabs = (
    <div
      role="tablist"
      aria-label="Optio agent sessions"
      className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
      onKeyDown={(e) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
        e.preventDefault();
        const index = sessions.findIndex((s) => s.id === active);
        const next =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? sessions.length - 1
              : (index + (e.key === "ArrowRight" ? 1 : -1) + sessions.length) % sessions.length;
        select(sessions[next].id);
        requestAnimationFrame(() =>
          document.getElementById(`optio-tab-${sessions[next].id}`)?.focus(),
        );
      }}
    >
      {sessions.map((s) => (
        <SessionTab
          key={s.id}
          session={s}
          conversation={storeFor(s.id)}
          selected={active === s.id}
          seen={seen.current}
          visible={isOpen}
          select={() => select(s.id)}
        />
      ))}
    </div>
  );
  const newSessionButton = (
    <button
      onClick={create}
      disabled={creating}
      aria-label="New agent session"
      title="New independent session"
      className="shrink-0 rounded-lg p-2 text-primary hover:bg-primary/10 disabled:opacity-40"
    >
      {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
    </button>
  );
  const sessionActions = (
    <>
      <button
        onClick={() => {
          setTitle(sessions.find((s) => s.id === active)?.title || "");
          setRenaming(!renaming);
        }}
        aria-label="Rename session"
        title="Rename session"
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-text-muted hover:bg-bg-hover"
      >
        <Pencil className="h-3.5 w-3.5" /> Rename session
      </button>
      {active && <EndSessionButton conversation={storeFor(active)} onEnd={end} />}
    </>
  );
  const renameForm = renaming ? (
    <form
      className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        void rename();
      }}
    >
      <input
        autoFocus
        aria-label="Session name"
        maxLength={100}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="min-w-0 flex-1 rounded-lg border border-border bg-bg-card px-3 py-2 text-xs outline-primary"
      />
      <button aria-label="Save session name" disabled={!title.trim()} className="p-2 text-primary">
        <Check className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="Cancel rename"
        onClick={() => setRenaming(false)}
        className="p-2 text-text-muted"
      >
        <X className="h-4 w-4" />
      </button>
    </form>
  ) : null;
  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => useOptioChatStore.getState().close()}
        />
      )}
      <aside
        role="dialog"
        aria-label="Optio assistant"
        aria-hidden={!isOpen}
        inert={!isOpen}
        data-docked={docked}
        style={size.style}
        className={cn(
          "fixed bottom-0 left-0 z-50 flex h-[var(--app-height,100dvh)] w-full min-h-0 flex-col overflow-hidden border-l border-border bg-bg shadow-2xl md:bottom-3 md:left-[var(--agent-left)] md:h-[min(var(--agent-height),calc(var(--app-height,100dvh)-24px))] md:w-[var(--agent-width)] md:max-w-[calc(100vw-var(--agent-left)-12px)] md:rounded-2xl md:border",
          docked &&
            "lg:static lg:z-10 lg:h-full lg:max-w-[60vw] lg:shrink-0 lg:rounded-none lg:border-0 lg:border-r lg:shadow-none",
          !isOpen && "hidden",
        )}
      >
        {error && (
          <div
            role="alert"
            className="shrink-0 border-b border-warning/20 bg-warning/5 p-3 text-xs"
          >
            {error}{" "}
            <button onClick={() => void refresh()} className="ml-2 text-primary">
              Try again
            </button>
          </div>
        )}
        {!sessions.length && (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-text-muted">
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}{" "}
            {loading ? "Loading your sessions…" : "Optio Agent"}
            <button
              aria-label="Minimize Optio"
              onClick={() => useOptioChatStore.getState().close()}
              className="p-2"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {sessions.map((session) => (
          <div
            key={session.id}
            role="tabpanel"
            id={`optio-session-${session.id}`}
            aria-labelledby={`optio-tab-${session.id}`}
            className={cn("min-h-0 flex-1 flex-col", session.id === active ? "flex" : "hidden")}
          >
            <OptioConversation
              conversation={storeFor(session.id)}
              sessionId={session.id}
              active={session.id === active}
              docked={docked}
              toggleDocked={toggleDocked}
              tabs={session.id === active ? tabs : null}
              newSessionButton={newSessionButton}
              sessionActions={sessionActions}
              renameForm={session.id === active ? renameForm : null}
            />
          </div>
        ))}
        <button
          aria-label="Resize panel width"
          title="Drag to resize width, or use left and right arrow keys"
          className="absolute inset-y-3 right-0 z-20 hidden w-1.5 cursor-ew-resize touch-none hover:bg-primary/20 focus-visible:bg-primary/30 md:block"
          {...size.handle("width")}
        />
        <button
          aria-label="Resize panel height"
          title="Drag to resize height, or use up and down arrow keys"
          className={cn(
            "absolute inset-x-3 top-0 z-20 hidden h-1.5 cursor-ns-resize touch-none hover:bg-primary/20 focus-visible:bg-primary/30 md:block",
            docked && "lg:hidden",
          )}
          {...size.handle("height")}
        />
        <button
          aria-label="Resize panel"
          title="Drag to resize, or use arrow keys"
          className={cn(
            "absolute right-0 top-0 z-30 hidden h-3.5 w-3.5 cursor-nesw-resize touch-none rounded-tr-2xl hover:bg-primary/30 focus-visible:bg-primary/30 md:block",
            docked && "lg:hidden",
          )}
          {...size.handle("both")}
        />
      </aside>
    </>
  );
}
