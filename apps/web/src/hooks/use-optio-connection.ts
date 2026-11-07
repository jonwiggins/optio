"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getWsBaseUrl } from "@/lib/ws-client";
import { useOptioChatStore, type OptioConversationStore } from "./use-optio-chat";

const message = (content: string) => ({
  id: crypto.randomUUID?.() ?? `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  role: "assistant" as const,
  content,
  timestamp: new Date().toISOString(),
});

/** One socket for the panel's lifetime. Never replay a write after a disconnect. */
export function useOptioConnection(
  conversation: OptioConversationStore = useOptioChatStore,
  sessionId?: string,
) {
  const store = conversation.getState;
  const isOpen = conversation((s) => s.isOpen);
  const [started, setStarted] = useState(false);
  const [sessionHref, setSessionHref] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const socket = useRef<WebSocket | null>(null);
  const streamId = useRef<string | null>(null);
  const ready = useRef(false);
  const failures = useRef(0);

  useEffect(() => {
    if (isOpen) setStarted(true);
  }, [isOpen]);

  useEffect(() => {
    if (!started) return;
    store().setStatus("starting");
    ready.current = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Authenticate the viewer; the session receives its own scoped MCP credentials.
    const ws = new WebSocket(
      `${getWsBaseUrl()}/ws/optio/chat${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    );
    socket.current = ws;
    const current = () => socket.current === ws;
    ws.onmessage = (event) => {
      if (!current()) return;
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      const s = store();
      switch (frame.type) {
        case "history":
          if (!Array.isArray(frame.frames)) return;
          s.resetMessages();
          streamId.current = null;
          if (
            typeof frame.href === "string" &&
            /^\/(?:work|sessions)\/[a-f0-9-]+$/.test(frame.href)
          )
            setSessionHref(frame.href.replace(/^\/sessions\//, "/work/"));
          for (const f of frame.frames) {
            const content = f.content ?? f.summary ?? f.message;
            if (typeof content !== "string") continue;
            const previous = store().messages.at(-1);
            if (f.type === "text" && streamId.current && previous?.id === streamId.current) {
              s.updateMessage(previous.id, { content: previous.content + content });
            } else {
              const next = {
                ...message(content),
                role: f.type === "user_message" ? ("user" as const) : ("assistant" as const),
                isError: f.type === "error",
              };
              s.addMessage(next);
              streamId.current = f.type === "text" ? next.id : null;
            }
          }
          break;
        case "queue":
          if (Array.isArray(frame.messages)) s.setQueuedMessages(frame.messages);
          break;
        case "user_message":
          if (typeof frame.content === "string")
            s.addMessage({ ...message(frame.content), role: "user" });
          streamId.current = null;
          break;
        case "status":
          if (typeof frame.runtime === "string")
            s.setAgentConfiguration(
              frame.runtime,
              typeof frame.model === "string" ? frame.model : "",
            );
          failures.current = 0;
          ready.current = true;
          s.setStatus(
            frame.status === "thinking" || frame.status === "executing" ? "thinking" : "ready",
          );
          if (frame.status === "ready") streamId.current = null;
          break;
        case "text": {
          if (typeof frame.content !== "string") return;
          const existing = s.messages.find((m) => m.id === streamId.current);
          if (existing) s.updateMessage(existing.id, { content: existing.content + frame.content });
          else {
            const next = message(frame.content);
            streamId.current = next.id;
            s.addMessage(next);
          }
          break;
        }
        case "action_proposal":
          if (s.messages.some((m) => m.action?.id === frame.actionId)) break;
          streamId.current = null;
          s.addMessage({
            ...message(frame.description),
            action: {
              id: frame.actionId,
              description: frame.description,
              items: frame.items,
              decision: null,
              work: frame.work,
            },
          });
          break;
        case "action_decision":
        case "action_expired":
          for (const m of s.messages) {
            if (m.action && m.action.id === frame.actionId)
              s.updateMessage(m.id, {
                action: {
                  ...m.action,
                  decision: frame.approved === true,
                  expired: frame.type === "action_expired",
                },
              });
          }
          break;
        case "action_result":
          streamId.current = null;
          s.addMessage({ ...message(frame.summary), isError: !frame.success });
          break;
        case "error":
          streamId.current = null;
          s.addMessage({
            ...message(frame.message || "Optio couldn’t process that request."),
            isError: true,
          });
          break;
      }
    };
    ws.onclose = (event) => {
      if (!current()) return;
      ready.current = false;
      streamId.current = null;
      store().setStatus("disconnected");
      // Reattach only the viewer. Never replay a message, approval or clear request.
      if (![4401, 4403, 4404].includes(event?.code) && failures.current < 5) {
        retry = setTimeout(
          () => setAttempt((n) => n + 1),
          Math.min(1000 * 2 ** failures.current++, 15000),
        );
      }
    };
    ws.onerror = () => {
      if (current()) store().setStatus("disconnected");
    };
    return () => {
      clearTimeout(retry);
      socket.current = null;
      ready.current = false;
      ws.close();
    };
  }, [started, attempt, sessionId, store]);

  const sendFrame = useCallback((frame: Record<string, unknown>) => {
    if (!ready.current || socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(frame));
    return true;
  }, []);

  const send = useCallback(
    (text: string) => {
      const s = store();
      if (
        !text.trim() ||
        !["ready", "thinking"].includes(s.status) ||
        s.queuedMessages.length >= 20
      )
        return false;
      const requestId = crypto.randomUUID();
      if (!sendFrame({ type: "message", content: text.trim(), requestId })) return false;
      s.incrementExchange();
      return true;
    },
    [sendFrame, store],
  );

  const decide = useCallback(
    (id: string, approved: boolean, feedback?: string) => {
      const s = store();
      const proposal = s.messages.find((m) => m.action?.id === id && m.action.decision === null);
      if (!proposal || s.status !== "ready") return;
      if (!sendFrame({ type: approved ? "approve" : "deny", actionId: id, feedback })) return;
      s.updateMessage(proposal.id, { action: { ...proposal.action!, decision: approved } });
      if (!approved && feedback)
        s.addMessage({ ...message(feedback), role: "user", isDenialFeedback: true });
      streamId.current = null;
      s.setStatus("thinking");
    },
    [sendFrame, store],
  );

  const reset = useCallback(() => {
    if (
      store().status !== "ready" ||
      store().queuedMessages.length ||
      store().messages.some((m) => m.action?.decision === null)
    )
      return;
    if (!sendFrame({ type: "interrupt" })) return;
    streamId.current = null;
    store().setStatus("starting");
  }, [sendFrame, store]);

  const reconnect = useCallback(() => {
    // Disable local decisions until the server restores current approvals. Never replay them.
    for (const m of store().messages) {
      if (m.action?.decision === null)
        store().updateMessage(m.id, { action: { ...m.action, decision: false, expired: true } });
    }
    store().addMessage(
      message(
        "Reconnecting. Previous actions won’t be retried automatically. Check Work before repeating a request whose result is uncertain.",
      ),
    );
    failures.current = 0;
    setAttempt((n) => n + 1);
  }, [store]);

  return {
    send,
    decide,
    reset,
    reconnect,
    sessionHref,
    cancelQueued: (requestId: string) => sendFrame({ type: "cancel_queued", requestId }),
  };
}
