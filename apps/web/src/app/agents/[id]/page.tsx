"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { cn, formatRelativeTime } from "@/lib/utils";
import { createPersistentAgentEventsClient } from "@/lib/ws-client";
import { getWsTokenProvider } from "@/lib/ws-auth";
import { LogViewer } from "@/components/log-viewer";
import { useAgentLiveLogs, useAgentTurnLogs } from "@/hooks/use-agent-logs";
import {
  Bot,
  ArrowLeft,
  Send,
  Pause,
  Play,
  RotateCcw,
  Archive,
  Trash2,
  Inbox,
  ChevronDown,
  ChevronRight,
  Loader2,
  CircleDot,
} from "lucide-react";

const STATE_STYLES: Record<string, { dot: string; label: string }> = {
  idle: { dot: "bg-text-muted/50", label: "Idle" },
  queued: { dot: "bg-warning", label: "Queued" },
  provisioning: { dot: "bg-warning animate-pulse", label: "Provisioning" },
  running: { dot: "bg-primary animate-pulse", label: "Running" },
  paused: { dot: "bg-text-muted/30", label: "Paused" },
  failed: { dot: "bg-error", label: "Failed" },
  archived: { dot: "bg-text-muted/20", label: "Archived" },
};

interface Agent {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  state: string;
  enabled: boolean;
  agentRuntime: string;
  podLifecycle: string;
  totalCostUsd: string;
  consecutiveFailures: number;
  lastFailureReason: string | null;
  lastTurnAt: string | null;
  systemPrompt: string | null;
  agentsMd: string | null;
  initialPrompt: string;
}

interface Message {
  id: string;
  senderType: string;
  senderName: string | null;
  body: string;
  broadcasted: boolean;
  receivedAt: string;
  processedAt: string | null;
  turnId: string | null;
}

