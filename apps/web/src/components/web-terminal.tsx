"use client";

import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getWsBaseUrl } from "@/lib/ws-client.js";

export function WebTerminal({ taskId }: { taskId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

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
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;

    // WebSocket connection
    const ws = new WebSocket(`${getWsBaseUrl()}/ws/terminal/${taskId}`);

    ws.onopen = () => {
      term.writeln("\x1b[32mConnected to agent terminal\x1b[0m\r\n");
    };

    ws.onmessage = (msg) => {
      term.write(typeof msg.data === "string" ? msg.data : new Uint8Array(msg.data));
    };

    ws.onclose = () => {
      term.writeln("\r\n\x1b[31mDisconnected from agent terminal\x1b[0m");
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    };
  }, [taskId]);

  return (
    <div className="h-full border border-border rounded-lg overflow-hidden bg-bg">
      <div className="px-3 py-2 border-b border-border bg-bg-card text-xs text-text-muted">
        Interactive Terminal
      </div>
      <div ref={containerRef} className="h-[calc(100%-33px)]" />
    </div>
  );
}
