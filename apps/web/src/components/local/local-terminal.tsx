"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getWsBaseUrl } from "@/lib/ws-client.js";
import { getWsTokenProvider } from "@/lib/ws-auth";
import { cn } from "@/lib/utils";
import type { LocalAttentionState, LocalTerminalState } from "@optio/shared";

const ATTENTION_LABEL: Record<LocalAttentionState, string> = {
  working: "working",
  needs_you: "needs you",
  idle: "idle",
};

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
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      theme: {
        background: "#09090b",
        foreground: "#fafafa",
        cursor: "#6d28d9",
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
    term.open(containerRef.current);
    fitAddon.fit();

    let ws: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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

      socket.onopen = () => {
        setConnected(true);
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
            setStatus({ state: parsed.state, attentionState: parsed.attentionState });
            onStatusRef.current?.(parsed.state, parsed.attentionState);
          } else if (parsed.type === "exit") {
            term.writeln(
              `\r\n\x1b[2m[process exited${parsed.exitCode != null ? ` (code ${parsed.exitCode})` : ""}]\x1b[0m`,
            );
            onExitRef.current?.(parsed.exitCode ?? null);
          } else if (parsed.type === "error") {
            term.writeln(`\r\n\x1b[31m${parsed.message}\x1b[0m`);
          }
        } else {
          term.write(new Uint8Array(msg.data));
        }
      };

      socket.onclose = () => {
        setConnected(false);
        if (disposed) return;
        // The server replays scrollback on reattach — reset so history isn't
        // duplicated after the reconnect.
        reconnectTimer = setTimeout(() => {
          if (disposed) return;
          term.reset();
          connect();
        }, 2000);
      };

      socket.onerror = () => {
        socket.close();
      };
    };

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

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      disposed = true;
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
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full",
              connected ? "bg-success" : "bg-text-muted/40",
            )}
          />
          {connected ? "connected" : "reconnecting…"}
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
    </div>
  );
}
