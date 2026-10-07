"use client";

import { useEffect, useRef, useState } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { installTerminalLinks } from "@/lib/terminal-links";
import { installTerminalClipboard } from "@/lib/terminal-clipboard";
import { createTerminal, silenceQueryReplies } from "@/lib/xterm-setup";
import { Maximize2 } from "lucide-react";
import {
  BASE_FONT_PX,
  VIEW_REFRESH_MS,
  ackSentGrid,
  onGridAnnounced,
  onGridAssigned,
  passiveFontPx,
  pushSentGrid,
  sameGrid,
  type Grid,
  type SizingMode,
} from "./sizing";
import "@xterm/xterm/css/xterm.css";
import { getWsBaseUrl } from "@/lib/ws-client.js";
import { getWsTokenProvider } from "@/lib/ws-auth";
import { cn } from "@/lib/utils";
import { closeAction, isPointerReport, isQueryReply, isTerminalStateDead } from "./stream-policy";
import {
  CONN_DOT,
  CONN_LABEL,
  SHIFT_ENTER_SEQUENCE,
  isShiftEnter,
  type ConnState,
} from "./conn-state";
import {
  LOCAL_VIEW_IN_USE_MS,
  type LocalAttentionState,
  type LocalTerminalState,
} from "@optio/shared";

const RECONNECT_DELAY_MS = 2000;
/** How long a connection's replay waits for the daemon's closing `size` (iOS / Android: 1.5 s). */
const REPLAY_CLOSE_MS = 1500;

/**
 * xterm.js viewer for an Optio Local terminal (/ws/local/terminals/:id/stream).
 *
 * Protocol: server → client binary frames are raw terminal bytes (the
 * terminal as it stands first — announced by a `replay` frame naming the grid
 * it was drawn for — then live); JSON text frames are
 * {type:"status"|"replay"|"size"|"exit"|"error"}.
 * Client → server is JSON only: {type:"input",data} | {type:"resize",cols,rows}
 * | {type:"view",cols,rows,visible,idleMs,open?}.
 */
