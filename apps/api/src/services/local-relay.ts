/**
 * The relay between Optio Local daemons (one outbound WebSocket per host,
 * /ws/local/daemon) and browser terminal viewers
 * (/ws/local/terminals/:id/stream). See docs/optio-local.md.
 *
 * Several API instances may share one database and Redis
 * (docs/plans/scale-out.md §4). A daemon is one socket on one instance, the
 * host's **owner**; a viewer, a REST call or a worker may be on another.
 *
 * - **Ownership** is the lease `local-host:<hostId>` in Postgres, held per
 *   daemon connection (`<instance>#<connection>`), seized on hello ("the
 *   newest daemon wins") and renewed every 10 s. The previous owner hears
 *   `host-taken` on the bus, or finds out when its renew fails, and closes
 *   its socket. `isHostOnline` is "this instance has the socket, or the
 *   lease is live"; what the daemon can do is on the host row
 *   (`capabilities`), so any instance can answer.
 * - **Owner side**: the daemon's socket, its terminals' viewers and the
 *   grid arbiter for each terminal (local-grid.ts). A viewer on another
 *   instance is a `RemoteViewer` here: a socket-shaped proxy whose frames go
 *   out on the terminal's bus channel, so attach, scrollback, size and the
 *   arbiter work the same for both.
 * - **Viewer side**: a viewer whose host is owned elsewhere is a
 *   `HomeViewer`: its attach, input, resize, view reports and pongs go to
 *   the owner on the host's channel; output and its frames come back on the
 *   terminal's channel. Every 10 s each instance tells the owners which
 *   viewers it still has (the owner drops the rest, and asks viewers it
 *   doesn't know to reconnect) and checks the owner still holds the lease.
 * - **Requests** to a daemon owned elsewhere (spawn, kill, dirs, limits,
 *   credentials, transcript backfill) go over the bus with an
 *   acknowledgement; the daemon's answer comes back to the asking instance
 *   on its reply channel.
 *
 * Attach flow: each attach gets an attachId; the daemon replies with a
 * snapshot of the terminal (addressed to that attachId, relayed behind a
 * `replay` frame naming its grid) and enables live output at the same
 * moment. Daemon frames arrive in order on one socket and the owner
 * publishes a terminal's frames in that order on one channel, so a viewer is
 * enrolled for live output exactly when its snapshot is relayed — no gap,
 * no duplicated history, wherever the viewer is.
 *
 * Without `enableLocalCluster()` (in-process tests) this is the
 * single-instance relay: no leases, no bus.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  parseIntEnv,
  type LocalDaemonMessage,
  type LocalServerMessage,
  type LocalStreamServerMessage,
} from "@optio/shared";
import { db } from "../db/client.js";
import { localHosts } from "../db/schema.js";
import { logger } from "../logger.js";
import { INSTANCE_ID } from "./instance.js";
import {
  leaseHolder,
  leaseHolders,
  releaseLease,
  renewLease,
  seizeLease,
} from "./lease-service.js";
import { localBus, localHostInChannel, localTermOutChannel, type BusMessage } from "./local-bus.js";
import { GridArbiter, saneGrid, type Grid, type ViewReport } from "./local-grid.js";

/** Minimal socket surface shared by @fastify/websocket sockets. */
export interface RelaySocket {
  readyState: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  /** WebSocket ping: is this viewer still there? Its pong goes to `viewerPong`. */
  ping?(): void;
}

const WS_OPEN = 1;
const WS_CLOSED = 3;

/** What a daemon advertised in its hello. */
export interface HostCapabilities {
  /** It can supply a Claude OAuth token on request. */
  claudeCredentials: boolean;
  /** It answers `transcript-request`. */
  transcriptBackfill: boolean;
  /** It adds / removes allowlisted dirs on request (`dirs`). */
  manageDirs: boolean;
  /** It runs agents through a model provider (`spec.provider`). */
  modelProviders: boolean;
  /** It refreshes agent limits on request (`limits-refresh`). */
  refreshLimits: boolean;
  /** It answers its terminals' queries itself (`answersQueries`). */
  answersQueries: boolean;
}

const CAPABILITY_KEYS: Array<keyof HostCapabilities> = [
  "claudeCredentials",
  "transcriptBackfill",
  "manageDirs",
  "modelProviders",
  "refreshLimits",
  "answersQueries",
];

function toCapabilities(
  raw: Partial<Record<string, unknown>> | null | undefined,
): HostCapabilities {
  const caps = {} as HostCapabilities;
  for (const key of CAPABILITY_KEYS) caps[key] = raw?.[key] === true;
  return caps;
}

// ── Cluster settings ─────────────────────────────────────────────────────────

/** How long a host's lease lasts without a renew. */
const HOST_LEASE_TTL_MS = parseIntEnv("OPTIO_LOCAL_HOST_LEASE_TTL_MS", 30_000);
/** How often the owner renews it. */
const HOST_LEASE_RENEW_MS = parseIntEnv("OPTIO_LOCAL_HOST_LEASE_RENEW_MS", 10_000);
/** How often viewers are reported to their owners and owners checked. */
const VIEWER_HEARTBEAT_MS = parseIntEnv("OPTIO_LOCAL_VIEWER_HEARTBEAT_MS", 10_000);
/** A remote viewer not reported for this long is dropped by the owner. */
const REMOTE_VIEWER_TTL_MS = VIEWER_HEARTBEAT_MS * 3;
/** How long a frame for a daemon owned elsewhere waits for the owner's acknowledgement. */
const SEND_ACK_TIMEOUT_MS = parseIntEnv("OPTIO_LOCAL_SEND_ACK_TIMEOUT_MS", 5_000);
/** How long a viewer attached through another instance waits for its snapshot. */
const REMOTE_ATTACH_TIMEOUT_MS = 10_000;
/** How long the owner remembers who asked for a daemon's answer. */
const FORWARDED_REQUEST_TTL_MS = 3 * 60_000;

export const hostLeaseKey = (hostId: string) => `local-host:${hostId}`;
/** The instance in a lease holder (`<instance>#<connection>`). */
const instanceOfHolder = (holder: string) => holder.slice(0, holder.lastIndexOf("#"));

let clustered = false;
let heartbeatTimer: NodeJS.Timeout | null = null;

/**
 * Turns on what several instances need: host leases, the bus routes and the
 * viewer heartbeat. Boot calls it before `listen`; the bus itself starts
 * after (`localBus.startInBackground()`), and until it is up Local works on
 * this instance alone.
 */