interface Turn {
  id: string;
  turnNumber: number;
  wakeSource: string;
  haltReason: string | null;
  errorMessage: string | null;
  costUsd: string | null;
  summary: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export default function AgentDetailPage() {
  const params = useParams<{ id: string }>();
  const agentId = params.id;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [inbox, setInbox] = useState({ pending: 0 });
  const [messages, setMessages] = useState<Message[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [tab, setTab] = useState<"chat" | "turns" | "config">("chat");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [openTurns, setOpenTurns] = useState<Set<string>>(new Set());

  // Live log stream — fed into LogViewer in the chat tab. Same widget as
  // task / job / review log views; the only thing that varies is the source.
  const liveLogs = useAgentLiveLogs(agentId);

  const refreshAgent = async () => {
    try {
      const res = await api.getPersistentAgent(agentId);
      setAgent(res.agent as Agent);
      setInbox(res.inbox);
    } catch {
      toast.error("Failed to load agent");
    }
  };

  const refreshMessages = async () => {
    try {
      const res = await api.listPersistentAgentMessages(agentId, 50);
      setMessages(res.messages as Message[]);
    } catch {
      // ignore
    }
  };

  const refreshTurns = async () => {
    try {
      const res = await api.listPersistentAgentTurns(agentId, 30);
      setTurns(res.turns as Turn[]);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refreshAgent();
    refreshMessages();
    refreshTurns();
    // refresh* helpers are stable closures — re-running on every render is unnecessary.
  }, [agentId]);

  // Subscribe to non-log events (state, message, turn lifecycle) — log
  // events are owned by useAgentLiveLogs.
  useEffect(() => {
    const client = createPersistentAgentEventsClient(agentId, getWsTokenProvider());
    client.connect();
    const unsubState = client.on("persistent_agent:state_changed", () => {
      refreshAgent();
      refreshTurns();
    });
    const unsubMsg = client.on("persistent_agent:message", () => {
      refreshAgent();
      refreshMessages();
    });
    const unsubStart = client.on("persistent_agent:turn_started", () => {
      refreshAgent();
      refreshTurns();
    });
    const unsubHalt = client.on("persistent_agent:turn_halted", () => {
      refreshAgent();
      refreshMessages();
      refreshTurns();
    });
    return () => {
      unsubState();
      unsubMsg();
      unsubStart();
      unsubHalt();
      client.disconnect();
    };
    // refresh* helpers are stable closures — re-running on every render is unnecessary.
  }, [agentId]);

  const submitMessage = async () => {
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await api.sendPersistentAgentMessage(agentId, draft.trim());
      setDraft("");
      // Optimistically refresh
      refreshAgent();
      refreshMessages();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  };

  const control = async (intent: "pause" | "resume" | "archive" | "restart") => {
    try {
      await api.controlPersistentAgent(agentId, intent);
      toast.success(`Sent ${intent} intent`);
      refreshAgent();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Control failed");
    }
  };

  // Each open turn renders an ExpandedTurnLogs child that owns its own
  // useAgentTurnLogs hook — no need to manage a turn-id → logs map here.
  const toggleTurn = (turn: Turn) => {
    const next = new Set(openTurns);
    if (next.has(turn.id)) {
      next.delete(turn.id);
    } else {
      next.add(turn.id);
    }
    setOpenTurns(next);
  };

  const remove = async () => {
    if (!confirm("Delete this agent and all its turn history?")) return;
    try {
      await api.deletePersistentAgent(agentId);
      toast.success("Deleted");
      window.location.href = "/agents";
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
    }
  };

  if (!agent) {
    return (
      <div className="p-6 text-text-muted text-sm flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading agent…
      </div>
    );
  }

  const style = STATE_STYLES[agent.state] ?? STATE_STYLES.idle;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Link
        href="/agents"
        className="text-sm text-text-muted hover:text-text flex items-center gap-1 mb-4"
      >
        <ArrowLeft className="w-4 h-4" /> Agents
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-3">
            <Bot className="w-6 h-6 text-primary" />
            <h1 className="text-2xl font-semibold">{agent.name}</h1>
            <span className="text-sm text-text-muted font-mono">@{agent.slug}</span>
            <span className="flex items-center gap-1.5 text-xs px-2 py-1 rounded-md border border-border">
              <span className={cn("w-2 h-2 rounded-full", style.dot)} />
              {style.label}
            </span>
          </div>
          {agent.description ? (
            <p className="text-sm text-text-muted mt-2">{agent.description}</p>
          ) : null}
          <div className="flex items-center gap-4 mt-3 text-xs text-text-muted">
            <span>{agent.agentRuntime}</span>
            <span className="capitalize">{agent.podLifecycle}</span>
            <span>${Number(agent.totalCostUsd ?? 0).toFixed(4)} lifetime</span>
            {inbox.pending > 0 ? (
              <span className="text-warning flex items-center gap-1">
                <Inbox className="w-3 h-3" /> {inbox.pending} pending
              </span>
            ) : null}
            {agent.consecutiveFailures > 0 ? (
              <span className="text-error">{agent.consecutiveFailures} consecutive failures</span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {agent.state === "paused" || agent.state === "failed" ? (
            <button
              onClick={() => control("resume")}
              className="px-2.5 py-1.5 rounded-md bg-bg border border-border text-xs hover:bg-bg-hover flex items-center gap-1"
            >
              <Play className="w-3.5 h-3.5" /> Resume
            </button>
          ) : agent.state !== "archived" ? (
            <button
              onClick={() => control("pause")}
              className="px-2.5 py-1.5 rounded-md bg-bg border border-border text-xs hover:bg-bg-hover flex items-center gap-1"
            >
              <Pause className="w-3.5 h-3.5" /> Pause
            </button>
          ) : null}
          <button
            onClick={() => control("restart")}
            className="px-2.5 py-1.5 rounded-md bg-bg border border-border text-xs hover:bg-bg-hover flex items-center gap-1"
          >
            <RotateCcw className="w-3.5 h-3.5" /> Restart
          </button>
          {agent.state !== "archived" ? (
            <button
              onClick={() => control("archive")}
              className="px-2.5 py-1.5 rounded-md bg-bg border border-border text-xs hover:bg-bg-hover flex items-center gap-1"
            >
              <Archive className="w-3.5 h-3.5" /> Archive
            </button>
          ) : null}
          <button
            onClick={remove}
            className="px-2.5 py-1.5 rounded-md bg-bg border border-border text-xs text-error hover:bg-error/10 flex items-center gap-1"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        </div>
      </div>

      {agent.lastFailureReason ? (
        <div className="text-xs text-error bg-error/5 border border-error/30 rounded-md px-3 py-2 mb-4">
          Last failure: {agent.lastFailureReason}
        </div>
      ) : null}

      {/* Tabs */}
      <div className="flex border-b border-border mb-4">
        {(["chat", "turns", "config"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-4 py-2 text-sm border-b-2 -mb-px capitalize",
              tab === t
                ? "border-primary text-text"
                : "border-transparent text-text-muted hover:text-text",
            )}
          >
            {t === "turns" ? `Turns (${turns.length})` : t}
          </button>
        ))}
      </div>

      {tab === "chat" ? (
        <ChatTab
          agent={agent}
          messages={messages}
          liveLogs={liveLogs}
          draft={draft}
          setDraft={setDraft}
          submitMessage={submitMessage}
          sending={sending}
        />
      ) : null}

      {tab === "turns" ? (
        <TurnsTab agentId={agentId} turns={turns} openTurns={openTurns} toggleTurn={toggleTurn} />
      ) : null}

      {tab === "config" ? <ConfigTab agent={agent} /> : null}
    </div>
  );
}

function ChatTab({
  agent,
  messages,
  liveLogs,
  draft,
  setDraft,
  submitMessage,
  sending,
}: {
  agent: Agent;
  messages: Message[];
  liveLogs: ReturnType<typeof useAgentLiveLogs>;
  draft: string;
  setDraft: (v: string) => void;
  submitMessage: () => void;
  sending: boolean;
}) {
  const reversedMessages = [...messages].reverse();

  return (
    <div className="grid lg:grid-cols-2 gap-4">
      {/* Messages column */}
      <div className="flex flex-col h-[640px] border border-border rounded-lg bg-bg-card overflow-hidden">
        <div className="px-3 py-2 border-b border-border text-xs font-medium text-text-muted flex items-center gap-2">
          <Inbox className="w-3.5 h-3.5" /> Inbox
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {reversedMessages.length === 0 ? (
            <div className="text-text-muted text-sm">
              No messages yet. Send one below to wake the agent.
            </div>
          ) : (
            reversedMessages.map((m) => (
              <div
                key={m.id}
                className={cn(
                  "rounded-md px-3 py-2 text-sm border",
                  m.senderType === "user"
                    ? "bg-primary/10 border-primary/20"
                    : m.senderType === "agent"
                      ? "bg-bg border-border"
                      : "bg-bg border-border/50 italic text-text-muted",
                )}
              >
                <div className="flex items-center gap-2 text-xs text-text-muted mb-1">
                  <span className="font-mono">
                    {m.senderType}:{m.senderName ?? "unknown"}
                  </span>
                  {m.broadcasted ? (
                    <span className="px-1.5 py-0.5 rounded bg-warning/20 text-warning text-[10px]">
                      broadcast
                    </span>
                  ) : null}
                  <span className="ml-auto">{formatRelativeTime(m.receivedAt)}</span>
                </div>
                <div className="whitespace-pre-wrap font-mono text-xs">{m.body}</div>
                {m.processedAt ? (
                  <div className="text-[10px] text-text-muted/70 mt-1">
                    Processed {formatRelativeTime(m.processedAt)}
                  </div>
                ) : (
                  <div className="text-[10px] text-warning mt-1">Pending</div>
                )}
              </div>
            ))
          )}
        </div>
        <div className="border-t border-border p-3">
          <textarea
            className="w-full px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 min-h-[60px]"
            placeholder={`Message ${agent.name}…`}
            value={draft}
            disabled={agent.state === "archived"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitMessage();
              }
            }}
          />
          <div className="flex items-center justify-between mt-2">
            <div className="text-[11px] text-text-muted">⌘/Ctrl+Enter to send</div>
            <button
              onClick={submitMessage}
              disabled={sending || !draft.trim() || agent.state === "archived"}
              className="px-3 py-1.5 rounded-md bg-primary text-white text-sm hover:bg-primary-hover disabled:opacity-50 flex items-center gap-1.5"
            >
              {sending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              Send
            </button>
          </div>
        </div>
      </div>

      {/* Live activity — same widget Tasks / Jobs / Reviews use */}
      <div className="h-[640px] flex flex-col">
        <LogViewer externalLogs={liveLogs} />
      </div>
    </div>
  );
}

