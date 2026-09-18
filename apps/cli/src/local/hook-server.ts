import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mapHookEvent } from "./attention.js";

/**
 * Localhost hook receiver for Claude Code hooks. Agent spawns run with
 * OPTIO_LOCAL_DAEMON_PORT / OPTIO_LOCAL_TERMINAL_ID in their environment; the
 * injected settings file makes Claude Code POST hook events back here.
 * Binds 127.0.0.1 only — the daemon never accepts non-local connections.
 */

const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 1000;
const HOOK_PATH_RE = /^\/hook\/([A-Za-z0-9-]{1,100})$/;

export interface HookServer {
  port: number;
  close(): Promise<void>;
}

export function startHookServer(
  onHook: (terminalId: string, hookEventName: string) => void,
): Promise<HookServer> {
  const server: Server = createServer((req, res) => {
    const match = req.method === "POST" ? HOOK_PATH_RE.exec(req.url ?? "") : null;
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const terminalId = match[1];

    let done = false;
    const finish = (status: number) => {
      if (done) return;
      done = true;
      clearTimeout(bodyTimer);
      res.writeHead(status).end();
    };

    const bodyTimer = setTimeout(() => {
      finish(408);
      req.destroy();
    }, BODY_TIMEOUT_MS);

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(413);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => finish(400));
    req.on("end", () => {
      if (done) return;
      let eventName: string | undefined;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
          hook_event_name?: unknown;
        };
        if (typeof body.hook_event_name === "string") eventName = body.hook_event_name;
      } catch {
        // fall through — respond 204, nothing to act on
      }
      if (!eventName) {
        finish(204);
        return;
      }
      // Any hook receipt marks hasHooks; unknown events are attention no-ops.
      const known = mapHookEvent(eventName) !== null;
      finish(known ? 200 : 204);
      onHook(terminalId, eventName);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
            // Don't wait on keep-alive sockets during shutdown.
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

// The ${...} placeholders are expanded by the shell running the hook, from
// the terminal process's environment — not by the daemon.
const HOOK_COMMAND = `curl -sf -m 3 -X POST "http://127.0.0.1:\${OPTIO_LOCAL_DAEMON_PORT}/hook/\${OPTIO_LOCAL_TERMINAL_ID}" --data-binary @- -H 'Content-Type: application/json'`;

/**
 * Write the Claude Code settings file injected via `claude --settings` for
 * agent spawns. Uses the documented hooks schema.
 */
export function writeClaudeHookSettings(path: string): void {
  const hook = { type: "command", command: HOOK_COMMAND };
  const settings = {
    hooks: {
      Stop: [{ hooks: [hook] }],
      Notification: [{ hooks: [hook] }],
      UserPromptSubmit: [{ hooks: [hook] }],
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}
