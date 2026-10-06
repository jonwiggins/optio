"use client";

import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { installTerminalLinks } from "@/lib/terminal-links";
import { installTerminalClipboard } from "@/lib/terminal-clipboard";
import { createTerminal } from "@/lib/xterm-setup";
import "@xterm/xterm/css/xterm.css";
import { getWsBaseUrl } from "@/lib/ws-client.js";

export function SessionTerminal({
  sessionId,
  terminal,
}: {
  sessionId: string;
  terminal?: "1" | "2";
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState("Connecting");

  useEffect(() => {
    if (!containerRef.current) return;

    const term = createTerminal({ fontSize: 13 });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    installTerminalLinks(term);
    const uninstallClipboard = installTerminalClipboard(term, containerRef.current);
    const container = containerRef.current;
    let opened = false;
    const fit = () => {
      if (disposed || !opened || !container.clientWidth || !container.clientHeight) return;
      fitAddon.fit();
    };
    // Cancel the first StrictMode mount before xterm schedules renderer work.
    const openFrame = requestAnimationFrame(() => {
      if (disposed) return;
      term.open(container);
      opened = true;
      fit();
    });

    let ws: WebSocket;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      setConnection("Reconnecting");
      ws = new WebSocket(
        `${getWsBaseUrl()}/ws/sessions/${sessionId}/terminal${terminal ? `?terminal=${terminal}` : ""}`,
      );
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        if (disposed) return;
        setConnection("Connected");
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      };
      ws.onmessage = (msg) => {
        if (disposed) return;
        if (typeof msg.data === "string") {
          try {
            const parsed = JSON.parse(msg.data);
            if (parsed.error) {
              setConnection(parsed.error);
              return;
            }
          } catch {
            /* Terminal output. */
          }
          term.write(msg.data);
        } else term.write(new Uint8Array(msg.data));
      };
      ws.onclose = (event) => {
        if (disposed) return;
        if (event.code === 4403 || event.code === 4401) {
          setConnection("Session access ended");
          return;
        }
        setConnection("Reconnecting to the session");
        retry = setTimeout(connect, 2000);
      };
    };
    connect();

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

    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(containerRef.current);

    return () => {
      disposed = true;
      cancelAnimationFrame(openFrame);
      clearTimeout(retry);
      uninstallClipboard();
      resizeObserver.disconnect();
      ws.close();
      term.dispose();
    };
  }, [sessionId, terminal]);

  return (
    <div className="h-full min-h-0 flex flex-col bg-[#09090b]">
      {connection !== "Connected" && (
        <div role="status" className="shrink-0 px-3 py-1 text-xs text-warning">
          {connection}
        </div>
      )}
      <div ref={containerRef} className="flex-1 min-h-0 px-2 py-1" />
    </div>
  );
}