function TurnsTab({
  agentId,
  turns,
  openTurns,
  toggleTurn,
}: {
  agentId: string;
  turns: Turn[];
  openTurns: Set<string>;
  toggleTurn: (turn: Turn) => void;
}) {
  if (turns.length === 0) {
    return <div className="text-text-muted text-sm">No turns yet.</div>;
  }
  return (
    <div className="space-y-2">
      {turns.map((turn) => {
        const isOpen = openTurns.has(turn.id);
        return (
          <div key={turn.id} className="border border-border rounded-md bg-bg-card">
            <button
              onClick={() => toggleTurn(turn)}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-bg-hover/40"
            >
              {isOpen ? (
                <ChevronDown className="w-4 h-4 text-text-muted" />
              ) : (
                <ChevronRight className="w-4 h-4 text-text-muted" />
              )}
              <span className="text-sm font-medium">Turn #{turn.turnNumber}</span>
              <span className="text-xs text-text-muted">{turn.wakeSource}</span>
              {turn.haltReason ? (
                <span
                  className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded",
                    turn.haltReason === "error"
                      ? "bg-error/15 text-error"
                      : "bg-text-muted/10 text-text-muted",
                  )}
                >
                  {turn.haltReason}
                </span>
              ) : (
                <span className="text-[10px] text-warning flex items-center gap-1">
                  <CircleDot className="w-2.5 h-2.5 animate-pulse" /> running
                </span>
              )}
              {turn.costUsd ? (
                <span className="text-xs text-text-muted ml-auto">
                  ${Number(turn.costUsd).toFixed(5)}
                </span>
              ) : null}
              <span className="text-xs text-text-muted">
                {formatRelativeTime(turn.startedAt ?? turn.createdAt)}
              </span>
            </button>
            {isOpen ? (
              <div className="border-t border-border">
                {turn.summary || turn.errorMessage ? (
                  <div className="px-3 pt-3">
                    {turn.summary ? (
                      <div className="text-xs text-text-muted mb-2 italic">{turn.summary}</div>
                    ) : null}
                    {turn.errorMessage ? (
                      <div className="text-xs text-error bg-error/5 border border-error/30 rounded px-2 py-1 mb-2">
                        {turn.errorMessage}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="h-[480px] flex flex-col">
                  <ExpandedTurnLogs agentId={agentId} turnId={turn.id} />
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ConfigTab({ agent }: { agent: Agent }) {
  return (
    <div className="space-y-4">
      <Block title="System prompt" body={agent.systemPrompt} />
      <Block title="Operator manual (agents.md)" body={agent.agentsMd} />
      <Block title="Initial prompt" body={agent.initialPrompt} />
    </div>
  );
}

/**
 * Owns its own useAgentTurnLogs hook so each open turn gets a clean fetch
 * and unmounting (collapse) cleans up. Uses LogViewer for actual rendering
 * so the turn-history view matches the live activity panel and the task /
 * job / review log views one for one.
 */
function ExpandedTurnLogs({ agentId, turnId }: { agentId: string; turnId: string }) {
  const logs = useAgentTurnLogs(agentId, turnId);
  return <LogViewer externalLogs={logs} />;
}

function Block({ title, body }: { title: string; body: string | null }) {
  return (
    <div className="border border-border rounded-md bg-bg-card">
      <div className="px-3 py-2 border-b border-border text-xs font-medium text-text-muted">
        {title}
      </div>
      <pre className="px-3 py-2 text-xs whitespace-pre-wrap font-mono max-h-[400px] overflow-y-auto">
        {body ?? <span className="text-text-muted italic">(empty)</span>}
      </pre>
    </div>
  );
}
