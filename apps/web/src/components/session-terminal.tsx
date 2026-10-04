"use client";

import { useEffect, useRef } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { installTerminalLinks } from "@/lib/terminal-links";
import { installTerminalClipboard } from "@/lib/terminal-clipboard";
import { createTerminal } from "@/lib/xterm-setup";
import "@xterm/xterm/css/xterm.css";
import { getWsBaseUrl } from "@/lib/ws-client.js";

export function SessionTerminal({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = createTerminal({ fontSize: 13 });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    installTerminalLinks(term);
    const uninstallClipboard = installTerminalClipboard(term, containerRef.current);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;

    // WebSocket connection to session terminal
    const ws = new WebSocket(`${getWsBaseUrl()}/ws/sessions/${sessionId}/terminal`);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      term.writeln("\x1b[32mConnected to session terminal\x1b[0m\r\n");
      // Send initial resize
      const { cols, rows } = term;
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
    };

    ws.onmessage = (msg) => {
      if (typeof msg.data === "string") {
        // Check if it's a JSON error message
        try {
          const parsed = JSON.parse(msg.data);
          if (parsed.error) {
            term.writeln(`\x1b[31mError: ${parsed.error}\x1b[0m`);
            return;
          }
        } catch {
          // Not JSON, write as terminal data
        }
        term.write(msg.data);
      } else {
        term.write(new Uint8Array(msg.data));
      }
    };

    ws.onclose = () => {
      term.writeln("\r\n\x1b[31mDisconnected from session terminal\x1b[0m");
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
      uninstallClipboard();
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="h-full bg-[#09090b]">
      <div ref={containerRef} className="h-full" />
    </div>
  );
}
