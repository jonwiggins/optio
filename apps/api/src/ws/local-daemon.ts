/**
 * Daemon uplink for Optio Local (/ws/local/daemon). One outbound connection
 * per host, authenticated like any WS (the CLI's PAT via
 * Sec-WebSocket-Protocol). The first frame must be a `hello` naming a host
 * that belongs to the authenticated user; the instance it lands on becomes
 * the host's owner (local-relay.ts `claimHost`). See docs/optio-local.md.
 */
import { deliverLimitsResult } from "../services/local-limits-service.js";
import type { FastifyInstance } from "fastify";
import type { LocalDaemonMessage } from "@optio/shared";
import { logger } from "../logger.js";
import { authenticateWs } from "./ws-auth.js";
import { acceptWs } from "./ws-connection.js";
import { isMessageWithinSizeLimit, WS_CLOSE_MESSAGE_TOO_LARGE } from "./ws-limits.js";
import * as relay from "../services/local-relay.js";
import {
  canAccessHost,
  getHost,
  handleAgentLimits,
  handleAgentModels,
  markHostOnline,
  touchHost,
} from "../services/local-host-service.js";
import * as terminalService from "../services/local-terminal-service.js";
import {
  deliverCredentialsResult,
  maybeRefreshOnHello,
} from "../services/local-auth-refresh-service.js";
import { deliverDirsResult } from "../services/local-dirs-service.js";
import { saneGrid } from "../services/local-grid.js";

const HELLO_TIMEOUT_MS = 10_000;

/**
 * A daemon's answer to a request, delivered to the request that is waiting
 * on this instance — whether the daemon is connected here or its owner
 * relayed the answer from another instance.
 */
async function deliverReply(hostId: string, msg: relay.DaemonReply): Promise<void> {
  switch (msg.type) {
    case "credentials-result":
      deliverCredentialsResult(hostId, msg);
      return;
    case "dirs-result":
      deliverDirsResult(hostId, msg);
      return;
    case "limits-refresh-result":
      deliverLimitsResult(hostId, msg);
      return;
    case "transcript-backfill":
      await terminalService.handleTranscriptBackfill(hostId, msg);
      return;
  }
}

// Answers the owner relayed from another instance: in order per host (the
// relay chains them), delivered as if the daemon were connected here.
relay.onForwardedDaemonReply(deliverReply);

