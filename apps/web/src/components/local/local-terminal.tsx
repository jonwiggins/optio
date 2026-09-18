"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Maximize2 } from "lucide-react";
import {
  BASE_FONT_PX,
  onGridAnnounced,
  passiveFontPx,
  sameGrid,
  type Grid,
  type SizingMode,
} from "./sizing";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getWsBaseUrl } from "@/lib/ws-client.js";
import { getWsTokenProvider } from "@/lib/ws-auth";
import { cn } from "@/lib/utils";
import { closeAction, isTerminalStateDead } from "./stream-policy";
import {
  CONN_DOT,
  CONN_LABEL,
  SHIFT_ENTER_SEQUENCE,
  isShiftEnter,
  type ConnState,
} from "./conn-state";
import type { LocalAttentionState, LocalTerminalState } from "@optio/shared";

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
  onConn,
}: {
  terminalId: string;
  onStatus?: (state: LocalTerminalState, attentionState: LocalAttentionState) => void;
  onExit?: (exitCode: number | null) => void;
  /** Stream connection state, for chrome that wants to show it. */
  onConn?: (conn: ConnState) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onStatusRef = useRef(onStatus);
  const onExitRef = useRef(onExit);
  const onConnRef = useRef(onConn);
  onStatusRef.current = onStatus;
  onExitRef.current = onExit;
  onConnRef.current = onConn;

  const [connState, setConnStateRaw] = useState<ConnState>("connecting");
  // Set while another viewer owns the PTY grid and we're rendering it
  // scaled to fit. Drives the "sized for another device" strip.
  const [foreignGrid, setForeignGrid] = useState<Grid | null>(null);
  const claimRef = useRef<() => void>(() => {});
  const setConnState = (next: ConnState) => {
    setConnStateRaw(next);
    onConnRef.current?.(next);
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: BASE_FONT_PX,
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

    // Shift+Enter → newline in agent REPLs (see SHIFT_ENTER_SEQUENCE). Only
    // the bare Shift chord: Ctrl/⌘+Shift+Enter belongs to the rail.
    term.attachCustomKeyEventHandler((e) => {
      if (!isShiftEnter(e)) return true;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data: SHIFT_ENTER_SEQUENCE }));
      }
      return false;
    });
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

    // ── Who owns the PTY grid ────────────────────────────────────────────
    // One PTY, one grid. Attaching never resizes it; interacting (pointer
    // down in the terminal, typing) claims it for this screen. A viewer that
    // hasn't claimed it renders the announced grid shrunk to fit its width,
    // so a phone glancing at a laptop session sees the laptop's layout
    // small rather than forcing the laptop down to phone width.
    let mode: SizingMode = { kind: "unclaimed" };
    let lastSent: Grid | null = null;

    const sendResize = (grid: Grid) => {
      lastSent = grid;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: grid.cols, rows: grid.rows }));
      }
    };

    /** Renderer-measured cell width per px of font size (≈0.6 for monospace). */
    const cellWidthPerFontPx = () => {
      try {
        const w = (term as any)._core?._renderService?.dimensions?.css?.cell?.width;
        if (w > 0) return w / term.options.fontSize!;
      } catch {
        // renderer not ready
      }
      return 0.6;
    };

    /** What a fit to our own screen would produce at the base font. */
    const naturalGrid = (): Grid => {
      const prev = term.options.fontSize;
      if (prev !== BASE_FONT_PX) term.options.fontSize = BASE_FONT_PX;
      const d = fitAddon.proposeDimensions();
      if (prev !== BASE_FONT_PX) term.options.fontSize = prev;
      return d ? { cols: d.cols, rows: d.rows } : { cols: term.cols, rows: term.rows };
    };

    const renderPassive = (grid: Grid) => {
      if (disposed) return;
      // 24px = the .local-xterm horizontal padding (12 + 12).
      const width = container.clientWidth - 24;
      term.options.fontSize = passiveFontPx(width, grid.cols, cellWidthPerFontPx());
      try {
        term.resize(grid.cols, grid.rows);
      } catch {
        // renderer not ready yet
      }
    };

    const applyMode = () => {
      if (mode.kind === "passive") {
        renderPassive(mode.grid);
        setForeignGrid(mode.grid);
      } else {
        if (term.options.fontSize !== BASE_FONT_PX) term.options.fontSize = BASE_FONT_PX;
        safeFit();
        setForeignGrid(null);
      }
    };

    /** This screen is being used: size the PTY to it. */
    const claim = () => {
      if (disposed) return;
      mode = { kind: "owner" };
      applyMode();
      // fit() only fires onResize when the grid actually changes, so make
      // sure the daemon hears our size even when it's already what we have.
      const grid = { cols: term.cols, rows: term.rows };
      if (!sameGrid(grid, lastSent)) sendResize(grid);
    };
    claimRef.current = claim;

    const onGrid = (grid: Grid) => {
      mode = onGridAnnounced(mode, grid, naturalGrid(), lastSent);
      applyMode();
    };

    const resizeObserver = new ResizeObserver(() => applyMode());
    container.addEventListener("pointerdown", claim);
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
        // Attaching never resizes the PTY. If we already own it (reconnect
        // after a blip), re-assert our grid; otherwise wait for `size`.
        if (mode.kind === "owner") sendResize({ cols: term.cols, rows: term.rows });
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
            onStatusRef.current?.(parsed.state, parsed.attentionState);
          } else if (parsed.type === "size") {
            if (Number.isInteger(parsed.cols) && Number.isInteger(parsed.rows)) {
              onGrid({ cols: parsed.cols, rows: parsed.rows });
            }
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
      // Typing here means this is the screen in use — take the grid first so
      // the program lays out for it before it processes the keystroke.
      if (mode.kind !== "owner") claim();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    term.onResize(({ cols, rows }) => {
      // Passive renders call term.resize() too; only the owner tells the PTY.
      if (mode.kind === "owner") sendResize({ cols, rows });
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(openFrame);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      resizeObserver.disconnect();
      container.removeEventListener("pointerdown", claim);
      ws?.close();
      term.dispose();
    };
  }, [terminalId]);

  return (
    <div className="h-full flex flex-col bg-[#09090b]">
      {/* Only speak up when the stream isn't healthy — the header carries the
          state/attention badges, so a "connected · running" strip is noise. */}
      {connState !== "connected" && (
        <div
          className={cn(
            "shrink-0 flex items-center gap-2 px-3 py-1 text-[11px]",
            connState === "disconnected" ? "bg-error/10 text-error" : "bg-warning/10 text-warning",
          )}
        >
          <span className={cn("w-1.5 h-1.5 rounded-full", CONN_DOT[connState])} />
          {CONN_LABEL[connState]}
        </div>
      )}
      {foreignGrid && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1 text-[11px] bg-primary/10 text-text-muted">
          <span className="w-1.5 h-1.5 rounded-full bg-primary" />
          <span className="min-w-0 truncate">
            Sized for another device
            <span className="font-mono ml-1 opacity-70">
              {foreignGrid.cols}×{foreignGrid.rows}
            </span>
          </span>
          <button
            type="button"
            onClick={() => claimRef.current()}
            className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-text hover:bg-bg-hover/70 transition-colors"
            title="Resize the session to this screen"
          >
            <Maximize2 className="w-3 h-3" />
            Use this screen
          </button>
        </div>
      )}
      {/* No padding here: FitAddon sizes the grid from this box's border-box
          height and only subtracts padding set on `.xterm` itself (see
          .local-xterm in globals.css). Padding on the parent oversizes the
          grid and the bottom rows flicker/clip. */}
      <div
        ref={containerRef}
        className={cn("local-xterm flex-1 min-h-0", foreignGrid && "overflow-auto")}
      />
      <div className="shrink-0 h-[env(safe-area-inset-bottom)]" aria-hidden />
    </div>
  );
}