export function enableLocalCluster(): void {
  if (clustered) return;
  clustered = true;
  heartbeatTimer = setInterval(() => void heartbeat(), VIEWER_HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

export function isLocalClusterEnabled(): boolean {
  return clustered;
}

// ── Owner side: daemons, viewers, grids ──────────────────────────────────────

interface DaemonConn {
  hostId: string;
  userId: string | null;
  socket: RelaySocket;
  caps: HostCapabilities;
  /** The lease holder for this connection: `<instance>#<connection>`. */
  holder: string;
  /** The lease is ours (seized and not yet lost). */
  claimed: boolean;
  /** Dropped from the relay (closed, replaced, or taken over). */
  dropped: boolean;
  renewTimer: NodeJS.Timeout | null;
  /** The host's inbound bus channel, while this connection owns the host. */
  inbox: { close(): void } | null;
  /**
   * Bus messages for this connection that arrived before its claim
   * completed, handled right after it; null once claimed.
   */
  backlog: BusMessage[] | null;
  /** The claim in flight (`claimHost`), if any. */
  claiming: Promise<void> | null;
  /** Settles once a dropped connection's lease is released. */
  released: Promise<void>;
}

interface PendingAttach {
  terminalId: string;
  socket: RelaySocket;
}

const daemonsByHost = new Map<string, DaemonConn>();
const browsersByTerminal = new Map<string, Set<RelaySocket>>();
const pendingAttaches = new Map<string, PendingAttach>();
const hostByTerminal = new Map<string, string>();
/** Each terminal's viewers and which of them its PTY is sized for (local-grid.ts). */
const gridByTerminal = new Map<string, GridArbiter<RelaySocket>>();
/** Viewers on other instances, by viewer id (owner side). */
const remoteViewers = new Map<string, RemoteViewer>();
/** Daemon requests asked from another instance: requestId → who asked (owner side). */
const forwardedRequests = new Map<string, { origin: string; hostId: string; at: number }>();

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
 * A viewer connected to another instance, as the owner sees it: frames sent
 * to it go out on the terminal's bus channel addressed to the viewer.
 */
class RemoteViewer implements RelaySocket {
  readonly remote = true;
  readyState = WS_OPEN;
  seenAt = Date.now();

  constructor(
    readonly instance: string,
    readonly viewerId: string,
    readonly terminalId: string,
    readonly hostId: string,
  ) {}

  private publish(header: { k: string; [field: string]: unknown }, payload?: Buffer): void {
    void localBus.publish(
      localTermOutChannel(this.terminalId),
      { ...header, v: this.viewerId },
      payload,
    );
  }

  send(data: string | Buffer): void {
    if (typeof data === "string") this.publish({ k: "fr", j: 1 }, Buffer.from(data, "utf-8"));
    else this.publish({ k: "fr" }, data);
  }

  /** The attach snapshot: the viewer home relays it and enrolls the viewer for output. */
  snapshot(data: Buffer, grid?: Grid): void {
    this.publish({ k: "sb", ...(grid ? { g: [grid.cols, grid.rows] } : {}) }, data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState !== WS_OPEN) return;
    this.readyState = WS_CLOSED;
    remoteViewers.delete(this.viewerId);
    this.publish({ k: "close", c: code ?? 1000, r: reason ?? "" });
  }

  ping(): void {
    this.publish({ k: "ping" });
  }

  /** Forgotten without telling the viewer (it left, or its instance went). */
  forget(): void {
    this.readyState = WS_CLOSED;
    remoteViewers.delete(this.viewerId);
  }
}

const isRemote = (socket: RelaySocket): socket is RemoteViewer => socket instanceof RemoteViewer;

/** This instance's live connection for a host, if it has one. */
function localConn(hostId: string): DaemonConn | null {
  const conn = daemonsByHost.get(hostId);
  return conn && !conn.dropped && conn.socket.readyState === WS_OPEN ? conn : null;
}

/**
 * Register a daemon connection for a host on this instance. An existing
 * connection for the same host here is closed (the newest daemon wins —
 * e.g. after a laptop resume the old TCP connection may still look open),
 * and so are its viewers' streams: the new connection starts with no
 * subscriptions, so they reconnect and attach to it. In a cluster the
 * caller then claims the host (`claimHost`).
 */
export function registerDaemon(
  hostId: string,
  userId: string | null,
  socket: RelaySocket,
  capabilities: Partial<HostCapabilities> = {},
): void {
  const existing = daemonsByHost.get(hostId);
  if (existing && existing.socket !== socket) {
    dropDaemon(existing, { release: false });
    try {
      existing.socket.close(4000, "Replaced by a newer daemon connection");
    } catch {
      // ignore
    }
  }
  daemonsByHost.set(hostId, {
    hostId,
    userId,
    socket,
    caps: toCapabilities(capabilities),
    holder: `${INSTANCE_ID}#${randomUUID().slice(0, 8)}`,
    claimed: false,
    dropped: false,
    renewTimer: null,
    inbox: null,
    backlog: [],
    claiming: null,
    released: Promise.resolve(),
  });
  // Viewers here that were streaming through another instance were
  // streaming the daemon's previous connection: reconnect them to this one.
  closeHomeViewersOfHost(hostId, "Host reconnected");
}

/**
 * Makes this instance the host's owner for the cluster: listens on the
 * host's inbound channel, records what the daemon can do, seizes the lease
 * (the newest daemon wins) and tells the previous owner, then renews the
 * lease while the connection lasts. Frames for this connection that arrive
 * before the claim completes are handled right after it. A no-op outside a
 * cluster. Throws when the lease can't be written (the caller closes the
 * daemon, which reconnects). A connection that closes meanwhile gives its
 * lease back once the claim is done (`daemonDisconnected` waits for that).
 */
export function claimHost(hostId: string, socket: RelaySocket): Promise<void> {
  const conn = daemonsByHost.get(hostId);
  if (!clustered || !conn || conn.socket !== socket || conn.dropped) return Promise.resolve();
  const claiming = claim(conn).finally(() => {
    if (conn.claiming === claiming) conn.claiming = null;
  });
  conn.claiming = claiming;
  return claiming;
}

async function claim(conn: DaemonConn): Promise<void> {
  const hostId = conn.hostId;
  // Listen before the lease says we own it, so nothing sent to the new
  // owner is lost; bounded, as Redis may be down (then only this instance
  // reaches the daemon until the bus is up).
  const inbox = localBus.listen(localHostInChannel(hostId), (m) => onHostIn(conn, m));
  conn.inbox = inbox;
  await Promise.race([inbox.ready, new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())]);
  if (conn.dropped) return;
  await db
    .update(localHosts)
    .set({ capabilities: { ...conn.caps } })
    .where(eq(localHosts.id, hostId));
  if (conn.dropped) return;
  await seizeLease(hostLeaseKey(hostId), HOST_LEASE_TTL_MS, conn.holder);
  if (conn.dropped) {
    // Closed while we were seizing it: give back exactly what we took.
    await releaseLease(hostLeaseKey(hostId), conn.holder).catch(() => {});
    return;
  }
  conn.claimed = true;
  void localBus.publish(localHostInChannel(hostId), { k: "host-taken" });
  conn.renewTimer = setInterval(() => void renewHost(conn), HOST_LEASE_RENEW_MS);
  conn.renewTimer.unref?.();
  const backlog = conn.backlog ?? [];
  conn.backlog = null;
  for (const m of backlog) handleHostIn(conn, m);
}

async function renewHost(conn: DaemonConn): Promise<void> {
  if (conn.dropped || !conn.claimed) return;
  let ok: boolean;
  try {
    ok = await renewLease(hostLeaseKey(conn.hostId), HOST_LEASE_TTL_MS, conn.holder);
  } catch {
    // The database away for a moment is not a lost lease: the TTL covers it.
    return;
  }
  if (!ok) supersede(conn, "lease lost");
}

/** Another connection owns the host now: close ours without marking the host offline. */
function supersede(conn: DaemonConn, why: string): void {
  if (conn.dropped || daemonsByHost.get(conn.hostId) !== conn) return;
  logger.info({ hostId: conn.hostId, why }, "local daemon connection superseded");
  dropDaemon(conn, { release: false });
  try {
    conn.socket.close(4000, "Replaced by a newer daemon connection");
  } catch {
    // ignore
  }
}

/** Takes a connection out of the relay and closes its viewers' streams (4503: they reconnect). */
function dropDaemon(conn: DaemonConn, opts: { release: boolean }): void {
  if (conn.dropped) return;
  conn.dropped = true;
  if (daemonsByHost.get(conn.hostId) === conn) daemonsByHost.delete(conn.hostId);
  if (conn.renewTimer) clearInterval(conn.renewTimer);
  conn.renewTimer = null;
  conn.inbox?.close();
  conn.inbox = null;
  if (opts.release && conn.claimed) {
    conn.released = releaseLease(hostLeaseKey(conn.hostId), conn.holder).catch((err) =>
      logger.warn({ err, hostId: conn.hostId }, "local: host lease release failed"),
    );
  }
  closeViewersOfHost(conn.hostId);
}

function closeViewersOfHost(hostId: string): void {
  for (const [terminalId, tHostId] of [...hostByTerminal]) {
    if (tHostId !== hostId) continue;
    for (const browser of browsersByTerminal.get(terminalId) ?? []) {
      try {
        browser.close(4503, "Host disconnected");
      } catch {
        // ignore
      }
    }
    browsersByTerminal.delete(terminalId);
    dropGrid(terminalId);
    for (const [attachId, pending] of [...pendingAttaches]) {
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
  for (const proxy of [...remoteViewers.values()]) {
    if (proxy.hostId === hostId) proxy.close(4503, "Host disconnected");
  }
}

/**
 * Remove a daemon connection. Only removes if `socket` is still the
 * registered one (a replaced connection's close must not evict its
 * replacement). Closes attached viewers with 4503 so they reconnect.
 */
export function unregisterDaemon(hostId: string, socket: RelaySocket): boolean {
  const existing = daemonsByHost.get(hostId);
  if (!existing || existing.socket !== socket) return false;
  dropDaemon(existing, { release: true });
  return true;
}

/**
 * The daemon's socket closed. True when it was this host's connection (the
 * host is offline unless another connection took it), once its lease is
 * released — so the caller's offline mark can't land on a newer owner.
 */
export async function daemonDisconnected(hostId: string, socket: RelaySocket): Promise<boolean> {
  const existing = daemonsByHost.get(hostId);
  if (!existing || existing.socket !== socket) return false;
  dropDaemon(existing, { release: true });
  // A claim in flight gives back the lease it took once it lands; only then
  // may the caller mark the host offline.
  await existing.claiming?.catch(() => {});
  await existing.released;
  return true;
}

// ── Online state and capabilities, from any instance ─────────────────────────

/** Whether the host's daemon is connected — to this instance or, in a cluster, to any. */
export async function isHostOnline(hostId: string): Promise<boolean> {
  if (localConn(hostId)) return true;
  if (!clustered) return false;
  return (await leaseHolder(hostLeaseKey(hostId))) !== null;
}

/** What the host's connected daemon can do; null while it is offline. */
export async function hostCapabilities(hostId: string): Promise<HostCapabilities | null> {
  const conn = localConn(hostId);
  if (conn) return conn.caps;
  if (!clustered) return null;
  const rows = await db
    .select({ capabilities: localHosts.capabilities })
    .from(localHosts)
    .where(
      and(
        eq(localHosts.id, hostId),
        sql`EXISTS (SELECT 1 FROM "leases" WHERE "key" = ${hostLeaseKey(hostId)} AND "expires_at" > now())`,
      ),
    );
  return rows.length > 0 ? toCapabilities(rows[0].capabilities) : null;
}

/**
 * What a host row's connected daemon can do, from the row alone (no query):
 * this instance's connection when it has one, else, in a cluster, the
 * capabilities stored on the row while its lease-derived state is online
 * (`listHosts` / `getHost` derive it). Null while offline.
 */
export function capabilitiesOf(host: {
  id: string;
  state: string;
  capabilities?: Record<string, unknown> | null;
}): HostCapabilities | null {
  const conn = localConn(host.id);
  if (conn) return conn.caps;
  if (!clustered || host.state !== "online") return null;
  return toCapabilities(host.capabilities);
}

const can = (cap: keyof HostCapabilities) => async (hostId: string) =>
  (await hostCapabilities(hostId))?.[cap] === true;

/** Whether the host's connected daemon can read a finished session's transcript off disk (false when offline). */
export const hostCanBackfillTranscripts = can("transcriptBackfill");
/** Whether the host's connected daemon runs agents through a model provider (false when offline). */
export const hostCanUseModelProviders = can("modelProviders");
/** Whether the host's connected daemon answers its terminals' queries itself (false when offline). */
export const hostAnswersQueries = can("answersQueries");

/** Online hosts whose daemon advertised Claude credentials, on any instance. */
export async function hostsWithClaudeCredentials(): Promise<
  Array<{ hostId: string; userId: string | null }>
> {
  const found = new Map<string, string | null>();
  for (const c of daemonsByHost.values()) {
    if (c.caps.claudeCredentials && localConn(c.hostId)) found.set(c.hostId, c.userId);
  }
  if (clustered) {
    const rows = await db.execute<{ id: string; user_id: string | null }>(sql`
      SELECT h."id", h."user_id" FROM "local_hosts" h
      JOIN "leases" l ON l."key" = 'local-host:' || h."id"::text AND l."expires_at" > now()
      WHERE h."capabilities" ->> 'claudeCredentials' = 'true'`);
    for (const r of rows) found.set(r.id, r.user_id);
  }
  return [...found].map(([hostId, userId]) => ({ hostId, userId }));
}

// ── Frames to a daemon ───────────────────────────────────────────────────────

/** Send to a daemon connected to this instance. False when it isn't. */
function sendToLocalDaemon(hostId: string, message: LocalServerMessage): boolean {
  const conn = localConn(hostId);
  if (!conn) return false;
  safeSend(conn.socket, JSON.stringify(message));
  return true;
}

/**
 * How a frame for a daemon went: `sent` (to its socket here, or
 * acknowledged by its owner), `offline` (nobody owns the host, or nobody
 * listened: it went nowhere), or `unacknowledged` (the owner heard it but
 * didn't acknowledge in time: it may have reached the daemon, so it must
 * never be sent again as if it hadn't).
 */
export type HostDelivery = "sent" | "offline" | "unacknowledged";

/** Send a control message to a host's daemon, wherever it is connected. */
export async function deliverToHost(
  hostId: string,
  message: LocalServerMessage,
): Promise<HostDelivery> {
  if (sendToLocalDaemon(hostId, message)) return "sent";
  if (!clustered || !localBus.started) return "offline";
  const holder = await leaseHolder(hostLeaseKey(hostId));
  // Nobody holds it, or we do and the socket just went: nobody to ask.
  if (holder === null || instanceOfHolder(holder) === INSTANCE_ID) return "offline";
  const ack = await localBus.ask(
    localHostInChannel(hostId),
    { k: "send", h: holder },
    SEND_ACK_TIMEOUT_MS,
    Buffer.from(JSON.stringify(message), "utf-8"),
  );
  if (ack === "unheard") return "offline";
  if (ack === "timeout") {
    logger.warn({ hostId, type: message.type }, "local: owner did not acknowledge a frame in time");
    return "unacknowledged";
  }
  return ack.header.ok === true ? "sent" : "unacknowledged";
}

/**
 * `deliverToHost` as "it may have reached the daemon": false only when it
 * certainly did not (the host is offline).
 */
export async function sendToHost(hostId: string, message: LocalServerMessage): Promise<boolean> {
  return (await deliverToHost(hostId, message)) !== "offline";
}

// ── Work only the owner may do ───────────────────────────────────────────────

/** A piece of work run on the host's owner (where its daemon is), returning a plain result. */
export type OwnerTask = (hostId: string, args: Record<string, unknown>) => Promise<unknown>;

const ownerTasks = new Map<string, OwnerTask>();

/** Registers what this instance does when asked to run `name` as a host's owner. */
export function onOwnerTask(name: string, task: OwnerTask): void {
  ownerTasks.set(name, task);
}

/**
 * Runs `name` on the host's owner — here when the daemon is connected here,
 * else on its owner through the bus — and resolves with its result, or
 * `offline` / `timeout`. For work whose inputs must not cross Redis (a
 * Claude token): the owner does it all and returns only the outcome.
 */
export async function runOnOwner(
  hostId: string,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ result: unknown } | "offline" | "timeout"> {
  const task = ownerTasks.get(name);
  if (localConn(hostId)) {
    if (!task) throw new Error(`No owner task ${name}`);
    return { result: await task(hostId, args) };
  }
  if (!clustered || !localBus.started) return "offline";
  const holder = await leaseHolder(hostLeaseKey(hostId));
  if (holder === null || instanceOfHolder(holder) === INSTANCE_ID) return "offline";
  const answer = await localBus.ask(
    localHostInChannel(hostId),
    { k: "task", h: holder, task: name },
    timeoutMs,
    Buffer.from(JSON.stringify(args), "utf-8"),
  );
  if (answer === "unheard") return "offline";
  if (answer === "timeout") return "timeout";
  if (typeof answer.header.err === "string") throw new Error(answer.header.err);
  try {
    return { result: JSON.parse(answer.payload.toString("utf-8")) as unknown };
  } catch {
    return { result: null };
  }
}

/** Daemon answers to a request by id (`requestId`): the one type for them. */
export type DaemonReply = Extract<
  LocalDaemonMessage,
  {
    type: "credentials-result" | "dirs-result" | "limits-refresh-result" | "transcript-backfill";
  }
>;

/**
 * Requests whose answers the owner relays to the instance that asked. Not
 * `credentials`: its answer carries a Claude token, which never crosses
 * Redis (the owner runs the whole refresh: `runOnOwner`).
 */
const RELAYED_REQUEST_TYPES = new Set(["dirs", "limits-refresh", "transcript-request"]);

let forwardedReplyHandler: ((hostId: string, msg: DaemonReply) => Promise<void> | void) | null =
  null;
/** Relayed answers, delivered in order per host (a backfill's frames commit in order). */
const replyChains = new Map<string, Promise<void>>();

/**
 * What this instance does with a daemon's answer to a request it sent
 * through another instance (ws/local-daemon.ts: the same delivery as a
 * daemon connected here).
 */
export function onForwardedDaemonReply(
  handler: (hostId: string, msg: DaemonReply) => Promise<void> | void,
): void {
  forwardedReplyHandler = handler;
}

/**
 * The owner got a daemon's answer: when another instance asked, send it
 * there and say so (true); false means it is this instance's to deliver.
 */
export function forwardDaemonReply(hostId: string, msg: DaemonReply): boolean {
  // Never relayed (and never forwarded, so nobody elsewhere waits for it).
  if (msg.type === "credentials-result") return false;
  const requestId = (msg as { requestId?: unknown }).requestId;
  if (typeof requestId !== "string") return false;
  const asked = forwardedRequests.get(requestId);
  if (!asked || asked.hostId !== hostId) return false;
  const more = msg.type === "transcript-backfill" && msg.done !== true;
  if (!more) forwardedRequests.delete(requestId);
  void localBus.sendDirect(
    asked.origin,
    { k: "daemon-reply", h: hostId },
    Buffer.from(JSON.stringify(msg), "utf-8"),
  );
  return true;
}

localBus.onDirect("daemon-reply", (m) => {
  const hostId = m.header.h;
  const handler = forwardedReplyHandler;
  if (typeof hostId !== "string" || !handler) return;
  let msg: DaemonReply;
  try {
    msg = JSON.parse(m.payload.toString("utf-8")) as DaemonReply;
  } catch {
    return;
  }
  if (msg.type === "credentials-result") return;
  // One after another per host, as they would be off the daemon's socket.
  const next = (replyChains.get(hostId) ?? Promise.resolve())
    .then(() => handler(hostId, msg))
    .catch((err) => logger.warn({ err, hostId, type: msg.type }, "local: relayed reply failed"));
  replyChains.set(hostId, next);
  void next.then(() => {
    if (replyChains.get(hostId) === next) replyChains.delete(hostId);
  });
});

// ── Viewers attached on this instance (owner side) ───────────────────────────

/**
 * Attach a viewer socket to a terminal's live stream on this instance's
 * daemon. Sends an `attach` to the daemon; the viewer is enrolled for live
 * output when the daemon's snapshot for this attachId arrives. Returns false
 * when the daemon is not connected here.
 */
export function attachBrowser(hostId: string, terminalId: string, socket: RelaySocket): boolean {
  if (!localConn(hostId)) return false;
  const attachId = randomUUID();
  pendingAttaches.set(attachId, { terminalId, socket });
  hostByTerminal.set(terminalId, hostId);
  gridFor(hostId, terminalId).add(socket);
  sendToLocalDaemon(hostId, { type: "attach", terminalId, attachId });
  return true;
}

/** Detach a viewer socket; tells the daemon to stop streaming when it was the last viewer. */
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
  const grid = gridByTerminal.get(terminalId);
  if (grid) {
    grid.remove(socket);
    if (grid.viewerCount === 0) dropGrid(terminalId);
  }
  const stillPending = [...pendingAttaches.values()].some((p) => p.terminalId === terminalId);
  if (!browsersByTerminal.has(terminalId) && !stillPending) {
    hostByTerminal.delete(terminalId);
    sendToLocalDaemon(hostId, { type: "detach", terminalId });
  }
}

/**
 * Relay a daemon's snapshot to the viewer that requested it, then enroll it
 * live. A snapshot that names its grid goes out behind a `replay` frame, so
 * the viewer lays it out at the size it was drawn for.
 */
export function deliverScrollback(
  attachId: string,
  data: Buffer,
  grid?: { cols: number; rows: number },
): void {
  const pending = pendingAttaches.get(attachId);
  if (!pending) return;
  pendingAttaches.delete(attachId);
  if (isRemote(pending.socket)) {
    pending.socket.snapshot(data, grid);
  } else if (data.length > 0) {
    if (grid) sendToViewer(pending.socket, { type: "replay", cols: grid.cols, rows: grid.rows });
    safeSend(pending.socket, data);
  }
  let set = browsersByTerminal.get(pending.terminalId);
  if (!set) {
    set = new Set();
    browsersByTerminal.set(pending.terminalId, set);
  }
  set.add(pending.socket);
}

/** Relay a daemon attach failure to the waiting viewer. */
export function deliverAttachError(attachId: string, message: string): void {
  const pending = takePendingAttach(attachId);
  if (pending) sendToViewer(pending.socket, { type: "error", message });
}

/**
 * Take a viewer's pending attach off the books (the daemon answered it with
 * an error; the caller decides what the viewer gets instead). Null when it
 * was already answered or the viewer left.
 */
export function takePendingAttach(attachId: string): PendingAttach | null {
  const pending = pendingAttaches.get(attachId);
  if (!pending) return null;
  pendingAttaches.delete(attachId);
  return pending;
}

/** One frame to one viewer: JSON control, or raw terminal bytes. */
export function sendToViewer(socket: RelaySocket, frame: LocalStreamServerMessage | Buffer): void {
  safeSend(socket, Buffer.isBuffer(frame) ? frame : JSON.stringify(frame));
}

/**
 * Relay live terminal output to every attached viewer — here directly, on
 * other instances with one bus message. `hostId` is the authenticated
 * daemon's host; the frame is dropped unless that host owns the terminal's
 * live subscription (recorded at attach time from the DB row). This stops a
 * daemon from streaming bytes into another host's viewer using a terminal
 * id harvested from the shared events channel.
 */
export function forwardOutput(hostId: string, terminalId: string, data: Buffer): void {
  if (hostByTerminal.get(terminalId) !== hostId) return;
  const set = browsersByTerminal.get(terminalId);
  if (!set) return;
  let remote = false;
  for (const socket of set) {
    if (isRemote(socket)) remote = true;
    else safeSend(socket, data);
  }
  if (remote) void localBus.publish(localTermOutChannel(terminalId), { k: "out" }, data);
}

/**
 * Forward the daemon's PTY size to every viewer, each told whether the grid
 * is theirs. Same ownership rule as output: only the host that holds the
 * terminal's live subscription may speak for it.
 */
export function forwardSize(hostId: string, terminalId: string, cols: number, rows: number): void {
  if (hostByTerminal.get(terminalId) !== hostId) return;
  gridByTerminal.get(terminalId)?.sized({ cols, rows });
}

// ── Grid: which screen the PTY is sized for (local-grid.ts) ─────────────────

function gridFor(hostId: string, terminalId: string): GridArbiter<RelaySocket> {
  let grid = gridByTerminal.get(terminalId);
  if (!grid) {
    grid = new GridArbiter<RelaySocket>({
      resize: ({ cols, rows }) =>
        sendToLocalDaemon(hostId, { type: "resize", terminalId, cols, rows }),
      announce: (socket, { cols, rows }, yours) =>
        sendToViewer(socket, { type: "size", cols, rows, yours }),
      ping: (socket) => {
        if (socket.readyState !== WS_OPEN || !socket.ping) return false;
        try {
          socket.ping();
          return true;
        } catch {
          return false;
        }
      },
    });
    gridByTerminal.set(terminalId, grid);
  }
  return grid;
}

function dropGrid(terminalId: string): void {
  gridByTerminal.get(terminalId)?.dispose();
  gridByTerminal.delete(terminalId);
}

/** A viewer said how it sees the terminal (`view`). */
export function viewerView(terminalId: string, socket: RelaySocket, report: ViewReport): void {
  gridByTerminal.get(terminalId)?.view(socket, report);
}

/** A viewer asked for the PTY at its size (`resize`: a click, a keystroke, "Use this screen"). */
export function viewerClaim(
  hostId: string,
  terminalId: string,
  socket: RelaySocket,
  grid: Grid,
): void {
  const arbiter = gridByTerminal.get(terminalId);
  if (arbiter?.has(socket)) arbiter.claim(socket, grid);
  else sendToLocalDaemon(hostId, { type: "resize", terminalId, cols: grid.cols, rows: grid.rows });
}

/** A viewer typed. */
export function viewerInput(terminalId: string, socket: RelaySocket): void {
  gridByTerminal.get(terminalId)?.input(socket);
}

/** A viewer answered a ping. */
export function viewerPong(terminalId: string, socket: RelaySocket): void {
  gridByTerminal.get(terminalId)?.pong(socket);
}

/**
 * Push a JSON control message to every viewer of a terminal, on every
 * instance — and, by default, to viewers still waiting on their scrollback.
 * `pending: false` skips those: after a terminal's exit, a still-pending
 * attach is answered with attach-error, and the viewer gets the recorded
 * screen (exit included) then (see handleAttachError).
 */
export function notifyBrowsers(
  terminalId: string,
  message: LocalStreamServerMessage,
  opts: { pending?: boolean } = {},
): void {
  const payload = JSON.stringify(message);
  const pending = opts.pending !== false;
  deliverNotify(terminalId, payload, pending);
  if (clustered) {
    void localBus.publish(
      localTermOutChannel(terminalId),
      { k: "notify", p: pending ? 1 : 0 },
      Buffer.from(payload, "utf-8"),
    );
  }
}

/** A notify to this instance's own sockets (remote viewers hear it on the bus). */
function deliverNotify(terminalId: string, payload: string, pending: boolean): void {
  for (const socket of browsersByTerminal.get(terminalId) ?? []) {
    if (!isRemote(socket)) safeSend(socket, payload);
  }
  if (pending) {
    // Viewers still waiting on scrollback should hear state changes too.
    for (const p of pendingAttaches.values()) {
      if (p.terminalId === terminalId && !isRemote(p.socket)) safeSend(p.socket, payload);
    }
  }
  for (const viewerId of homeByTerminal.get(terminalId) ?? []) {
    const hv = homeViewers.get(viewerId);
    if (hv && (hv.enrolled || pending)) safeSend(hv.socket, payload);
  }
}

// ── The owner's inbound channel ──────────────────────────────────────────────

function proxyFor(m: BusMessage, hostId: string): RemoteViewer | null {
  const viewerId = m.header.v;
  const terminalId = m.header.t;
  if (typeof viewerId !== "string" || typeof terminalId !== "string") return null;
  const proxy = remoteViewers.get(viewerId);
  return proxy && proxy.hostId === hostId && proxy.terminalId === terminalId ? proxy : null;
}

/**
 * A message on the host's inbound channel, for this connection. Everything
 * but `host-taken` names the connection it is for (the lease holder its
 * sender read): while a host changes hands the previous owner may still be
 * listening, and must not act on what is the new one's. What arrives before
 * this connection's claim completes waits for it.
 */
function onHostIn(conn: DaemonConn, m: BusMessage): void {
  if (conn.dropped || conn.socket.readyState !== WS_OPEN) return;
  if (m.header.k !== "host-taken" && m.header.h !== conn.holder) return;
  if (conn.backlog) {
    conn.backlog.push(m);
    return;
  }
  handleHostIn(conn, m);
}

function handleHostIn(conn: DaemonConn, m: BusMessage): void {
  if (conn.dropped) return;
  const hostId = conn.hostId;
  const { header } = m;
  const terminalId = typeof header.t === "string" ? header.t : null;
  switch (header.k) {
    case "host-taken":
      // Only a nudge to look: a connection gives the host up only when it
      // holds a claim and the lease, read now, names another connection.
      void recheckOwnership(conn);
      return;
    case "send": {
      let message: LocalServerMessage;
      try {
        message = JSON.parse(m.payload.toString("utf-8")) as LocalServerMessage;
      } catch {
        return;
      }
      // A token request is never sent on another instance's behalf.
      if (message.type === "credentials") return;
      const requestId = (message as { requestId?: unknown }).requestId;
      if (RELAYED_REQUEST_TYPES.has(message.type) && typeof requestId === "string") {
        rememberForwarded(requestId, m.header.o, hostId);
      }
      if (sendToLocalDaemon(hostId, message)) void localBus.reply(m, { ok: true });
      return;
    }
    case "task": {
      const task = typeof header.task === "string" ? ownerTasks.get(header.task) : undefined;
      if (!task) return;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(m.payload.toString("utf-8") || "{}") as Record<string, unknown>;
      } catch {
        return;
      }
      void task(hostId, args).then(
        (result) => localBus.reply(m, {}, Buffer.from(JSON.stringify(result ?? null), "utf-8")),
        (err: unknown) =>
          localBus.reply(m, { err: err instanceof Error ? err.message : String(err) }),
      );
      return;
    }
    case "attach": {
      const viewerId = header.v;
      if (!terminalId || typeof viewerId !== "string" || remoteViewers.has(viewerId)) return;
      const proxy = new RemoteViewer(m.header.o, viewerId, terminalId, hostId);
      remoteViewers.set(viewerId, proxy);
      attachBrowser(hostId, terminalId, proxy);
      return;
    }
    case "detach": {
      const proxy = proxyFor(m, hostId);
      if (!proxy) return;
      proxy.forget();
      detachBrowser(hostId, proxy.terminalId, proxy);
      return;
    }
    case "input": {
      const proxy = proxyFor(m, hostId);
      if (!proxy || !terminalId) return;
      viewerInput(terminalId, proxy);
      sendToLocalDaemon(hostId, {
        type: "input",
        terminalId,
        dataB64: m.payload.toString("base64"),
      });
      return;
    }
    case "claim": {
      const g = Array.isArray(header.g) ? saneGrid(header.g[0], header.g[1]) : undefined;
      const proxy = proxyFor(m, hostId);
      if (!proxy || !terminalId || !g) return;
      viewerClaim(hostId, terminalId, proxy, g);
      return;
    }
    case "view": {
      const proxy = proxyFor(m, hostId);
      const r = header.r as ViewReport | undefined;
      if (proxy && r && typeof r === "object") viewerView(proxy.terminalId, proxy, r);
      return;
    }
    case "pong": {
      const proxy = proxyFor(m, hostId);
      if (proxy) viewerPong(proxy.terminalId, proxy);
      return;
    }
    case "viewers":
      onViewerReport(hostId, m);
      return;
    default:
      return;
  }
}

/** Another connection says it took the host: re-read the lease, give it up only if so. */
async function recheckOwnership(conn: DaemonConn): Promise<void> {
  if (!conn.claimed || conn.dropped) return;
  let holder: string | null;
  try {
    holder = await leaseHolder(hostLeaseKey(conn.hostId));
  } catch {
    return; // the next renew decides
  }
  if (conn.claimed && !conn.dropped && holder !== conn.holder) {
    supersede(conn, "taken by a newer connection");
  }
}

function rememberForwarded(requestId: string, origin: string, hostId: string): void {
  const now = Date.now();
  for (const [id, f] of forwardedRequests) {
    if (now - f.at > FORWARDED_REQUEST_TTL_MS) forwardedRequests.delete(id);
  }
  forwardedRequests.set(requestId, { origin, hostId, at: now });
}

/**
 * An instance's heartbeat: the viewers it still has on this host. Known ones
 * are kept; ones the owner never heard of (they attached through a previous
 * owner) are asked to reconnect; ones it no longer lists are dropped.
 */
function onViewerReport(hostId: string, m: BusMessage): void {
  const listed = Array.isArray(m.header.vs) ? (m.header.vs as unknown[]) : [];
  const now = Date.now();
  const seen = new Set<string>();
  for (const entry of listed) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
      continue;
    }
    const [terminalId, viewerId] = entry as [string, string];
    seen.add(viewerId);
    const proxy = remoteViewers.get(viewerId);
    if (proxy && proxy.hostId === hostId) {
      proxy.seenAt = now;
    } else {
      void localBus.publish(localTermOutChannel(terminalId), {
        k: "close",
        v: viewerId,
        c: 4503,
        r: "Host reconnected",
      });
    }
  }
  for (const proxy of [...remoteViewers.values()]) {
    if (proxy.hostId === hostId && proxy.instance === m.header.o && !seen.has(proxy.viewerId)) {
      proxy.forget();
      detachBrowser(hostId, proxy.terminalId, proxy);
    }
  }
}

