/**
 * In-memory relay between Optio Local daemons (one outbound WebSocket per
 * host, /ws/local/daemon) and browser terminal viewers
 * (/ws/local/terminals/:id/stream). See docs/optio-local.md.
 *
 * Pure connection plumbing — no DB access, so services and WS handlers can
 * both import it without cycles. Single API replica assumption (same as
 * exec-based interactive sessions).
 *
 * Attach flow: each browser attach gets an attachId; the daemon replies with
 * a scrollback snapshot addressed to that attachId and enables live output at
 * the same moment. Because daemon frames arrive in order on one socket, the
 * browser is enrolled for live output exactly when its snapshot is relayed —
 * no gap, no duplicated history for other viewers.
 */
import { randomUUID } from "node:crypto";
import type { LocalServerMessage, LocalStreamServerMessage } from "@optio/shared";
import { logger } from "../logger.js";

/** Minimal socket surface shared by @fastify/websocket sockets. */
export interface RelaySocket {
  readyState: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
}

const WS_OPEN = 1;

interface DaemonConn {
  hostId: string;
  userId: string | null;
  socket: RelaySocket;
}

interface PendingAttach {
  terminalId: string;
  socket: RelaySocket;
}

const daemonsByHost = new Map<string, DaemonConn>();
const browsersByTerminal = new Map<string, Set<RelaySocket>>();
const pendingAttaches = new Map<string, PendingAttach>();
const hostByTerminal = new Map<string, string>();

function safeSend(socket: RelaySocket, data: string | Buffer): void {
  if (socket.readyState === WS_OPEN) {
    try {
      socket.send(data);
    } catch (err) {
      logger.warn({ err }, "local-relay: send failed");
    }
  }
}

/**
 * Register a daemon connection for a host. An existing connection for the
 * same host is closed (the newest daemon wins — e.g. after a laptop resume
 * the old TCP connection may still look open).
 */
export function registerDaemon(hostId: string, userId: string | null, socket: RelaySocket): void {
  const existing = daemonsByHost.get(hostId);
  if (existing && existing.socket !== socket) {
    try {
      existing.socket.close(4000, "Replaced by a newer daemon connection");
    } catch {
      // ignore
    }
  }
  daemonsByHost.set(hostId, { hostId, userId, socket });
}

/**
 * Remove a daemon connection. Only removes if `socket` is still the
 * registered one (a replaced connection's close must not evict its
 * replacement). Closes attached browser viewers with 4503 so they reconnect.
 */
export function unregisterDaemon(hostId: string, socket: RelaySocket): boolean {
  const existing = daemonsByHost.get(hostId);
  if (!existing || existing.socket !== socket) return false;
  daemonsByHost.delete(hostId);

  for (const [terminalId, tHostId] of hostByTerminal) {
    if (tHostId !== hostId) continue;
    for (const browser of browsersByTerminal.get(terminalId) ?? []) {
      try {
        browser.close(4503, "Host disconnected");
      } catch {
        // ignore
      }
    }
    browsersByTerminal.delete(terminalId);
    for (const [attachId, pending] of pendingAttaches) {
      if (pending.terminalId === terminalId) {
        pendingAttaches.delete(attachId);
        try {
          pending.socket.close(4503, "Host disconnected");
        } catch {
          // ignore
        }
      }
    }
    hostByTerminal.delete(terminalId);
  }
  return true;
}

export function isHostOnline(hostId: string): boolean {
  const conn = daemonsByHost.get(hostId);
  return conn !== undefined && conn.socket.readyState === WS_OPEN;
}

/** Send a control message to a host's daemon. Returns false when offline. */
export function sendToHost(hostId: string, message: LocalServerMessage): boolean {
  const conn = daemonsByHost.get(hostId);
  if (!conn || conn.socket.readyState !== WS_OPEN) return false;
  safeSend(conn.socket, JSON.stringify(message));
  return true;
}

/**
 * Attach a browser socket to a terminal's live stream. Sends an `attach` to
 * the daemon; the browser is enrolled for live output when the daemon's
 * scrollback snapshot for this attachId arrives. Returns false when the host
 * is offline.
 */
export function attachBrowser(hostId: string, terminalId: string, socket: RelaySocket): boolean {
  if (!isHostOnline(hostId)) return false;
  const attachId = randomUUID();
  pendingAttaches.set(attachId, { terminalId, socket });
  hostByTerminal.set(terminalId, hostId);
  sendToHost(hostId, { type: "attach", terminalId, attachId });
  return true;
}

/** Detach a browser socket; tells the daemon to stop streaming when it was the last viewer. */
export function detachBrowser(hostId: string, terminalId: string, socket: RelaySocket): void {
  for (const [attachId, pending] of pendingAttaches) {
    if (pending.socket === socket && pending.terminalId === terminalId) {
      pendingAttaches.delete(attachId);
    }
  }
  const set = browsersByTerminal.get(terminalId);
  if (set) {
    set.delete(socket);
    if (set.size === 0) browsersByTerminal.delete(terminalId);
  }
  const stillPending = [...pendingAttaches.values()].some((p) => p.terminalId === terminalId);
  if (!browsersByTerminal.has(terminalId) && !stillPending) {
    hostByTerminal.delete(terminalId);
    sendToHost(hostId, { type: "detach", terminalId });
  }
}

/** Relay a daemon scrollback snapshot to the browser that requested it, then enroll it live. */
export function deliverScrollback(attachId: string, data: Buffer): void {
  const pending = pendingAttaches.get(attachId);
  if (!pending) return;
  pendingAttaches.delete(attachId);
  if (data.length > 0) safeSend(pending.socket, data);
  let set = browsersByTerminal.get(pending.terminalId);
  if (!set) {
    set = new Set();
    browsersByTerminal.set(pending.terminalId, set);
  }
  set.add(pending.socket);
}

/** Relay a daemon attach failure to the waiting browser. */
export function deliverAttachError(attachId: string, message: string): void {
  const pending = pendingAttaches.get(attachId);
  if (!pending) return;
  pendingAttaches.delete(attachId);
  const msg: LocalStreamServerMessage = { type: "error", message };
  safeSend(pending.socket, JSON.stringify(msg));
}

/**
 * Relay live terminal output to every attached browser. `hostId` is the
 * authenticated daemon's host; the frame is dropped unless that host owns the
 * terminal's live subscription (recorded at attach time from the DB row). This
 * stops a daemon from streaming bytes into another host's viewer using a
 * terminal id harvested from the shared events channel.
 */
export function forwardOutput(hostId: string, terminalId: string, data: Buffer): void {
  if (hostByTerminal.get(terminalId) !== hostId) return;
  const set = browsersByTerminal.get(terminalId);
  if (!set) return;
  for (const socket of set) safeSend(socket, data);
}

/** Push a JSON control message to every browser viewing a terminal. */
export function notifyBrowsers(terminalId: string, message: LocalStreamServerMessage): void {
  const payload = JSON.stringify(message);
  const set = browsersByTerminal.get(terminalId);
  if (set) for (const socket of set) safeSend(socket, payload);
  // Browsers still waiting on scrollback should hear state changes too.
  for (const pending of pendingAttaches.values()) {
    if (pending.terminalId === terminalId) safeSend(pending.socket, payload);
  }
}

/** Test-only: reset all relay state. */
export function resetRelayForTests(): void {
  daemonsByHost.clear();
  browsersByTerminal.clear();
  pendingAttaches.clear();
  hostByTerminal.clear();
}