export function LocalTerminal({
  terminalId,
  onStatus,
  onExit,
  onConn,
  onOutput,
  connectionStatus = "inline",
}: {
  terminalId: string;
  onStatus?: (state: LocalTerminalState, attentionState: LocalAttentionState) => void;
  onExit?: (exitCode: number | null) => void;
  /** Stream connection state, for chrome that wants to show it. */
  onConn?: (conn: ConnState, message?: string | null) => void;
  /** The session workspace has one recovery notice above the viewer. */
  connectionStatus?: "inline" | "external";
  /** Fired once, on the first terminal bytes — the screen holds real output. */
  onOutput?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onStatusRef = useRef(onStatus);
  const onExitRef = useRef(onExit);
  const onConnRef = useRef(onConn);
  const onOutputRef = useRef(onOutput);
  const connectionStatusRef = useRef(connectionStatus);
  onStatusRef.current = onStatus;
  onExitRef.current = onExit;
  onConnRef.current = onConn;
  onOutputRef.current = onOutput;
  connectionStatusRef.current = connectionStatus;

  const [connState, setConnStateRaw] = useState<ConnState>("connecting");
  // Set while another viewer owns the PTY grid and we're rendering it
  // scaled to fit. Drives the "sized for another device" strip.
  const [foreignGrid, setForeignGrid] = useState<Grid | null>(null);
  // The terminal has exited: `foreignGrid` is then the grid its final screen
  // was recorded at, pinned so it reads the way it ran (no "use this screen").
  const [recorded, setRecorded] = useState(false);
  const claimRef = useRef<() => void>(() => {});
  const stripRef = useRef<HTMLDivElement>(null);
  const setConnState = (next: ConnState, message?: string | null) => {
    setConnStateRaw(next);
    onConnRef.current?.(next, message);
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const term = createTerminal({ fontSize: BASE_FONT_PX });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    installTerminalLinks(term);
    // The machine answers the program's queries itself (the connection's
    // status frame says so): this viewer stays quiet, so a program gets one
    // answer however many screens watch. An older daemon doesn't, and this
    // viewer answers live queries as before.
    let machineAnswers = false;
    const unsilence = silenceQueryReplies(term, () => machineAnswers);

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
    // The terminal has exited/errored — nothing more will ever stream, so a
    // reconnect could only wipe the history left on screen. Declared up here
    // because the sizing closures consult it.
    let terminalDead = false;

    // ── Which screen the PTY is sized for ────────────────────────────────
    // One PTY, one grid, and the server gives it to the screen in use
    // (apps/api/src/services/local-grid.ts). This pane reports the grid that
    // fits it, whether it's on screen, and how long since it was touched
    // (`view`). Opening it, bringing its tab to the front, or coming back to
    // it after a minute away asks for the grid (`open`) — granted unless
    // another screen showing the session was used in the last minute, so a
    // phone glancing at a laptop you're working at sees the laptop's layout
    // small rather than forcing it down to phone width. A click or keystroke
    // here, or "Use this screen", takes the grid outright (`resize`). `size`
    // frames say whether the grid is ours; a server that doesn't say leaves
    // us inferring it from the echoes of our own resizes.
    let mode: SizingMode = { kind: "unclaimed" };
    // Grids we've asked for and not yet heard echoed, oldest first (servers
    // that don't say whose the grid is).
    let sent: Grid[] = [];
    // The server says whose the grid is.
    let arbitrated = false;
    // When this pane was last touched; opening it counts.
    let lastUsed = Date.now();
    // The last `view` sent on this connection.
    let lastView: { grid: Grid; at: number } | null = null;
    // A `view` held until the pane can be measured; true when it asks for the grid.
    let heldOpen: boolean | null = null;
    let opened = false;
    let everConnected = false;

    const sendResize = (grid: Grid) => {
      sent = pushSentGrid(sent, grid);
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

    /**
     * What a fit to our own screen would produce at the base font — laid out
     * the way it will be once the grid is ours, without the "sized for
     * another device" strip. Measured with the strip, a screen would ask for
     * a row less than it ends up with (a second resize once the strip goes)
     * and would never recognise its own size in another screen's grid.
     */
    const naturalGrid = (): Grid => {
      const prev = term.options.fontSize;
      if (prev !== BASE_FONT_PX) term.options.fontSize = BASE_FONT_PX;
      try {
        const d = fitAddon.proposeDimensions();
        if (!d) return { cols: term.cols, rows: term.rows };
        const strip = stripRef.current?.getBoundingClientRect().height ?? 0;
        const cellHeight = (term as any)._core?._renderService?.dimensions?.css?.cell?.height;
        if (strip > 0 && cellHeight > 0 && term.element) {
          // FitAddon's arithmetic (the parent's height less .xterm's own
          // padding), with the strip's height given back.
          const style = getComputedStyle(term.element);
          const padding = parseInt(style.paddingTop) + parseInt(style.paddingBottom);
          // Keep fractional layout pixels until the full height is restored.
          // Rounding a 28.5px strip up to 29 can add a phantom terminal row.
          const height =
            Math.floor(parseFloat(getComputedStyle(container).height) + strip) - padding;
          return { cols: d.cols, rows: Math.max(1, Math.floor(height / cellHeight)) };
        }
        return { cols: d.cols, rows: d.rows };
      } finally {
        if (prev !== BASE_FONT_PX) term.options.fontSize = prev;
      }
    };

    /** Our natural grid, or null while the pane can't be measured (not laid out, no size). */
    const measure = (): Grid | null =>
      opened && container.clientWidth >= 40 && container.clientHeight >= 20 ? naturalGrid() : null;

    const onScreen = () => document.visibilityState === "visible";

    /** Tell the server how this pane sees the terminal; `open` asks for the grid. */
    const sendView = (open: boolean) => {
      if (disposed || terminalDead || ws?.readyState !== WebSocket.OPEN) return;
      const grid = measure();
      if (!grid) {
        heldOpen = (heldOpen ?? false) || open;
        return;
      }
      heldOpen = null;
      const visible = onScreen();
      const now = Date.now();
      ws.send(
        JSON.stringify({
          type: "view",
          cols: grid.cols,
          rows: grid.rows,
          visible,
          idleMs: Math.max(0, now - lastUsed),
          ...(open && visible ? { open: true } : {}),
        }),
      );
      lastView = { grid, at: now };
    };

    /** Our grid may have changed (a window resize, the strip coming or going): say so. */
    const reportGrid = () => {
      if (heldOpen !== null) {
        sendView(heldOpen);
        return;
      }
      const grid = lastView && measure();
      if (grid && !sameGrid(grid, lastView!.grid)) sendView(false);
    };

    /** The user touched this pane. */
    const touched = () => {
      const now = Date.now();
      const back = now - lastUsed >= LOCAL_VIEW_IN_USE_MS;
      lastUsed = now;
      // Back after a minute away: ask for the grid. Otherwise keep the
      // server's "last used" clock fresh.
      if (back) sendView(true);
      else if (lastView && now - lastView.at >= VIEW_REFRESH_MS) sendView(false);
    };

    const onVisibility = () => {
      // Bringing this tab to the front is using it.
      if (onScreen()) lastUsed = Date.now();
      sendView(onScreen());
    };

    const renderPassive = (grid: Grid) => {
      if (disposed) return;
      const width = container.clientWidth;
      term.options.fontSize = passiveFontPx(width, grid.cols, cellWidthPerFontPx());
      try {
        term.resize(grid.cols, grid.rows);
      } catch {
        // renderer not ready yet
      }
    };

    // Set while the grid is changed for a replay: that's not this screen's
    // size, so it must not be reported as one.
    let sizingReplay = false;
    const layoutReplay = (grid: Grid) => {
      if (disposed || (term.cols === grid.cols && term.rows === grid.rows)) return;
      sizingReplay = true;
      try {
        term.resize(grid.cols, grid.rows);
      } catch {
        // renderer not ready yet
      } finally {
        sizingReplay = false;
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
      // Nothing left to size once the process is gone — and a click to
      // select text must not reflow a replayed screen out of its recorded
      // grid.
      if (terminalDead) return;
      lastUsed = Date.now();
      mode = { kind: "owner" };
      applyMode();
      // Always tell the daemon, even if our grid is what we last sent:
      // another viewer may have resized the PTY in between (a click is one
      // cheap frame, and typing only lands here when we were demoted). Our
      // natural grid, not the fit just made: the strip is still on screen
      // until React's next render.
      const grid = measure() ?? { cols: term.cols, rows: term.rows };
      sendResize(grid);
      lastView = { grid, at: Date.now() };
    };
    claimRef.current = claim;

    const onGrid = (grid: Grid, yours: boolean | undefined) => {
      if (yours === undefined || terminalDead) {
        // No say from the server (or an exited terminal's recorded grid).
        mode = onGridAnnounced(mode, grid, naturalGrid(), sent, terminalDead);
        sent = ackSentGrid(sent, grid) ?? sent;
      } else {
        arbitrated = true;
        sent = [];
        mode = onGridAssigned(grid, yours, measure());
      }
      if (terminalDead) setRecorded(true);
      applyMode();
    };

    const resizeObserver = new ResizeObserver(() => {
      // A replay laid out at its own grid can overflow the pane until it is
      // parsed; fitting now would parse it at this screen's width after all.
      if (holdingReplay()) return;
      applyMode();
      reportGrid();
    });
    container.addEventListener("pointerdown", claim);
    // Moving over, scrolling, or touching the terminal is using this screen.
    const activity = ["pointermove", "wheel", "touchstart"] as const;
    for (const type of activity) container.addEventListener(type, touched, { passive: true });
    const uninstallTouchScroll = installTouchWheel(term, container);
    document.addEventListener("visibilitychange", onVisibility);
    // Open on the next frame, after React's commit has been laid out: WebKit
    // otherwise syncs xterm's viewport against a renderer that doesn't exist
    // yet ("this._renderer.value.dimensions" TypeError) on a 0-height box.
    const openFrame = requestAnimationFrame(() => {
      if (disposed) return;
      term.open(container);
      loadWebglRenderer(term);
      safeFit();
      opened = true;
      resizeObserver.observe(container);
      reportGrid();
    });

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
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
    let streamError: string | null = null;
    let outputSeen = false;
    // Each connection opens with the scrollback replay. Until xterm has
    // parsed it, its answers to the queries in it (a cursor position, its
    // identity) go nowhere: the program asked long ago, and a stray answer
    // would land in its input. The daemon closes the replay with a `size`.
    let replaying = false;
    let replayWrites = 0;
    let replayClosed = false;
    let replayTimer: ReturnType<typeof setTimeout> | null = null;
    // The daemon named the grid its snapshot was drawn for (`replay`). xterm
    // parses writes asynchronously, so a `size` right behind the snapshot
    // would resize the terminal before the snapshot is parsed and lay it out
    // at this screen's width instead; it waits for the parse instead.
    let replayLaidOut = false;
    let deferredGrid: { grid: Grid; yours: boolean | undefined } | null = null;
    const closeReplay = () => {
      if (replayTimer) clearTimeout(replayTimer);
      replayTimer = null;
      replayClosed = true;
      if (replayWrites === 0) replaying = false;
    };
    /** A replay laid out at its own grid is still being parsed. */
    const holdingReplay = () => replayLaidOut && replayWrites > 0;
    /** The replay is parsed: apply the grid that arrived meanwhile. */
    const replayParsed = () => {
      if (replayClosed) replaying = false;
      const pending = deferredGrid;
      deferredGrid = null;
      if (pending) onGrid(pending.grid, pending.yours);
    };
    // ⌥-drag selects over a program that tracks the mouse, and what the
    // program copies (OSC 52: Claude Code's copy-on-select) reaches this
    // browser's clipboard — never from the replay, which would re-copy
    // something from long ago.
    const uninstallClipboard = installTerminalClipboard(term, container, {
      replaying: () => replaying,
    });

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
        streamError = null;
        machineAnswers = false;
        replaying = true;
        replayWrites = 0;
        replayClosed = false;
        replayLaidOut = false;
        deferredGrid = null;
        if (replayTimer) clearTimeout(replayTimer);
        // A daemon that never says the size: don't hold answers back for good.
        replayTimer = setTimeout(closeReplay, REPLAY_CLOSE_MS);
        lastView = null;
        heldOpen = null;
        const first = !everConnected;
        everConnected = true;
        const wasOurs = mode.kind === "owner";
        // Opening the pane asks for the grid. A reconnect asks only when the
        // grid was ours or we're in use: a blip must not hand it to
        // whichever screen happens to reconnect first.
        sendView(first || wasOurs || Date.now() - lastUsed < LOCAL_VIEW_IN_USE_MS);
        // A server that doesn't say whose the grid is never sizes it for
        // us: re-assert ours after a blip.
        if (!arbitrated && wasOurs) sendResize({ cols: term.cols, rows: term.rows });
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
            // Said on the connection's first status; later ones leave it out.
            if (parsed.answersQueries === true) machineAnswers = true;
            if (isTerminalStateDead(parsed.state)) terminalDead = true;
            else liveOnThisConnection = true;
            onStatusRef.current?.(parsed.state, parsed.attentionState);
          } else if (parsed.type === "replay") {
            // The snapshot that follows was drawn for this grid: lay it out at
            // that size, then let the `size` frames size it for this screen.
            if (Number.isInteger(parsed.cols) && Number.isInteger(parsed.rows)) {
              layoutReplay({ cols: parsed.cols, rows: parsed.rows });
              replayLaidOut = true;
            }
          } else if (parsed.type === "size") {
            if (!replayClosed) closeReplay();
            if (Number.isInteger(parsed.cols) && Number.isInteger(parsed.rows)) {
              const grid = { cols: parsed.cols, rows: parsed.rows };
              const yours = typeof parsed.yours === "boolean" ? parsed.yours : undefined;
              if (holdingReplay()) deferredGrid = { grid, yours };
              else onGrid(grid, yours);
            }
          } else if (parsed.type === "exit") {
            terminalDead = true;
            term.writeln(
              `\r\n\x1b[2m[process exited${parsed.exitCode != null ? ` (code ${parsed.exitCode})` : ""}]\x1b[0m`,
            );
            onExitRef.current?.(parsed.exitCode ?? null);
          } else if (parsed.type === "error") {
            streamError = parsed.message;
            if (parsed.message !== lastErrorShown) {
              lastErrorShown = parsed.message;
              if (connectionStatusRef.current === "inline")
                term.writeln(`\r\n\x1b[31m${parsed.message}\x1b[0m`);
            }
            // An error on a live terminal (e.g. "Host is offline") leaves the
            // socket open but attached to nothing — it would never receive
            // another frame. Close it so the reconnect loop retries until the
            // daemon is back.
            if (liveOnThisConnection && !terminalDead) {
              retryRequested = true;
              socket.close();
            } else {
              setConnState("disconnected", streamError);
            }
          }
        } else {
          if (pendingReset) {
            pendingReset = false;
            term.reset();
          }
          lastErrorShown = null;
          if (!outputSeen) {
            outputSeen = true;
            onOutputRef.current?.();
          }
          if (replaying && !replayClosed) {
            replayWrites++;
            term.write(new Uint8Array(msg.data), () => {
              if (--replayWrites === 0) replayParsed();
            });
          } else {
            term.write(new Uint8Array(msg.data));
          }
        }
      };

      socket.onclose = (event) => {
        if (disposed) return;
        const action = closeAction({ code: event.code, terminalDead, retryRequested });
        retryRequested = false;
        if (action.kind === "stop") {
          setConnState("disconnected", action.message ?? streamError);
          if (action.message && connectionStatusRef.current === "inline")
            term.writeln(`\r\n\x1b[31m${action.message}\x1b[0m`);
          return;
        }
        setConnState("reconnecting", streamError);
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
      if (isQueryReply(data)) {
        // xterm answering a program's query, not someone typing. An answer
        // to a query from the replay (or a finished process) goes nowhere.
        if (replaying || terminalDead) return;
      } else if (!isPointerReport(data)) {
        // Typing here means this is the screen in use — take the grid first
        // so the program lays out for it before it processes the keystroke.
        // (Clicks and pointer moves are counted by the pane's own listeners.)
        if (mode.kind !== "owner") claim();
        else touched();
      }
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    term.onResize(({ cols, rows }) => {
      // Passive renders call term.resize() too; only the owner tells the PTY.
      // (With a server that says whose the grid is, `view` carries it.)
      if (sizingReplay) return;
      if (!arbitrated && mode.kind === "owner") sendResize({ cols, rows });
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(openFrame);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (replayTimer) clearTimeout(replayTimer);
      resizeObserver.disconnect();
      container.removeEventListener("pointerdown", claim);
      for (const type of activity) container.removeEventListener(type, touched);
      uninstallTouchScroll();
      uninstallClipboard();
      unsilence();
      document.removeEventListener("visibilitychange", onVisibility);
      ws?.close();
      term.dispose();
    };
  }, [terminalId]);

  return (
    <div className="h-full flex flex-col bg-[#09090b]">
      {/* Only speak up when the stream isn't healthy — the header carries the
          state/attention badges, so a "connected · running" strip is noise. */}
      {connectionStatus === "inline" && connState !== "connected" && (
        <div
          className={cn(
            "shrink-0 flex items-center gap-2 px-3 py-1 text-[11px]",
            "bg-warning/10 text-warning",
          )}
        >
          <span className={cn("w-1.5 h-1.5 rounded-full", CONN_DOT[connState])} />
          {CONN_LABEL[connState]}
        </div>
      )}
      {foreignGrid && (
        <div
          ref={stripRef}
          className="shrink-0 flex items-center gap-2 px-3 py-1 text-[11px] bg-primary/10 text-text-muted"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-primary" />
          <span className="min-w-0 truncate">
            {recorded ? "Recorded screen" : "Sized for another device"}
            <span className="font-mono ml-1 opacity-70">
              {foreignGrid.cols}×{foreignGrid.rows}
            </span>
          </span>
          {!recorded && (
            <button
              type="button"
              onClick={() => claimRef.current()}
              className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-text hover:bg-bg-hover/70 transition-colors"
              title="Resize the session to this screen"
            >
              <Maximize2 className="w-3 h-3" />
              Use this screen
            </button>
          )}
        </div>
      )}
      {/* Keep the terminal flush with its pane. FitAddon reads this box's
          full size; parent padding would also clip the bottom rows. */}
      <div
        ref={containerRef}
        className={cn("local-xterm flex-1 min-h-0", foreignGrid && "overflow-auto")}
      />
      <div className="shrink-0 h-[env(safe-area-inset-bottom)]" aria-hidden />
    </div>
  );
}

/**
 * Draw with WebGL where the browser has it. xterm's default DOM renderer
 * draws box-drawing characters with the font and each row's background as its
 * own box: a rule like Codex's `────` shows a tick at every glyph join, and a
 * tinted band (Codex's composer) shows seams between its rows at fractional
 * zoom. WebGL draws those glyphs itself and paints backgrounds in device
 * pixels. The DOM renderer stays when WebGL2 isn't there, takes over again if
 * the context is lost, and is what `NEXT_PUBLIC_OPTIO_TERMINAL_RENDERER=dom`
 * (or `localStorage["optio.terminal.renderer"] = "dom"`) asks for.
 */
function loadWebglRenderer(term: XTerm): void {
  let choice = process.env.NEXT_PUBLIC_OPTIO_TERMINAL_RENDERER;
  try {
    choice = window.localStorage.getItem("optio.terminal.renderer") ?? choice;
  } catch {
    // storage blocked
  }
  if (choice === "dom") return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // No WebGL2 here: the DOM renderer draws instead.
  }
}

