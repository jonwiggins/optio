"use client";

import Link from "next/link";
import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { AgentIcon } from "@/components/brand-icon";
import { runtimeLabel } from "@/components/agent-choice-model";
import { OptioMark } from "@/components/optio-mark";
import {
  Minus,
  MoreHorizontal,
  Settings,
  ExternalLink,
  ArrowUp,
  Eraser,
  Loader2,
  Mic,
  Square,
  ArrowUpRight,
  AlertCircle,
  Anchor,
} from "lucide-react";
import { useOptioChatStore, type OptioConversationStore } from "@/hooks/use-optio-chat";
import { useOptioConnection } from "@/hooks/use-optio-connection";
import { useDictation } from "@/hooks/use-dictation";
import { ActionCard } from "./action-card.js";
import { api } from "@/lib/api-client";
import { QueuedMessages } from "@/components/queued-messages";
import { ChatMarkdown } from "./chat-markdown.js";

const SUGGESTIONS = [
  {
    title: "Start a work session",
    detail: "Choose a machine, repo and agent together",
    prompt:
      "Help me start an agent work session. Show me my machines and repos so we can choose where it should run.",
  },
  {
    title: "Hand off a task",
    detail: "Describe a change and have an agent take it on",
    prompt:
      "I want to hand off a coding task. Help me choose a repo and an agent, then create the work.",
  },
  {
    title: "See what needs me",
    detail: "Catch up on work across the workspace",
    prompt: "Look at my work and summarize what needs my attention.",
  },
];

