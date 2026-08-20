/**
 * Daemon uplink for Optio Local (/ws/local/daemon). One outbound connection
 * per host, authenticated like any WS (the CLI's PAT via
 * Sec-WebSocket-Protocol). The first frame must be a `hello` naming a host
 * that belongs to the authenticated user. See docs/optio-local.md.
 */
import type { FastifyInstance } from "fastify";
import type { LocalDaemonMessage } from "@optio/shared";
import { logger } from "../logger.js";
import { authenticateWs } from "./ws-auth.js";
import {
  getClientIp,
  trackConnection,
  releaseConnection,
  isMessageWithinSizeLimit,
  WS_CLOSE_CONNECTION_LIMIT,
  WS_CLOSE_MESSAGE_TOO_LARGE,
} from "./ws-limits.js";
import * as relay from "../services/local-relay.js";
import {
  canAccessHost,
  getHost,
  markHostOnline,
  touchHost,
} from "../services/local-host-service.js";
import * as terminalService from "../services/local-terminal-service.js";

const HELLO_TIMEOUT_MS = 10_000;

export async function localDaemonWs(app: FastifyInstance) {
  app.get("/ws/local/daemon", { websocket: true }, async (socket, req) => {
    const clientIp = getClientIp(req);
    if (!trackConnection(clientIp)) {
      socket.close(WS_CLOSE_CONNECTION_LIMIT, "Too many connections");
      return;
    }

    const user = await authenticateWs(socket, req);
    if (!user) {
      releaseConnection(clientIp);
      return;
    }

    let hostId: string | null = null;
    let closed = false;
    const log = logger.child({ ws: "local-daemon" });

    const helloTimer = setTimeout(() => {
      if (!hostId) socket.close(4408, "Expected hello");
    }, HELLO_TIMEOUT_MS);

    socket.on("message", (raw: Buffer | string) => {
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
      void handleMessage(msg).catch((err) => {
        log.warn({ err, type: msg.type }, "local-daemon: message handling failed");
      });
    });

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
        relay.registerDaemon(host.id, host.userId, socket);
        await markHostOnline(host.id, {
          dirs: msg.dirs,
          daemonVersion: msg.daemonVersion,
        });
        await terminalService.reconcileHello(host.id, msg.terminals ?? []);
        log.info({ hostId: host.id, hostname: host.hostname }, "local daemon connected");
        return;
      }

      if (!hostId) return; // everything else requires a completed hello

      switch (msg.type) {
        case "ping":
          await touchHost(hostId);
          socket.send(JSON.stringify({ type: "pong" }));
          return;
        case "output":
          relay.forwardOutput(msg.terminalId, Buffer.from(msg.dataB64, "base64"));
          return;
        case "scrollback":
          relay.deliverScrollback(msg.attachId, Buffer.from(msg.dataB64, "base64"));
          return;
        case "attach-error":
          relay.deliverAttachError(msg.attachId, msg.message);
          return;
        case "started":
          await terminalService.handleStarted(msg.terminalId);
          return;
        case "spawn-error":
          await terminalService.handleSpawnError(msg.terminalId, msg.message);
          return;
        case "exit":
          await terminalService.handleExit(msg.terminalId, msg.exitCode);
          return;
        case "attention":
          await terminalService.handleAttention(msg.terminalId, msg.state, msg.reason);
          return;
        case "preview":
          await terminalService.handlePreview(msg.terminalId, msg.preview, msg.lastActivityAt);
          return;
        default:
          return;
      }
    }

    socket.on("close", () => {
      if (closed) return;
      closed = true;
      clearTimeout(helloTimer);
      releaseConnection(clientIp);
      if (hostId && relay.unregisterDaemon(hostId, socket)) {
        log.info({ hostId }, "local daemon disconnected");
        void terminalService.handleHostDisconnect(hostId).catch((err) => {
          log.warn({ err, hostId }, "local-daemon: disconnect handling failed");
        });
      }
    });
  });
}