export async function localDaemonWs(app: FastifyInstance) {
  app.get("/ws/local/daemon", { websocket: true }, async (socket, req) => {
    // Synchronously, before any await: the daemon sends `hello` the moment
    // the socket opens, while authenticateWs is still looking up its PAT.
    // acceptWs holds those frames until ready() below (see ws-connection.ts).
    const accepted = acceptWs(socket, req);
    if (!accepted) return;
    const conn = accepted; // non-null for the hoisted handleMessage below

    const user = await authenticateWs(socket, req);
    if (!user) return conn.discard();
    if (conn.closed) return;

    let hostId: string | null = null;
    const log = logger.child({ ws: "local-daemon" });

    const helloTimer = setTimeout(() => {
      if (!hostId) socket.close(4408, "Expected hello");
    }, HELLO_TIMEOUT_MS);

    // Serialize message handling per socket. The handlers do async DB writes,
    // so firing them concurrently (void handleMessage) would let frames the
    // daemon sent in order — hello then a spawn ack, or `started` then `exit`
    // — interleave and race their transitions. A promise chain preserves the
    // daemon's frame ordering through the awaits without a global lock.
    let queue: Promise<void> = Promise.resolve();

    const onMessage = (raw: Buffer | string) => {
      if (!isMessageWithinSizeLimit(raw)) {
        socket.close(WS_CLOSE_MESSAGE_TOO_LARGE, "Message too large");
        return;
      }
      let msg: LocalDaemonMessage;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf-8"));
      } catch {
        return;
      }
      queue = queue.then(() =>
        handleMessage(msg).catch((err) => {
          log.warn({ err, type: msg.type }, "local-daemon: message handling failed");
        }),
      );
    };

    async function handleMessage(msg: LocalDaemonMessage): Promise<void> {
      if (msg.type === "hello") {
        if (hostId) return; // duplicate hello
        const host = await getHost(msg.hostId);
        if (!host || !canAccessHost(host, user!.id)) {
          socket.close(4403, "Unknown host or not yours — run `optio local up` to re-register");
          return;
        }
        hostId = host.id;
        clearTimeout(helloTimer);
        // Liveness reconcile runs before the socket is registered: once the
        // relay can route spawns here, a concurrent createTerminal could send
        // one that the reconcile would mistake for an orphan and kill.
        await terminalService.reconcileHello(host.id, msg.terminals ?? [], {
          flushParked: false,
        });
        if (conn.closed) return;
        relay.registerDaemon(host.id, host.userId, socket, {
          claudeCredentials: msg.claudeCredentials === true,
          transcriptBackfill: msg.transcriptBackfill === true,
          manageDirs: msg.manageDirs === true,
          modelProviders: msg.modelProviders === true,
          refreshLimits: msg.refreshLimits === true,
          answersQueries: msg.answersQueries === true,
        });
        // The host's lease and bus channel: from here every API instance
        // routes this host's frames to this socket.
        try {
          await relay.claimHost(host.id, socket);
        } catch (err) {
          log.warn({ err, hostId: host.id }, "local daemon: could not claim the host; closing");
          socket.close(1011, "Could not register the host — reconnecting");
          return;
        }
        if (conn.closed) return;
        await markHostOnline(host.id, {
          dirs: msg.dirs,
          daemonVersion: msg.daemonVersion,
          ...(Array.isArray(msg.awsProfiles) ? { awsProfiles: msg.awsProfiles } : {}),
        });
        // A remote workspace's first hello (docs/remote-workspaces.md): how
        // long it took to come online, and what carried its bundle goes.
        if (host.origin !== "machine") {
          void import("../services/remote-workspace-service.js").then(
            (m) => m.noteRemoteWorkspaceHello(host),
            () => {},
          );
        }
        await terminalService.flushParkedTerminals(host.id);
        log.info({ hostId: host.id, hostname: host.hostname }, "local daemon connected");
        // Off the frame queue: a token refresh round-trips to this daemon
        // and to Anthropic, and must not hold up its next frames.
        if (msg.claudeCredentials === true) {
          void maybeRefreshOnHello(host).catch((err) =>
            log.warn({ err, hostId: host.id }, "token refresh on hello failed"),
          );
        }
        return;
      }

      if (!hostId) return; // everything else requires a completed hello

      switch (msg.type) {
        case "ping":
          await touchHost(hostId);
          socket.send(JSON.stringify({ type: "pong" }));
          return;
        case "output":
          // The relay drops the frame unless this host owns the terminal's
          // live subscription — a daemon can't inject into another host's
          // viewer even though it knows the (broadcast) terminal id.
          relay.forwardOutput(hostId, msg.terminalId, Buffer.from(msg.dataB64, "base64"));
          return;
        case "scrollback":
          // attachId is a server-generated secret only the owning host was
          // told, so no cross-host check is needed here.
          relay.deliverScrollback(
            msg.attachId,
            Buffer.from(msg.dataB64, "base64"),
            saneGrid(msg.cols, msg.rows),
          );
          return;
        case "attach-error":
          // Off the frame queue: it may wait for this terminal's `exit`,
          // which arrives on this same socket behind it.
          void terminalService.handleAttachError(msg.attachId, msg.message).catch((err) => {
            log.warn({ err, attachId: msg.attachId }, "local-daemon: attach-error handling failed");
          });
          return;
        case "size":
          if (Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
            relay.forwardSize(hostId, msg.terminalId, msg.cols, msg.rows);
          }
          return;
        case "started":
          await terminalService.handleStarted(hostId, msg.terminalId);
          return;
        case "spawn-error":
          await terminalService.handleSpawnError(hostId, msg.terminalId, msg.message);
          return;
        case "snapshot":
          // Ordered ahead of the daemon's `exit` on this socket (see the
          // queue above), so a viewer that finds the row exited finds the
          // screen too.
          await terminalService.handleSnapshot(
            hostId,
            msg.terminalId,
            msg.dataB64,
            msg.cols,
            msg.rows,
          );
          return;
        case "exit":
          await terminalService.handleExit(hostId, msg.terminalId, msg.exitCode);
          return;
        case "attention":
          await terminalService.handleAttention(hostId, msg.terminalId, msg.state, msg.reason);
          return;
        case "links":
          await terminalService.handleLinks(hostId, msg.terminalId, msg.links);
          return;
        case "usage":
          await terminalService.handleUsage(hostId, msg.terminalId, msg.usage);
          return;
        case "transcript":
          await terminalService.handleTranscript(hostId, msg.terminalId, msg.entries);
          return;
        case "session":
          await terminalService.handleSession(hostId, msg.terminalId, msg.agentSessionId);
          return;
        case "agent-limits":
          await handleAgentLimits(hostId, msg.limits);
          return;
        case "agent-models":
          await handleAgentModels(hostId, msg.models);
          return;
        case "credentials-result":
        case "dirs-result":
        case "limits-refresh-result":
        case "transcript-backfill":
          // Asked from another instance: the answer goes back there.
          if (relay.forwardDaemonReply(hostId, msg)) return;
          await deliverReply(hostId, msg);
          return;
        case "preview":
          await terminalService.handlePreview(
            hostId,
            msg.terminalId,
            msg.preview,
            msg.lastActivityAt,
          );
          return;
        default:
          return;
      }
    }

    conn.onClose(() => {
      clearTimeout(helloTimer);
      if (!hostId) return;
      const closedHost = hostId;
      // False when a newer connection (here or on another instance)
      // replaced this one: the host is not offline then.
      void relay
        .daemonDisconnected(closedHost, socket)
        .then(async (wasCurrent) => {
          if (!wasCurrent) return;
          log.info({ hostId: closedHost }, "local daemon disconnected");
          await terminalService.handleHostDisconnect(closedHost);
        })
        .catch((err) => {
          log.warn({ err, hostId: closedHost }, "local-daemon: disconnect handling failed");
        });
    });
    // Replays the frames that arrived during auth (hello first), in order.
    conn.ready(onMessage);
  });
}