// ── Viewer side: viewers here of a daemon owned elsewhere ────────────────────

interface HomeViewer {
  viewerId: string;
  terminalId: string;
  hostId: string;
  /** The lease holder (daemon connection) it attached through, and its instance. */
  holder: string;
  owner: string;
  socket: RelaySocket;
  /** Its snapshot arrived: live output reaches it from now on. */
  enrolled: boolean;
  /** Its attach was answered (snapshot, error, or close). */
  settled: boolean;
  /** Its `attach` went out: the heartbeat reports it from now on. */
  attached: boolean;
  timer: NodeJS.Timeout | null;
  closed: boolean;
}

const homeViewers = new Map<string, HomeViewer>();
const homeByTerminal = new Map<string, Set<string>>();
/** This instance's subscription to each terminal's channel, by viewer count. */
const termWatches = new Map<
  string,
  { count: number; listener: ReturnType<typeof localBus.listen> }
>();

/** Subscribes to a terminal's channel while this instance has a viewer of it. */
function watchTerm(terminalId: string): Promise<boolean> {
  if (!clustered) return Promise.resolve(true);
  let watch = termWatches.get(terminalId);
  if (!watch) {
    watch = {
      count: 0,
      listener: localBus.listen(localTermOutChannel(terminalId), (m) => onTermOut(terminalId, m)),
    };
    termWatches.set(terminalId, watch);
  }
  watch.count++;
  return watch.listener.ready;
}

