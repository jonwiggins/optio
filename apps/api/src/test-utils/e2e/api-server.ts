/**
 * Spawns the REAL API server (tsx src/index.ts) for e2e tests: full boot
 * path — migrations, provider seeding, Fastify, all 14 workers — against the
 * calling test file's private Postgres/Redis (inherited via process.env from
 * ./setup.ts), with the container runtime faked (OPTIO_RUNTIME=fake) so agent
 * runs are deterministic scripted NDJSON instead of pods + LLM calls.
 *
 * Usage:
 *   let server: ApiServerHandle;
 *   beforeAll(async () => { server = await startApiServer(); }, 120_000);
 *   afterAll(() => server.stop());
 *   ... await fetch(`${server.baseUrl}/api/jobs`, ...)
 */
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(HERE, "..", "..", "..");
const TSX_BIN = join(API_DIR, "node_modules", ".bin", "tsx");
const MAX_LOG_LINES = 2000;

export interface ApiServerHandle {
  baseUrl: string;
  port: number;
  proc: ChildProcess;
  /** Captured stdout+stderr (ring buffer) — for debugging failed scenarios. */
  logs(): string;
  stop(): Promise<void>;
}

export interface StartApiServerOptions {
  /** Extra/override env vars for the server process. */
  env?: Record<string, string>;
  /** Server log level (default "warn" to keep test output readable). */
  logLevel?: string;
  /** Health-wait timeout in ms (default 90s — first boot compiles via tsx). */
  readyTimeoutMs?: number;
  /** Fixed port (default: an ephemeral free port). */
  port?: number;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not allocate port")));
      }
    });
    srv.on("error", reject);
  });
}

export async function startApiServer(opts: StartApiServerOptions = {}): Promise<ApiServerHandle> {
  const port = opts.port ?? (await getFreePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const lines: string[] = [];

  const proc = spawn(TSX_BIN, ["src/index.ts"], {
    cwd: API_DIR,
    // Own process group: the tsx bin is a wrapper around an inner node
    // process, and SIGKILL to the wrapper alone orphans the actual server.
    // Group-kill (negative pid) reaches both.
    detached: true,
    env: {
      ...process.env,
      API_PORT: String(port),
      API_HOST: "127.0.0.1",
      OPTIO_RUNTIME: "fake",
      OPTIO_ALLOW_FAKE_RUNTIME: "1",
      OPTIO_STATEFULSET_ENABLED: "false",
      OPTIO_AUTH_DISABLED: "true",
      LOG_LEVEL: opts.logLevel ?? "warn",
      // Keep periodic workers quick enough that e2e scenarios never wait on a
      // production-scale interval — EXCEPT the PR watcher: seeded pr_opened
      // tasks point at fake github.com repos, and a fast watcher would hammer
      // the real GitHub API with dummy credentials. Park it; tests that need
      // it can override.
      OPTIO_PR_WATCH_INTERVAL: "3600000",
      OPTIO_EXTERNAL_PR_POLL_INTERVAL_MS: "3600000",
      OPTIO_WORKFLOW_TRIGGER_INTERVAL: "2000",
      OPTIO_HEALTH_CHECK_INTERVAL: "5000",
      OPTIO_STALL_CHECK_INTERVAL: "2000",
      ...opts.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const capture = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length > MAX_LOG_LINES) lines.shift();
    }
  };
  proc.stdout?.on("data", capture);
  proc.stderr?.on("data", capture);

  let exited = false;
  let exitCode: number | null = null;
  proc.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  const killGroup = (signal: NodeJS.Signals) => {
    try {
      if (proc.pid) process.kill(-proc.pid, signal);
    } catch {
      proc.kill(signal);
    }
  };

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 90_000);
  for (;;) {
    if (exited) {
      throw new Error(
        `API server exited before becoming healthy (code ${exitCode}).\n--- server logs ---\n${lines.slice(-60).join("\n")}`,
      );
    }
    if (Date.now() > deadline) {
      killGroup("SIGKILL");
      throw new Error(
        `API server did not become healthy in time.\n--- server logs ---\n${lines.slice(-60).join("\n")}`,
      );
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) {
        const body = (await res.json()) as { healthy?: boolean };
        if (body.healthy) break;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    baseUrl,
    port,
    proc,
    logs: () => lines.join("\n"),
    stop: () =>
      new Promise<void>((resolve) => {
        if (exited) return resolve();
        const killTimer = setTimeout(() => {
          killGroup("SIGKILL");
        }, 10_000);
        proc.once("exit", () => {
          clearTimeout(killTimer);
          resolve();
        });
        killGroup("SIGTERM");
      }),
  };
}

/** Poll `fn` until it returns a truthy value or the timeout elapses. */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms${opts.label ? `: ${opts.label}` : ""}`,
      );
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 300));
  }
}
