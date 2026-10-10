/**
 * Several REAL API servers on one database, one Redis and one fake-runtime
 * directory — the scale-out e2e tier (docs/plans/scale-out.md, Testing).
 * Each server is a `startApiServer()` process with its own port and
 * `OPTIO_INSTANCE_ID`; the fake runtime keeps its pods and runs on disk
 * (`OPTIO_FAKE_RUNTIME_DIR`), so a run one server started is there for the
 * next one. Kill a server with SIGKILL and the rest keep serving; add one
 * and it joins the same work.
 *
 * Usage:
 *   let cluster: ApiCluster;
 *   beforeAll(async () => { cluster = await startApiCluster({ size: 2 }); }, 200_000);
 *   afterAll(() => cluster.stop());
 *   const { body } = await cluster.client(0)("/api/jobs", { method: "POST", ... });
 *   await cluster.kill(0);              // SIGKILL, waits for the process to go
 *   await cluster.any()("/api/health"); // round-robins over the live servers
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer, type ApiServerHandle, type StartApiServerOptions } from "./api-server.js";

export interface ApiClusterOptions {
  /** How many servers to boot (≥ 1). */
  size: number;
  /** The fake runtime's directory (default: a fresh temp dir, removed on stop). */
  fakeRuntimeDir?: string;
  /** Extra env for every server (a server's own `OPTIO_INSTANCE_ID` wins). */
  env?: Record<string, string>;
  logLevel?: string;
  readyTimeoutMs?: number;
}

export type ClusterClient = <T = unknown>(
  path: string,
  init?: RequestInit,
) => Promise<{ status: number; body: T }>;

export interface ClusterServer {
  /** `api-<n>`: the server's `OPTIO_INSTANCE_ID` base (the process appends its boot suffix). */
  name: string;
  handle: ApiServerHandle;
  /** False once `kill()` took it down. */
  alive: boolean;
}

export interface ApiCluster {
  readonly servers: ClusterServer[];
  readonly fakeRuntimeDir: string;
  /** The live servers, in boot order. */
  live(): ClusterServer[];
  /** A client bound to server `i` (by boot index, killed or not — a killed one fails). */
  client(i: number): ClusterClient;
  /** A client that round-robins over the live servers. */
  any(): ClusterClient;
  /** Kills server `i` (SIGKILL by default) and waits for its process to be gone. */
  kill(i: number, signal?: NodeJS.Signals): Promise<void>;
  /** Boots another server on the same database and fake directory. */
  add(): Promise<ClusterServer>;
  /** Stops every live server and removes a temp fake directory. */
  stop(): Promise<void>;
}

function makeClient(baseUrl: () => string): ClusterClient {
  return async <T>(path: string, init?: RequestInit) => {
    const res = await fetch(`${baseUrl()}${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
    const text = await res.text();
    let body: T;
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = text as unknown as T;
    }
    return { status: res.status, body };
  };
}

export async function startApiCluster(opts: ApiClusterOptions): Promise<ApiCluster> {
  if (!Number.isInteger(opts.size) || opts.size < 1) throw new Error("size must be ≥ 1");
  const ownsDir = !opts.fakeRuntimeDir;
  const fakeRuntimeDir = opts.fakeRuntimeDir ?? mkdtempSync(join(tmpdir(), "optio-e2e-fake-"));
  const servers: ClusterServer[] = [];
  let next = 0;
  let rr = 0;

  const boot = async (): Promise<ClusterServer> => {
    const name = `api-${next++}`;
    const serverOpts: StartApiServerOptions = {
      logLevel: opts.logLevel,
      readyTimeoutMs: opts.readyTimeoutMs,
      env: {
        ...opts.env,
        OPTIO_FAKE_RUNTIME_DIR: fakeRuntimeDir,
        OPTIO_INSTANCE_ID: name,
      },
    };
    const handle = await startApiServer(serverOpts);
    const server: ClusterServer = { name, handle, alive: true };
    handle.proc.once("exit", () => {
      server.alive = false;
    });
    servers.push(server);
    return server;
  };

  // Boot together: the migration runner's advisory lock serializes what must be.
  await Promise.all(Array.from({ length: opts.size }, () => boot()));
  servers.sort((a, b) => Number(a.name.slice(4)) - Number(b.name.slice(4)));

  const live = () => servers.filter((s) => s.alive);

  const killGroup = (server: ClusterServer, signal: NodeJS.Signals) => {
    const pid = server.handle.proc.pid;
    try {
      if (pid) process.kill(-pid, signal);
      else server.handle.proc.kill(signal);
    } catch {
      server.handle.proc.kill(signal);
    }
  };

  return {
    servers,
    fakeRuntimeDir,
    live,
    client(i) {
      const server = servers[i];
      if (!server) throw new Error(`no server ${i}`);
      return makeClient(() => {
        if (!server.alive) throw new Error(`server ${server.name} was killed`);
        return server.handle.baseUrl;
      });
    },
    any() {
      return makeClient(() => {
        const alive = live();
        if (alive.length === 0) throw new Error("no live server");
        const server = alive[rr++ % alive.length];
        return server.handle.baseUrl;
      });
    },
    async kill(i, signal = "SIGKILL") {
      const server = servers[i];
      if (!server) throw new Error(`no server ${i}`);
      if (!server.alive) return;
      await new Promise<void>((resolve) => {
        server.handle.proc.once("exit", () => resolve());
        killGroup(server, signal);
        // A SIGTERM that is ignored still ends in a SIGKILL.
        if (signal !== "SIGKILL") {
          setTimeout(() => {
            if (server.alive) killGroup(server, "SIGKILL");
          }, 15_000).unref();
        }
      });
      server.alive = false;
    },
    add: boot,
    async stop() {
      await Promise.all(live().map((s) => s.handle.stop()));
      if (ownsDir) rmSync(fakeRuntimeDir, { recursive: true, force: true });
    },
  };
}
