/**
 * E2E: Optio Local through the real API server.
 *
 * A scripted fake daemon speaks the real /ws/local/daemon protocol (register
 * → hello → spawn ack → output/attention/exit) while a fake browser attaches
 * via /ws/local/terminals/:id/stream. Covers: host registration + liveness,
 * REST spawn → daemon spawn → running, scrollback + live output relay,
 * browser input, attention persistence, exit semantics, and webhook-triggered
 * blueprint spawns with shell-quoted params.
 *
 * Uses Node's global WebSocket (undici) — no extra deps.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;
let wsBase: string;

beforeAll(async () => {
  server = await startApiServer();
  wsBase = server.baseUrl.replace(/^http/, "ws");
}, 150_000);

afterAll(async () => {
  await server?.stop();
});

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return { status: res.status, body: (await res.json()) as T };
}

type Json = Record<string, unknown>;

/** Minimal scripted daemon speaking the /ws/local/daemon protocol. */
class FakeDaemon {
  ws!: WebSocket;
  inbox: Json[] = [];
  private waiters: Array<{ match: (m: Json) => boolean; resolve: (m: Json) => void }> = [];

  async connect(hostId: string, dirs: Json[], terminals: Json[] = []): Promise<void> {
    this.ws = new WebSocket(`${wsBase}/ws/local/daemon`);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("daemon ws failed"));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as Json;
      const idx = this.waiters.findIndex((w) => w.match(msg));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        w.resolve(msg);
      } else {
        this.inbox.push(msg);
      }
    };
    this.send({ type: "hello", hostId, daemonVersion: "0.0.0-e2e", dirs, terminals });
  }

  send(msg: Json): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Await a message matching `match`, checking the inbox first. */
  async next(match: (m: Json) => boolean, timeoutMs = 15_000): Promise<Json> {
    const idx = this.inbox.findIndex(match);
    if (idx >= 0) return this.inbox.splice(idx, 1)[0];
    return new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`fake daemon: timed out waiting for message`)),
        timeoutMs,
      );
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

/** Fake browser viewer for /ws/local/terminals/:id/stream. */
class FakeViewer {
  ws!: WebSocket;
  binary: Buffer[] = [];
  control: Json[] = [];

  async connect(terminalId: string): Promise<void> {
    this.ws = new WebSocket(`${wsBase}/ws/local/terminals/${terminalId}/stream`);
    this.ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("viewer ws failed"));
    });
    this.ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.control.push(JSON.parse(ev.data) as Json);
      else this.binary.push(Buffer.from(ev.data as ArrayBuffer));
    };
  }

  text(): string {
    return Buffer.concat(this.binary).toString("utf-8");
  }

  send(msg: Json): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

const DIRS = [{ path: "/tmp/e2e-repo", repoUrl: "https://github.com/acme/e2e" }];

interface HostBody {
  host: { id: string; state: string; hostname: string };
}
interface TerminalBody {
  terminal: {
    id: string;
    state: string;
    attentionState: string;
    exitCode: number | null;
    spec: { kind: string; command?: string };
  };
}

async function registerHost(hostname: string): Promise<string> {
  const { status, body } = await api<HostBody>("/api/local/hosts/register", {
    method: "POST",
    body: JSON.stringify({ hostname, platform: "darwin", arch: "arm64", dirs: DIRS }),
  });
  expect(status).toBe(200);
  return body.host.id;
}

async function getTerminal(id: string): Promise<TerminalBody["terminal"]> {
  const { body } = await api<TerminalBody>(`/api/local/terminals/${id}`);
  return body.terminal;
}

