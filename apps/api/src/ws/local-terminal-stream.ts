/**
 * Browser viewer stream for an Optio Local terminal
 * (/ws/local/terminals/:id/stream).
 *
 * Server → client: binary frames are raw terminal bytes (scrollback replay
 * first, then live); JSON text frames are control (status / size / exit /
 * error). An exited terminal gets its recorded final screen instead of a
 * live attach: `size` (the grid it ran at), the screen bytes, then `exit`.
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
import { acceptWs } from "./ws-connection.js";
import { isMessageWithinSizeLimit, WS_CLOSE_MESSAGE_TOO_LARGE } from "./ws-limits.js";
import * as relay from "../services/local-relay.js";
import {
  canAccessTerminal,
  getTerminal,
  replayRecordedScreen,
} from "../services/local-terminal-service.js";

export async function localTerminalStreamWs(app: FastifyInstance) {
  app.get("/ws/local/terminals/:terminalId/stream", { websocket: true }, async (socket, req) => {
    // Synchronously, before any await: keystrokes and the first resize sent
    // while we authenticate are held for ready() below (see ws-connection.ts).
    const conn = acceptWs(socket, req);
    if (!conn) return;

    const user = await authenticateWs(socket, req);
    if (!user) return conn.discard();

    const { terminalId } = z.object({ terminalId: z.string().uuid() }).parse(req.params);
    const log = logger.child({ terminalId, ws: "local-terminal" });

    const terminal = await getTerminal(terminalId);
    if (!terminal) {
      socket.send(JSON.stringify({ type: "error", message: "Terminal not found" }));
      socket.close();
      return conn.discard();
    }
    if (!canAccessTerminal(terminal, user.id)) {
      socket.close(4403, "Not authorized for this terminal");
      return conn.discard();
    }
    // The stream writes straight to a PTY on the owner's machine — read-only
    // viewers must not reach it.
    if (!(await requireWsRole(socket, user, "member", terminal.workspaceId))) {
      return conn.discard();
    }
    if (conn.closed) return;

    socket.send(
      JSON.stringify({
        type: "status",
        state: terminal.state,
        attentionState: terminal.attentionState,
      }),
    );

    if (terminal.state === "running" || terminal.state === "launching") {
      if (relay.attachBrowser(terminal.hostId, terminal.id, socket)) {
        conn.onClose(() => relay.detachBrowser(terminal.hostId, terminal.id, socket));
      } else {
        socket.send(JSON.stringify({ type: "error", message: "Host is offline" }));
      }
    } else if (terminal.state === "exited" || terminal.state === "error") {
      // Scrollback died with the PTY; replay the screen the daemon recorded
      // at exit, announcing its grid first so the viewer lays it out at the
      // size it was drawn for. Older rows have no snapshot and get only the
      // exit frame (the pane shows its text preview instead).
      await replayRecordedScreen(socket, terminal, { withStatus: false });
    }

    conn.onClose(() => log.debug("local terminal viewer disconnected"));
    conn.ready((raw) => {
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
  });
}
