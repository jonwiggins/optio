/**
 * Browser viewer stream for an Optio Local terminal
 * (/ws/local/terminals/:id/stream).
 *
 * Server → client: binary frames are raw terminal bytes (scrollback replay
 * first, then live); JSON text frames are control (status / exit / error).
 * Client → server: JSON only — {type:"input",data} | {type:"resize",cols,rows}.
 * JSON-only input eliminates the "pasted JSON swallowed as control" bug the
 * legacy session terminal protocol has.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LocalStreamClientMessage } from "@optio/shared";
import { logger } from "../logger.js";
import { authenticateWs } from "./ws-auth.js";
import { requireWsRole } from "./ws-authz.js";
import {
  getClientIp,
  trackConnection,
  releaseConnection,
  isMessageWithinSizeLimit,
  WS_CLOSE_CONNECTION_LIMIT,
  WS_CLOSE_MESSAGE_TOO_LARGE,
} from "./ws-limits.js";
import * as relay from "../services/local-relay.js";
import { canAccessTerminal, getTerminal } from "../services/local-terminal-service.js";

export async function localTerminalStreamWs(app: FastifyInstance) {
  app.get("/ws/local/terminals/:terminalId/stream", { websocket: true }, async (socket, req) => {
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

    const { terminalId } = z.object({ terminalId: z.string().uuid() }).parse(req.params);
    const log = logger.child({ terminalId, ws: "local-terminal" });

    const terminal = await getTerminal(terminalId);
    if (!terminal) {
      socket.send(JSON.stringify({ type: "error", message: "Terminal not found" }));
      releaseConnection(clientIp);
      socket.close();
      return;
    }
    if (!canAccessTerminal(terminal, user.id)) {
      socket.close(4403, "Not authorized for this terminal");
      releaseConnection(clientIp);
      return;
    }
    // The stream writes straight to a PTY on the owner's machine — read-only
    // viewers must not reach it.
    if (!(await requireWsRole(socket, user, "member", terminal.workspaceId))) {
      releaseConnection(clientIp);
      return;
    }

    socket.send(
      JSON.stringify({
        type: "status",
        state: terminal.state,
        attentionState: terminal.attentionState,
      }),
    );

    let attached = false;
    if (terminal.state === "running" || terminal.state === "launching") {
      attached = relay.attachBrowser(terminal.hostId, terminal.id, socket);
      if (!attached) {
        socket.send(JSON.stringify({ type: "error", message: "Host is offline" }));
      }
    } else if (terminal.state === "exited" || terminal.state === "error") {
      socket.send(JSON.stringify({ type: "exit", exitCode: terminal.exitCode }));
    }

    socket.on("message", (raw: Buffer | string) => {
      if (!isMessageWithinSizeLimit(raw)) {
        socket.close(WS_CLOSE_MESSAGE_TOO_LARGE, "Message too large");
        return;
      }
      let msg: LocalStreamClientMessage;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf-8"));
      } catch {
        return;
      }
      if (msg.type === "input" && typeof msg.data === "string") {
        relay.sendToHost(terminal.hostId, {
          type: "input",
          terminalId: terminal.id,
          dataB64: Buffer.from(msg.data, "utf-8").toString("base64"),
        });
      } else if (
        msg.type === "resize" &&
        Number.isInteger(msg.cols) &&
        Number.isInteger(msg.rows) &&
        msg.cols > 0 &&
        msg.rows > 0
      ) {
        relay.sendToHost(terminal.hostId, {
          type: "resize",
          terminalId: terminal.id,
          cols: Math.min(msg.cols, 1000),
          rows: Math.min(msg.rows, 1000),
        });
      }
    });

    socket.on("close", () => {
      releaseConnection(clientIp);
      if (attached) relay.detachBrowser(terminal.hostId, terminal.id, socket);
      log.debug("local terminal viewer disconnected");
    });
  });
}