export function OptioConversation({
  conversation,
  sessionId,
  active,
  docked,
  toggleDocked,
  tabs,
  newSessionButton,
  sessionActions,
  renameForm,
}: {
  conversation: OptioConversationStore;
  sessionId: string;
  active: boolean;
  docked: boolean;
  toggleDocked: () => void;
  tabs: ReactNode;
  newSessionButton: ReactNode;
  sessionActions: ReactNode;
  renameForm: ReactNode;
}) {
  const panelOpen = useOptioChatStore((s) => s.isOpen);
  const prefillInput = useOptioChatStore((s) => s.prefillInput);
  const isOpen = panelOpen && active;
  const { messages, status, confirmWrites, agentRuntime, agentModel, queuedMessages } =
    conversation();
  const connection = useOptioConnection(conversation, sessionId);
  const [input, setInput] = useState(() => {
    try {
      return sessionStorage.getItem(`optio.agent.draft.${sessionId}`) || "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem(`optio.agent.draft.${sessionId}`, input);
    } catch {
      /* Storage is optional. */
    }
  }, [input, sessionId]);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const appendTranscript = useCallback((text: string) => {
    if (text) setInput((draft) => (draft ? `${draft.trimEnd()} ${text}` : text));
  }, []);
  const dictation = useDictation(appendTranscript);
  const pending = messages.some((m) => m.action?.decision === null);
  const busy = status === "thinking";
  const connected = status === "ready" || busy;
  const statusLabel =
    status === "starting"
      ? "Connecting"
      : busy
        ? "Working"
        : !connected
          ? "Disconnected"
          : pending
            ? "Awaiting approval"
            : "Ready";
  const canCompose = connected && queuedMessages.length < 20;

  useEffect(() => {
    api
      .getOptioSettings()
      .then(({ settings }) => {
        const store = conversation.getState();
        store.setConfirmWrites(settings.confirmWrites);
        if (!store.agentRuntime) store.setAgentConfiguration(settings.agentRuntime, settings.model);
      })
      .catch(() => {});
  }, [conversation]);

  useEffect(() => {
    if (prefillInput && isOpen) {
      setInput(prefillInput);
      useOptioChatStore.getState().setPrefillInput("");
    }
  }, [prefillInput, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      if (menuRef.current) menuRef.current.open = false;
      dictation.cancel();
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (menuRef.current?.open) {
          menuRef.current.open = false;
          menuRef.current.querySelector("summary")?.focus();
          return;
        }
        useOptioChatStore.getState().close();
      }
      // The desktop panel is non-modal; only trap focus in the mobile overlay.
      if (event.key === "Tab" && window.matchMedia("(max-width: 767px)").matches) {
        const controls = panelRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href], summary",
        );
        const visible = Array.from(controls ?? []).filter(
          (el) => el.getClientRects().length > 0 && el.tabIndex >= 0,
        );
        if (!visible.length) return;
        const first = visible[0],
          last = visible[visible.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const outsideMenu = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node))
        menuRef.current.open = false;
    };
    document.addEventListener("pointerdown", outsideMenu);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", outsideMenu);
      previous?.focus();
    };
  }, [isOpen, dictation.cancel]);

  useEffect(() => {
    if (isOpen && follow.current && scrollRef.current)
      scrollRef.current.scrollTop = messages.length ? scrollRef.current.scrollHeight : 0;
  }, [messages, busy, isOpen]);

  useEffect(() => {
    const field = inputRef.current;
    if (field) {
      field.style.height = "auto";
      field.style.height = `${Math.min(field.scrollHeight, 120)}px`;
    }
  }, [input, isOpen]);

  const send = () => {
    if (dictation.active || !canCompose) return;
    if (connection.send(input)) {
      setInput("");
      follow.current = true;
    }
  };
  const menuButton =
    "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-text-muted hover:bg-bg-hover disabled:opacity-40";
  const iconButton =
    "rounded-lg p-2 text-text-muted transition-colors hover:bg-bg-hover hover:text-text disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-primary";

  return (
    <div ref={panelRef} className={cn("min-h-0 flex-1 flex-col", active ? "flex" : "hidden")}>
      <header className="relative flex shrink-0 items-center gap-1 border-b border-border/60 bg-bg-subtle/30 px-2">
        <h2 className="sr-only">Optio Agent</h2>
        <div className="shrink-0 px-1" role="status" aria-label={statusLabel} title={statusLabel}>
          {" "}
          <div className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <OptioMark className="h-4 w-4 text-primary" />
            {agentRuntime && (
              <span
                role="img"
                aria-label={`${runtimeLabel(agentRuntime)} · ${agentModel || "Default model"}`}
                title={`${runtimeLabel(agentRuntime)} · ${agentModel || "Default model"}`}
                className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-md border border-border bg-bg-card shadow-sm"
              >
                <AgentIcon runtime={agentRuntime} colored className="h-3 w-3" />
              </span>
            )}
          </div>
        </div>
        {tabs}
        <div className="flex shrink-0 items-center">
          {newSessionButton}
          <span className="flex w-8 shrink-0">
            {connection.sessionHref && (
              <Link
                href={connection.sessionHref}
                onClick={() => useOptioChatStore.getState().close()}
                className={iconButton}
                aria-label="Open in session"
                title="Open in session"
              >
                <ExternalLink className="h-4 w-4" />
              </Link>
            )}
          </span>

          <details ref={menuRef} className="relative">
            <summary
              role="button"
              aria-label="Session options"
              title="Session options"
              className={cn(
                iconButton,
                "list-none cursor-pointer [&::-webkit-details-marker]:hidden",
              )}
            >
              <MoreHorizontal className="h-4 w-4" />
            </summary>
            <div
              className="absolute right-0 top-full z-40 mt-1 w-52 rounded-xl border border-border bg-bg-card p-1.5 shadow-xl"
              onClick={() => {
                if (menuRef.current) menuRef.current.open = false;
              }}
            >
              {sessionActions}
              <button
                className={cn(menuButton, "hidden lg:flex", docked && "bg-primary/10 text-primary")}
                title={docked ? "Float assistant" : "Dock assistant beside the page"}
                aria-label={docked ? "Float assistant" : "Dock assistant"}
                aria-pressed={docked}
                onClick={toggleDocked}
              >
                <Anchor className="h-4 w-4" /> {docked ? "Float assistant" : "Dock assistant"}
              </button>
              <button
                className={menuButton}
                title="Clear conversation history"
                aria-label="Clear conversation"
                disabled={status !== "ready" || pending || queuedMessages.length > 0}
                onClick={() => {
                  dictation.cancel();
                  connection.reset();
                  setInput("");
                }}
              >
                <Eraser className="h-4 w-4" /> Clear conversation
              </button>

              <div className="my-1 border-t border-border/60" />
              <Link
                href="/settings#agents"
                onClick={() => useOptioChatStore.getState().close()}
                className={menuButton}
                aria-label="Optio agent settings"
                title="Optio agent settings"
              >
                <Settings className="h-4 w-4" /> Agent settings
              </Link>
            </div>
          </details>
          <button
            className={iconButton}
            title="Minimize (Esc)"
            aria-label="Minimize Optio"
            onClick={() => useOptioChatStore.getState().close()}
          >
            <Minus className="h-4 w-4" />
          </button>
        </div>
      </header>
      {renameForm}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5"
        data-testid="optio-conversation-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages.length === 0 ? (
          <div className="flex min-h-full flex-col pb-2">
            <p className="mb-3 text-xs font-medium text-primary">FROM IDEA TO RUNNING WORK</p>
            <h3 className="max-w-sm text-3xl font-semibold tracking-tight text-text-heading">
              What would you like
              <br />
              to get done?
            </h3>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-text-muted">
              Tell me what you have in mind. I can find the right repo, start an agent, and set up
              the work with you.
            </p>
            <div className="mt-8 space-y-2">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion.title}
                  onClick={() => {
                    setInput(suggestion.prompt);
                    inputRef.current?.focus();
                  }}
                  className="group flex w-full items-center justify-between gap-3 rounded-xl border border-border/70 bg-bg-card px-4 py-3.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
                >
                  <span>
                    <span className="block text-sm font-medium text-text">{suggestion.title}</span>
                    <span className="mt-1 block text-xs text-text-muted">{suggestion.detail}</span>
                  </span>
                  <ArrowUpRight className="h-4 w-4 shrink-0 text-text-muted group-hover:text-primary" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-5" role="log" aria-label="Conversation">
            {messages.map((msg) => (
              <div key={msg.id} className={cn("min-w-0", msg.role === "user" && "ml-6")}>
                {msg.role === "user" ? (
                  <div className="whitespace-pre-wrap [overflow-wrap:anywhere] rounded-xl border border-border/60 bg-bg-card px-3.5 py-3 text-sm leading-relaxed text-text">
                    {msg.content}
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    <div className="flex items-center gap-2 text-xs font-medium text-text-muted">
                      <OptioMark className="h-3.5 w-3.5 text-primary" />
                      Optio Agent
                    </div>
                    {msg.action ? (
                      <ActionCard
                        action={msg.action}
                        disabled={!connected || busy}
                        onApprove={(id) => connection.decide(id, true)}
                        onDeny={(id, feedback) => connection.decide(id, false, feedback)}
                      />
                    ) : (
                      <div
                        className={cn(
                          "min-w-0 [overflow-wrap:anywhere]",
                          msg.isError && "rounded-xl border border-error/20 bg-error/5 p-3",
                        )}
                      >
                        <ChatMarkdown content={msg.content} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {busy && (
              <div role="status" className="flex items-center gap-2 text-xs text-text-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Working on it…
              </div>
            )}
          </div>
        )}
      </div>

      <div
        className="max-h-[60%] shrink-0 overflow-y-auto px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        data-testid="optio-composer"
      >
        <QueuedMessages messages={queuedMessages} onCancel={connection.cancelQueued} />
        {!connected && status !== "starting" && (
          <div className="mb-3 rounded-xl border border-warning/20 bg-warning/5 p-3 text-xs text-text">
            <p>Connection lost. Actions won’t be retried automatically.</p>
            <button
              onClick={connection.reconnect}
              className="mt-2 font-medium text-primary hover:underline"
            >
              Reconnect
            </button>
          </div>
        )}
        {pending && connected && (
          <p className="pb-3 text-xs text-text-muted">
            Review the proposed action above to continue.
          </p>
        )}

        <div
          className={cn(
            "optio-composer rounded-xl border bg-bg-card p-2 transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/10",
            dictation.active ? "border-primary/60" : "border-border",
          )}
        >
          <textarea
            ref={inputRef}
            aria-label="Message Optio"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Message Optio…"
            rows={1}
            className="block min-h-8 max-h-[min(120px,calc(var(--app-height,100dvh)*0.25))] w-full resize-none bg-transparent px-1 py-1 text-sm leading-relaxed text-text outline-none placeholder:text-text-muted"
          />
          {dictation.active && (
            <div
              role="status"
              className="mb-2 rounded-lg bg-primary/5 px-2 py-2 text-xs text-primary"
            >
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
                {dictation.state === "starting"
                  ? "Opening microphone…"
                  : dictation.state === "stopping"
                    ? "Finishing dictation…"
                    : "Listening…"}
              </span>
              {dictation.interim && (
                <p className="mt-1.5 leading-relaxed text-text-muted">{dictation.interim}</p>
              )}
            </div>
          )}
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={dictation.active ? dictation.stop : dictation.start}
              disabled={!dictation.supported || dictation.state === "stopping"}
              aria-label={dictation.active ? "Stop dictation" : "Start dictation"}
              aria-pressed={dictation.active}
              title={
                dictation.supported
                  ? "Dictate a message"
                  : (dictation.unavailable ?? "Checking speech recognition support…")
              }
              className={cn(
                "flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-medium transition-colors disabled:opacity-40",
                dictation.active
                  ? "bg-primary/10 text-primary"
                  : "text-text-muted hover:bg-bg-hover hover:text-text",
              )}
            >
              {dictation.active ? <Square className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              {dictation.active ? "Stop dictation" : "Dictate"}
            </button>
            <button
              onClick={send}
              aria-label="Send message"
              title={
                busy || pending || queuedMessages.length ? "Queue message (Enter)" : "Send (Enter)"
              }
              disabled={!input.trim() || !canCompose || dictation.active}
              className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          </div>
        </div>
        {dictation.error && (
          <p role="alert" className="mt-2 flex items-start gap-1.5 px-1 text-xs text-error">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {dictation.error}
          </p>
        )}
        {(dictation.active || !confirmWrites) && (
          <p className="mt-2 px-1 text-center text-[11px] leading-relaxed text-text-muted">
            {dictation.active
              ? "Review your words, then send. Audio is handled by your browser’s speech service."
              : "Actions run directly · confirmation is off in Settings."}
          </p>
        )}
      </div>
    </div>
  );
}