function unwatchTerm(terminalId: string): void {
  const watch = termWatches.get(terminalId);
  if (!watch) return;
  if (--watch.count > 0) return;
  termWatches.delete(terminalId);
  watch.listener.close();
}

function onTermOut(terminalId: string, m: BusMessage): void {
  const { header, payload } = m;
  if (header.k === "out") {
    for (const viewerId of homeByTerminal.get(terminalId) ?? []) {
      const hv = homeViewers.get(viewerId);
      if (hv?.enrolled && hv.owner === header.o) safeSend(hv.socket, payload);
    }
    return;
  }
  if (header.k === "notify") {
    deliverNotify(terminalId, payload.toString("utf-8"), header.p !== 0);
    return;
  }
  const hv = typeof header.v === "string" ? homeViewers.get(header.v) : undefined;
  if (!hv || hv.terminalId !== terminalId) return;
  // Only the instance it attached through speaks for its stream; any
  // instance may close it (a new owner that never heard of it).
  if (header.k !== "close" && header.o !== hv.owner) return;
  switch (header.k) {
    case "sb": {
      const g = Array.isArray(header.g) ? saneGrid(header.g[0], header.g[1]) : undefined;
      if (payload.length > 0) {
        if (g) sendToViewer(hv.socket, { type: "replay", cols: g.cols, rows: g.rows });
        safeSend(hv.socket, payload);
      }
      hv.enrolled = true;
      settleHome(hv);
      return;
    }
    case "fr": {
      if (header.j === 1) {
        const text = payload.toString("utf-8");
        safeSend(hv.socket, text);
        // An attach the daemon refused ends in `exit` (the recorded screen) or `error`.
        if (!hv.settled && /^\{"type":"(exit|error)"/.test(text)) settleHome(hv);
      } else {
        safeSend(hv.socket, payload);
      }
      return;
    }
    case "close":
      settleHome(hv);
      try {
        hv.socket.close(
          typeof header.c === "number" ? header.c : 4503,
          typeof header.r === "string" ? header.r : "Host disconnected",
        );
      } catch {
        // ignore
      }
      return;
    case "ping":
      if (hv.socket.readyState === WS_OPEN && hv.socket.ping) {
        try {
          hv.socket.ping();
        } catch {
          // ignore
        }
      }
      return;
    default:
      return;
  }
}

function settleHome(hv: HomeViewer): void {
  hv.settled = true;
  if (hv.timer) clearTimeout(hv.timer);
  hv.timer = null;
}

function forgetHome(hv: HomeViewer): void {
  if (hv.closed) return;
  hv.closed = true;
  settleHome(hv);
  homeViewers.delete(hv.viewerId);
  const set = homeByTerminal.get(hv.terminalId);
  if (set) {
    set.delete(hv.viewerId);
    if (set.size === 0) homeByTerminal.delete(hv.terminalId);
  }
  unwatchTerm(hv.terminalId);
}

/** Close this instance's viewers of a host that stream through another instance (4503: they reconnect). */
function closeHomeViewersOfHost(hostId: string, reason: string, unlessHolder?: string): void {
  for (const hv of [...homeViewers.values()]) {
    if (hv.hostId !== hostId || hv.holder === unlessHolder) continue;
    forgetHome(hv);
    try {
      hv.socket.close(4503, reason);
    } catch {
      // ignore
    }
  }
}

/** What a viewer's socket handler does with its frames, wherever the daemon is. */
export interface ViewerHandle {
  /** Typed bytes (UTF-8 text), for the PTY. */
  input(data: string): void;
  /** `resize`: the PTY at this viewer's size. */
  claim(grid: Grid): void;
  /** `view`: how the viewer sees the terminal. */
  view(report: ViewReport): void;
  /** The viewer answered a ping. */
  pong(): void;
  /** The viewer left. */
  detach(): void;
}

/**
 * Attach a viewer socket to a terminal's live stream, wherever its host's
 * daemon is connected. Null when the host is offline (or, for a daemon on
 * another instance, while the bus is down).
 */
export async function attachViewer(
  hostId: string,
  terminalId: string,
  socket: RelaySocket,
): Promise<ViewerHandle | null> {
  if (localConn(hostId)) return attachHere(hostId, terminalId, socket);
  if (!clustered || !localBus.started) return null;
  const holder = await leaseHolder(hostLeaseKey(hostId));
  if (holder === null) return null;
  // Connected here after all (it reconnected while we looked).
  if (localConn(hostId)) return attachHere(hostId, terminalId, socket);
  if (instanceOfHolder(holder) === INSTANCE_ID) return null; // ours, but the socket just went
  return attachThrough(holder, hostId, terminalId, socket);
}

function attachHere(hostId: string, terminalId: string, socket: RelaySocket): ViewerHandle {
  attachBrowser(hostId, terminalId, socket);
  // Status frames from other instances (a REST kill, a pin) reach this viewer too.
  void watchTerm(terminalId);
  let detached = false;
  return {
    input: (data) => {
      viewerInput(terminalId, socket);
      sendToLocalDaemon(hostId, {
        type: "input",
        terminalId,
        dataB64: Buffer.from(data, "utf-8").toString("base64"),
      });
    },
    claim: (grid) => viewerClaim(hostId, terminalId, socket, grid),
    view: (report) => viewerView(terminalId, socket, report),
    pong: () => viewerPong(terminalId, socket),
    detach: () => {
      if (detached) return;
      detached = true;
      detachBrowser(hostId, terminalId, socket);
      if (clustered) unwatchTerm(terminalId);
    },
  };
}

async function attachThrough(
  holder: string,
  hostId: string,
  terminalId: string,
  socket: RelaySocket,
): Promise<ViewerHandle | null> {
  const hv: HomeViewer = {
    viewerId: randomUUID(),
    terminalId,
    hostId,
    holder,
    owner: instanceOfHolder(holder),
    socket,
    enrolled: false,
    settled: false,
    attached: false,
    timer: null,
    closed: false,
  };
  homeViewers.set(hv.viewerId, hv);
  let set = homeByTerminal.get(terminalId);
  if (!set) {
    set = new Set();
    homeByTerminal.set(terminalId, set);
  }
  set.add(hv.viewerId);
  // Subscribed before asking, so the snapshot can't go by unheard.
  const listening = await watchTerm(terminalId);
  // Somebody (the owner) must hear the attach, or nothing will answer it.
  const heard =
    listening && !hv.closed
      ? await localBus.publishCount(localHostInChannel(hostId), {
          k: "attach",
          h: holder,
          t: terminalId,
          v: hv.viewerId,
        })
      : null;
  if (!heard || hv.closed) {
    forgetHome(hv);
    return null;
  }
  hv.attached = true;
  hv.timer = setTimeout(() => {
    hv.timer = null;
    if (hv.settled || hv.closed) return;
    // The owner never answered (it went away): the viewer retries.
    sendToViewer(hv.socket, { type: "error", message: "Host is offline" });
  }, REMOTE_ATTACH_TIMEOUT_MS);
  hv.timer.unref?.();
  const toOwner = (header: { k: string; [field: string]: unknown }, payload?: Buffer) => {
    if (!hv.closed) {
      void localBus.publish(
        localHostInChannel(hostId),
        { ...header, h: holder, t: terminalId, v: hv.viewerId },
        payload,
      );
    }
  };
  return {
    input: (data) => toOwner({ k: "input" }, Buffer.from(data, "utf-8")),
    claim: (grid) => toOwner({ k: "claim", g: [grid.cols, grid.rows] }),
    view: (report) => toOwner({ k: "view", r: report }),
    pong: () => toOwner({ k: "pong" }),
    detach: () => {
      if (hv.closed) return;
      toOwner({ k: "detach" });
      forgetHome(hv);
    },
  };
}

// ── Heartbeat ────────────────────────────────────────────────────────────────

/**
 * Every VIEWER_HEARTBEAT_MS: report this instance's remote viewers to their
 * hosts' owners, close the ones whose owner no longer holds the host (it
 * went away, or another took over: they reconnect to the new one), and, as
 * an owner, drop remote viewers whose instance stopped reporting them.
 */
let heartbeatRunning: Promise<void> | null = null;

/** One heartbeat at a time: a slow tick is not overlapped by the next. */
function heartbeat(): Promise<void> {
  if (!heartbeatRunning) {
    heartbeatRunning = beat().finally(() => {
      heartbeatRunning = null;
    });
  }
  return heartbeatRunning;
}

async function beat(): Promise<void> {
  const now = Date.now();
  for (const proxy of [...remoteViewers.values()]) {
    if (now - proxy.seenAt > REMOTE_VIEWER_TTL_MS) {
      proxy.forget();
      detachBrowser(proxy.hostId, proxy.terminalId, proxy);
    }
  }
  if (!localBus.started) return;
  const byHost = new Map<string, HomeViewer[]>();
  for (const hv of homeViewers.values()) {
    // An attach still going out is not the owner's to know yet.
    if (!hv.attached || hv.closed) continue;
    const list = byHost.get(hv.hostId) ?? [];
    list.push(hv);
    byHost.set(hv.hostId, list);
  }
  if (byHost.size === 0) return;
  let holders: Map<string, string>;
  try {
    holders = await leaseHolders([...byHost.keys()].map(hostLeaseKey));
  } catch (err) {
    logger.debug({ err }, "local relay heartbeat: lease read failed");
    return;
  }
  for (const [hostId, viewers] of byHost) {
    const holder = holders.get(hostLeaseKey(hostId)) ?? null;
    if (holder === null) {
      closeHomeViewersOfHost(hostId, "Host disconnected");
      continue;
    }
    // Attached through a daemon connection that no longer owns the host.
    closeHomeViewersOfHost(hostId, "Host reconnected", holder);
    const still = viewers.filter((hv) => !hv.closed);
    if (still.length > 0) {
      await localBus.publish(localHostInChannel(hostId), {
        k: "viewers",
        h: holder,
        vs: still.map((hv) => [hv.terminalId, hv.viewerId]),
      });
    }
  }
}

/** The lease holder id of this instance's connection for a host (tests). */
export function hostHolderForTests(hostId: string): string | null {
  return daemonsByHost.get(hostId)?.holder ?? null;
}

/** Runs one heartbeat now (tests). */
export function runRelayHeartbeatForTests(): Promise<void> {
  return heartbeat();
}

/** Renews every host lease this instance holds now, as the renew timer would (tests). */
export async function renewHostLeasesForTests(): Promise<void> {
  await Promise.all([...daemonsByHost.values()].map((conn) => renewHost(conn)));
}

/** Test-only: reset all relay state (and leave cluster mode). */
export function resetRelayForTests(): void {
  for (const conn of daemonsByHost.values()) {
    if (conn.renewTimer) clearInterval(conn.renewTimer);
    conn.inbox?.close();
  }
  daemonsByHost.clear();
  browsersByTerminal.clear();
  pendingAttaches.clear();
  hostByTerminal.clear();
  for (const grid of gridByTerminal.values()) grid.dispose();
  gridByTerminal.clear();
  remoteViewers.clear();
  forwardedRequests.clear();
  replyChains.clear();
  for (const hv of homeViewers.values()) if (hv.timer) clearTimeout(hv.timer);
  homeViewers.clear();
  homeByTerminal.clear();
  for (const watch of termWatches.values()) watch.listener.close();
  termWatches.clear();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  clustered = false;
}