/**
 * A finger drag over a program that tracks the mouse (Claude Code's
 * fullscreen UI, less, vim): xterm.js leaves touches alone then, so on a
 * phone or tablet the drag scrolled nothing at all. Turn it into the wheel
 * the program listens for — xterm encodes each one as the program asked
 * (SGR reports, say). Without mouse tracking xterm scrolls on its own.
 */
export function installTouchWheel(term: XTerm, container: HTMLElement): () => void {
  let lastY: number | null = null;
  let lastX = 0;
  let pending = 0;
  const cellHeight = () => {
    const h = (term as any)._core?._renderService?.dimensions?.css?.cell?.height;
    return h > 0 ? h : 17;
  };
  const onStart = (e: TouchEvent) => {
    lastY = e.touches.length === 1 ? e.touches[0]!.clientY : null;
    lastX = e.touches.length === 1 ? e.touches[0]!.clientX : 0;
    pending = 0;
  };
  const onMove = (e: TouchEvent) => {
    if (lastY === null || e.touches.length !== 1 || term.modes.mouseTrackingMode === "none") {
      return;
    }
    const y = e.touches[0]!.clientY;
    // Finger up = further down the conversation, as with native scrolling.
    pending += lastY - y;
    lastY = y;
    e.preventDefault();
    const step = cellHeight();
    const target = term.element?.querySelector(".xterm-screen") ?? term.element;
    // One wheel event per line moved, a few at most per frame.
    for (let n = 0; Math.abs(pending) >= step && n < 5; n++) {
      const deltaY = pending > 0 ? step : -step;
      pending -= deltaY;
      target?.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY,
          deltaMode: WheelEvent.DOM_DELTA_PIXEL,
          clientX: lastX,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  };
  const onEnd = () => {
    lastY = null;
  };
  container.addEventListener("touchstart", onStart, { passive: true });
  container.addEventListener("touchmove", onMove, { passive: false });
  container.addEventListener("touchend", onEnd, { passive: true });
  container.addEventListener("touchcancel", onEnd, { passive: true });
  return () => {
    container.removeEventListener("touchstart", onStart);
    container.removeEventListener("touchmove", onMove);
    container.removeEventListener("touchend", onEnd);
    container.removeEventListener("touchcancel", onEnd);
  };
}
