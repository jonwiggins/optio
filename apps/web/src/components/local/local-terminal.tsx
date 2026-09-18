"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getWsBaseUrl } from "@/lib/ws-client.js";
import { getWsTokenProvider } from "@/lib/ws-auth";
import { cn } from "@/lib/utils";
import { closeAction, isTerminalStateDead } from "./stream-policy";
import type { LocalAttentionState, LocalTerminalState } from "@optio/shared";

const ATTENTION_LABEL: Record<LocalAttentionState, string> = {
  working: "working",
  needs_you: "needs you",
  idle: "idle",
};

type ConnState = "connecting" | "connected" | "reconnecting" | "disconnected";

const CONN_LABEL: Record<ConnState, string> = {
  connecting: "connecting…",
  connected: "connected",
  reconnecting: "reconnecting…",
  disconnected: "disconnected",
};

const CONN_DOT: Record<ConnState, string> = {
  connecting: "bg-text-muted/40",
  connected: "bg-success",
  reconnecting: "bg-warning",
  disconnected: "bg-error",
};

const RECONNECT_DELAY_MS = 2000;

/**
 * xterm.js viewer for an Optio Local terminal (/ws/local/terminals/:id/stream).
 *
 * Protocol: server → client binary frames are raw terminal bytes (scrollback
 * replay first, then live); JSON text frames are {type:"status"|"exit"|"error"}.
 * Client → server is JSON only: {type:"input",data} | {type:"resize",cols,rows}.
 */