describe("optio local e2e", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  it("runs the full spawn → stream → input → attention → exit loop", async () => {
    const hostId = await registerHost("e2e-full-loop");
    const daemon = new FakeDaemon();
    cleanups.push(() => daemon.close());
    await daemon.connect(hostId, DIRS);

    await waitFor(async () => {
      const { body } = await api<{ hosts: HostBody["host"][] }>("/api/local/hosts");
      const host = body.hosts.find((h) => h.id === hostId);
      return host?.state === "online" ? host : null;
    });

    // REST spawn → daemon receives spawn → acks started.
    const { status, body } = await api<TerminalBody>("/api/local/terminals", {
      method: "POST",
      body: JSON.stringify({
        hostId,
        dir: "/tmp/e2e-repo",
        spec: { kind: "command", command: "echo hello" },
      }),
    });
    expect(status).toBe(201);
    const terminalId = body.terminal.id;
    expect(body.terminal.state).toBe("launching");

    const spawn = await daemon.next((m) => m.type === "spawn");
    expect(spawn.terminalId).toBe(terminalId);
    expect((spawn.spec as Json).command).toBe("echo hello");
    daemon.send({ type: "started", terminalId });

    await waitFor(async () => ((await getTerminal(terminalId)).state === "running" ? true : null));

    // Browser attaches: daemon gets attach, replies with scrollback, then live output.
    const viewer = new FakeViewer();
    cleanups.push(() => viewer.close());
    await viewer.connect(terminalId);

    const attach = await daemon.next((m) => m.type === "attach");
    expect(attach.terminalId).toBe(terminalId);
    daemon.send({
      type: "scrollback",
      terminalId,
      attachId: attach.attachId,
      dataB64: Buffer.from("$ echo hello\r\n").toString("base64"),
    });
    daemon.send({
      type: "output",
      terminalId,
      dataB64: Buffer.from("hello\r\n").toString("base64"),
    });
    await waitFor(async () => (viewer.text().includes("hello\r\n") ? true : null));
    expect(viewer.text()).toBe("$ echo hello\r\nhello\r\n");

    // Browser input reaches the daemon base64-encoded.
    viewer.send({ type: "input", data: "ls\r" });
    const input = await daemon.next((m) => m.type === "input");
    expect(Buffer.from(String(input.dataB64), "base64").toString()).toBe("ls\r");

    // Resize flows through with sane bounds.
    viewer.send({ type: "resize", cols: 200, rows: 50 });
    const resize = await daemon.next((m) => m.type === "resize");
    expect(resize).toMatchObject({ cols: 200, rows: 50 });

    // Attention persists and is queryable.
    daemon.send({ type: "attention", terminalId, state: "needs_you", reason: "bell" });
    await waitFor(async () =>
      (await getTerminal(terminalId)).attentionState === "needs_you" ? true : null,
    );

    // Exit: manual spawn → idle attention; viewer told.
    daemon.send({ type: "exit", terminalId, exitCode: 0 });
    await waitFor(async () => {
      const t = await getTerminal(terminalId);
      return t.state === "exited" && t.exitCode === 0 && t.attentionState === "idle" ? true : null;
    });
    await waitFor(async () =>
      viewer.control.some((m) => m.type === "exit" && m.exitCode === 0) ? true : null,
    );
  });

  it("accepts a bodiless kill (curl / CLI callers send no JSON body)", async () => {
    const hostId = await registerHost("e2e-bare-kill");
    const daemon = new FakeDaemon();
    await daemon.connect(hostId, DIRS);
    try {
      const created = await api<TerminalBody>("/api/local/terminals", {
        method: "POST",
        body: JSON.stringify({ hostId, dir: "/tmp/e2e-repo", spec: { kind: "shell" } }),
      });
      expect(created.status).toBe(201);
      const id = created.body.terminal.id;
      await daemon.next((m) => m.type === "spawn" && m.terminalId === id);
      daemon.send({ type: "started", terminalId: id });
      await waitFor(async () => (await getTerminal(id)).state === "running");

      const res = await fetch(`${server.baseUrl}/api/local/terminals/${id}/kill`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const kill = await daemon.next((m) => m.type === "kill" && m.terminalId === id);
      expect(kill.signal).toBeUndefined();
    } finally {
      daemon.close();
    }
  });

  it("parks spawns while offline and flushes them on daemon connect", async () => {
    const hostId = await registerHost("e2e-parked");

    const { status, body } = await api<TerminalBody>("/api/local/terminals", {
      method: "POST",
      body: JSON.stringify({ hostId, dir: "/tmp/e2e-repo", spec: { kind: "shell" } }),
    });
    expect(status).toBe(201);
    expect(body.terminal.state).toBe("pending");

    const daemon = new FakeDaemon();
    cleanups.push(() => daemon.close());
    await daemon.connect(hostId, DIRS);

    const spawn = await daemon.next((m) => m.type === "spawn");
    expect(spawn.terminalId).toBe(body.terminal.id);
    await waitFor(async () =>
      (await getTerminal(body.terminal.id)).state === "launching" ? true : null,
    );
  });

  it("rejects spawns outside the host allowlist", async () => {
    const hostId = await registerHost("e2e-allowlist");
    const { status, body } = await api<{ error: string }>("/api/local/terminals", {
      method: "POST",
      body: JSON.stringify({ hostId, dir: "/etc", spec: { kind: "shell" } }),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/allowlist/);
  });

  it("spawns a blueprint via webhook ingress with quoted params", async () => {
    const hostId = await registerHost("e2e-webhook");
    const daemon = new FakeDaemon();
    cleanups.push(() => daemon.close());
    await daemon.connect(hostId, DIRS);

    const { body: bpBody } = await api<{ blueprint: { id: string } }>("/api/local/blueprints", {
      method: "POST",
      body: JSON.stringify({
        name: "e2e-review",
        hostId,
        repoUrl: "https://github.com/acme/e2e",
        commandTemplate: "claude {{prompt}}",
      }),
    });
    const path = `e2e-local-${Date.now()}`;
    const { status: trigStatus } = await api(
      `/api/local/blueprints/${bpBody.blueprint.id}/triggers`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "webhook",
          config: { path },
          paramMapping: { prompt: "$.pull_request.title" },
        }),
      },
    );
    expect(trigStatus).toBe(201);

    const { status, body } = await api<{ terminalId: string }>(`/api/hooks/${path}`, {
      method: "POST",
      body: JSON.stringify({ pull_request: { title: "fix: quote 'this' safely" } }),
    });
    expect(status).toBe(202);
    expect(body.terminalId).toBeTruthy();

    const spawn = await daemon.next((m) => m.type === "spawn");
    expect(spawn.terminalId).toBe(body.terminalId);
    expect((spawn.spec as Json).command).toBe(`claude 'fix: quote '\\''this'\\'' safely'`);
    expect((spawn as Json).dir).toBe("/tmp/e2e-repo");

    const terminal = await getTerminal(body.terminalId);
    expect(terminal.spec.kind).toBe("command");
  });

  it("closes viewers when the daemon disconnects and reconciles on reconnect", async () => {
    const hostId = await registerHost("e2e-reconnect");
    const daemon = new FakeDaemon();
    await daemon.connect(hostId, DIRS);

    const { body } = await api<TerminalBody>("/api/local/terminals", {
      method: "POST",
      body: JSON.stringify({ hostId, dir: "/tmp/e2e-repo", spec: { kind: "shell" } }),
    });
    const terminalId = body.terminal.id;
    await daemon.next((m) => m.type === "spawn");
    daemon.send({ type: "started", terminalId });
    await waitFor(async () => ((await getTerminal(terminalId)).state === "running" ? true : null));

    const viewer = new FakeViewer();
    cleanups.push(() => viewer.close());
    await viewer.connect(terminalId);
    await daemon.next((m) => m.type === "attach");

    // Daemon dies: viewer is closed (4503) and host goes offline.
    const closed = new Promise<number>((resolve) => {
      viewer.ws.onclose = (ev) => resolve(ev.code);
    });
    daemon.close();
    expect(await closed).toBe(4503);
    await waitFor(async () => {
      const { body: hb } = await api<{ hosts: HostBody["host"][] }>("/api/local/hosts");
      return hb.hosts.find((h) => h.id === hostId)?.state === "offline" ? true : null;
    });

    // Daemon restarted with no terminals: the row is reconciled to exited.
    const daemon2 = new FakeDaemon();
    cleanups.push(() => daemon2.close());
    await daemon2.connect(hostId, DIRS, []);
    await waitFor(async () => ((await getTerminal(terminalId)).state === "exited" ? true : null));
  });
});
