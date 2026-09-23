import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getRuntime } from "../services/container-service.js";
import { getSession, addSessionPr } from "../services/interactive-session-service.js";
import { db } from "../db/client.js";
import { repoPods } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../logger.js";
import type { ContainerHandle, ExecSession } from "@optio/shared";
import { authenticateWs } from "./ws-auth.js";
import { requireWsRole } from "./ws-authz.js";
import { acceptWs } from "./ws-connection.js";
import { isMessageWithinSizeLimit, WS_CLOSE_MESSAGE_TOO_LARGE } from "./ws-limits.js";

const PR_URL_REGEX = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/g;

export async function sessionTerminalWs(app: FastifyInstance) {
  app.get("/ws/sessions/:sessionId/terminal", { websocket: true }, async (socket, req) => {
    // Synchronously, before any await: the client's first resize and any
    // early keystrokes are held until the shell exists (see ws-connection.ts).
    const conn = acceptWs(socket, req);
    if (!conn) return;

    const user = await authenticateWs(socket, req);
    if (!user) return conn.discard();

    const { sessionId } = z.object({ sessionId: z.string() }).parse(req.params);
    const log = logger.child({ sessionId });

    const reject = (error: string) => {
      socket.send(JSON.stringify({ error }));
      socket.close();
      conn.discard();
    };

    const session = await getSession(sessionId);
    if (!session) return reject("Session not found");

    if (session.userId && session.userId !== user.id) {
      socket.close(4403, "Not authorized for this session");
      return conn.discard();
    }

    // The terminal writes straight to a shell in the repo pod — viewers are
    // read-only and must not reach it.
    if (!(await requireWsRole(socket, user, "member", session.workspaceId))) {
      return conn.discard();
    }

    if (session.state !== "active") return reject("Session is not active");
    if (!session.podId) return reject("Session has no pod assigned");

    // Get pod info
    const [pod] = await db.select().from(repoPods).where(eq(repoPods.id, session.podId));
    if (!pod || !pod.podName) {
      return reject(
        "Session pod was cleaned up due to inactivity. Please end this session and start a new one.",
      );
    }
    if (conn.closed) return;

    const rt = getRuntime();
    const handle: ContainerHandle = { id: pod.podId ?? pod.podName, name: pod.podName };

    // Set up worktree and launch shell
    const worktreePath = session.worktreePath ?? "/workspace/repo";
    const branch = session.branch;
    const repoUrl = session.repoUrl;

    const setupScript = [
      "set -e",
      // Wait for repo to be ready
      "for i in $(seq 1 60); do [ -f /workspace/.ready ] && break; sleep 1; done",
      '[ -f /workspace/.ready ] || { echo "Repo not ready"; exit 1; }',
      // Acquire repo lock for worktree setup
      "exec 9>/workspace/.repo-lock",
      "flock 9",
      "cd /workspace/repo",
      "git fetch origin 2>/dev/null || true",
      // Create worktree if not exists
      `if [ ! -d "${worktreePath}" ]; then`,
      `  git branch -D "${branch}" 2>/dev/null || true`,
      `  git worktree add "${worktreePath}" -b "${branch}" origin/$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo main) 2>/dev/null || git worktree add "${worktreePath}" -b "${branch}" HEAD`,
      `fi`,
      "flock -u 9",
      "exec 9>&-",
      // Launch interactive shell in worktree
      `cd "${worktreePath}"`,
      "exec bash -l",
    ].join("\n");

    let execSession: ExecSession | null = null;
    const detectedPrs = new Set<number>();

    // Scan a chunk of terminal output for GitHub PR URLs and register them
    const scanForPrUrls = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      for (const match of text.matchAll(PR_URL_REGEX)) {
        const prNumber = parseInt(match[1], 10);
        if (!detectedPrs.has(prNumber)) {
          detectedPrs.add(prNumber);
          const prUrl = match[0];
          addSessionPr(sessionId, prUrl, prNumber).catch((err) => {
            log.warn({ err, prUrl }, "Failed to register session PR");
          });
          log.info({ prUrl, prNumber }, "Detected PR from session terminal");
        }
      }
    };

    try {
      execSession = await rt.exec(handle, ["bash", "-c", setupScript], { tty: true });
      // Registered before anything else so a client that left while the
      // shell was starting still gets it closed (right away, in that case).
      conn.onClose(() => {
        log.info("Session terminal disconnected");
        execSession?.close();
      });
      if (conn.closed) return;

      // Pipe exec stdout → WebSocket + scan for PR URLs
      execSession.stdout.on("data", (chunk: Buffer) => {
        if (socket.readyState === 1) {
          socket.send(chunk);
        }
        scanForPrUrls(chunk);
      });

      execSession.stderr.on("data", (chunk: Buffer) => {
        if (socket.readyState === 1) {
          socket.send(chunk);
        }
        scanForPrUrls(chunk);
      });

      // Handle exec session end
      execSession.stdout.on("end", () => {
        if (socket.readyState === 1) {
          socket.close();
        }
      });

      // Pipe WebSocket → exec stdin, starting with what arrived during setup.
      conn.ready((data: Buffer | string) => {
        if (!isMessageWithinSizeLimit(data)) {
          socket.close(WS_CLOSE_MESSAGE_TOO_LARGE, "Message too large");
          return;
        }

        const str = typeof data === "string" ? data : data.toString("utf-8");

        // Check for resize messages
        try {
          const parsed = JSON.parse(str);
          if (parsed.type === "resize" && parsed.cols && parsed.rows) {
            execSession?.resize(parsed.cols, parsed.rows);
            return;
          }
        } catch {
          // Not JSON, treat as terminal input
        }

        execSession?.stdin.write(typeof data === "string" ? data : data);
      });
    } catch (err) {
      log.error({ err }, "Failed to start terminal exec session");
      reject("Failed to start terminal");
    }
  });
}