export function LocalTerminal({
  terminalId,
  onStatus,
  onExit,
}: {
  terminalId: string;
  onStatus?: (state: LocalTerminalState, attentionState: LocalAttentionState) => void;
  onExit?: (exitCode: number | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onStatusRef = useRef(onStatus);
  const onExitRef = useRef(onExit);
  onStatusRef.current = onStatus;
  onExitRef.current = onExit;

  const [status, setStatus] = useState<{
    state: LocalTerminalState;
    attentionState: LocalAttentionState;
  } | null>(null);
  const [connState, setConnState] = useState<ConnState>("connecting");

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      theme: {
        background: "#09090b",
        foreground: "#fafafa",
        selectionBackground: "#6d28d944",
        black: "#09090b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#f59e0b",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#fafafa",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    // fit() reads the renderer's dimensions; WebKit can hit this before the
    // renderer exists (first paint) and any engine after dispose(), so guard
    // it and retry on the next frame.
    const safeFit = () => {
      if (disposed) return;
      try {
        fitAddon.fit();
      } catch {
        // renderer not ready yet
      }
    };
    let disposed = false;
    const container = containerRef.current;
    const resizeObserver = new ResizeObserver(() => safeFit());
    // Open on the next frame, after React's commit has been laid out: WebKit
    // otherwise syncs xterm's viewport against a renderer that doesn't exist
    // yet ("this._renderer.value.dimensions" TypeError) on a 0-height box.
    const openFrame = requestAnimationFrame(() => {
      if (disposed) return;
      term.open(container);
      safeFit();
      resizeObserver.observe(container);
    });

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // The terminal has exited/errored — nothing more will ever stream, so a
    // reconnect could only wipe the history left on screen.
    let terminalDead = false;
    // Set when we close the socket ourselves to recover from a retryable
    // error frame (e.g. "Host is offline"), so onclose knows to reconnect.
    let retryRequested = false;
    // Reset lazily on the first binary frame of a reconnect (the scrollback
    // replay) — never before, so a reconnect that brings nothing back can't
    // blank the pane.
    let pendingReset = false;
    // Retryable errors ("Host is offline") repeat on every 2 s reconnect
    // while the daemon is down — print each distinct message once.
    let lastErrorShown: string | null = null;

    const connect = async () => {
      // Tokens go in the Sec-WebSocket-Protocol header (never the URL), same
      // as every other WS in the app. Provider is undefined in auth-disabled dev.
      let token: string | null = null;
      const provider = getWsTokenProvider();
      if (provider) token = await provider();
      if (disposed) return;

      const url = `${getWsBaseUrl()}/ws/local/terminals/${terminalId}/stream`;
      const protocols = token ? ["optio-ws-v1", `optio-auth-${token}`] : undefined;
      ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
      ws.binaryType = "arraybuffer";
      const socket = ws;
      // True once this connection's status frame reports a live terminal —
      // an error frame is only worth retrying when the terminal itself is
      // alive (e.g. "Host is offline"; the daemon will reconnect).
      let liveOnThisConnection = false;

      socket.onopen = () => {
        setConnState("connected");
        socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      };

      socket.onmessage = (msg) => {
        if (typeof msg.data === "string") {
          let parsed: any;
          try {
            parsed = JSON.parse(msg.data);
          } catch {
            return;
          }
          if (parsed.type === "status") {
            if (isTerminalStateDead(parsed.state)) terminalDead = true;
            else liveOnThisConnection = true;
            setStatus({ state: parsed.state, attentionState: parsed.attentionState });
            onStatusRef.current?.(parsed.state, parsed.attentionState);
          } else if (parsed.type === "exit") {
            terminalDead = true;
            term.writeln(
              `\r\n\x1b[2m[process exited${parsed.exitCode != null ? ` (code ${parsed.exitCode})` : ""}]\x1b[0m`,
            );
            onExitRef.current?.(parsed.exitCode ?? null);
          } else if (parsed.type === "error") {
            if (parsed.message !== lastErrorShown) {
              lastErrorShown = parsed.message;
              term.writeln(`\r\n\x1b[31m${parsed.message}\x1b[0m`);
            }
            // An error on a live terminal (e.g. "Host is offline") leaves the
            // socket open but attached to nothing — it would never receive
            // another frame. Close it so the reconnect loop retries until the
            // daemon is back.
            if (liveOnThisConnection && !terminalDead) {
              retryRequested = true;
              socket.close();
            }
          }
        } else {
          if (pendingReset) {
            pendingReset = false;
            term.reset();
          }
          lastErrorShown = null;
          term.write(new Uint8Array(msg.data));
        }
      };

      socket.onclose = (event) => {
        if (disposed) return;
        const action = closeAction({ code: event.code, terminalDead, retryRequested });
        retryRequested = false;
        if (action.kind === "stop") {
          setConnState("disconnected");
          if (action.message) term.writeln(`\r\n\x1b[31m${action.message}\x1b[0m`);
          return;
        }
        setConnState("reconnecting");
        pendingReset = true;
        reconnectTimer = setTimeout(() => {
          if (disposed) return;
          connect();
        }, RECONNECT_DELAY_MS);
      };

      socket.onerror = () => {
        socket.close();
      };
    };

    setConnState("connecting");
    connect();

    term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    term.onResize(({ cols, rows }) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(openFrame);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      resizeObserver.disconnect();
      ws?.close();
      term.dispose();
    };
  }, [terminalId]);

  return (
    <div className="h-full flex flex-col bg-[#09090b]">
      <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-b border-border/50 text-[11px] text-text-muted">
        <span className="flex items-center gap-1.5">
          <span className={cn("w-1.5 h-1.5 rounded-full", CONN_DOT[connState])} />
          {CONN_LABEL[connState]}
        </span>
        {status && (
          <>
            <span className="uppercase tracking-wide">{status.state}</span>
            <span
              className={cn(
                "uppercase tracking-wide",
                status.attentionState === "needs_you" && "text-warning",
                status.attentionState === "working" && "text-primary",
              )}
            >
              {ATTENTION_LABEL[status.attentionState] ?? status.attentionState}
            </span>
          </>
        )}
      </div>
      <div ref={containerRef} className="flex-1 min-h-0" />
      <div className="shrink-0 h-[env(safe-area-inset-bottom)]" aria-hidden />
    </div>
  );
}
