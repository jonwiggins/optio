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
import { createHmac } from "node:crypto";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

let server: ApiServerHandle;
let wsBase: string;

const GITHUB_WEBHOOK_SECRET = "e2e-github-secret";
const SLACK_SIGNING_SECRET = "e2e-slack-secret";

beforeAll(async () => {
  server = await startApiServer({
    env: { GITHUB_WEBHOOK_SECRET, SLACK_SIGNING_SECRET },
  });
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

  async connect(
    hostId: string,
    dirs: Json[],
    terminals: Json[] = [],
    capabilities: Json = {},
  ): Promise<void> {
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
    this.send({
      type: "hello",
      hostId,
      daemonVersion: "0.0.0-e2e",
      dirs,
      terminals,
      ...capabilities,
    });
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
  /** Every frame in arrival order — "control:<type>" or "binary". */
  order: string[] = [];

  async connect(terminalId: string): Promise<void> {
    this.ws = new WebSocket(`${wsBase}/ws/local/terminals/${terminalId}/stream`);
    this.ws.binaryType = "arraybuffer";
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("viewer ws failed"));
    });
    this.ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data) as Json;
        this.control.push(msg);
        this.order.push(`control:${String(msg.type)}`);
      } else {
        this.binary.push(Buffer.from(ev.data as ArrayBuffer));
        this.order.push("binary");
      }
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
    hostId: string;
    state: string;
    pendingReason: string | null;
    attentionState: string;
    exitCode: number | null;
    spec: { kind: string; command?: string; resumeSessionId?: string };
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

  it("replays the recorded final screen, at its grid, to a viewer opening an exited terminal", async () => {
    const hostId = await registerHost("e2e-snapshot");
    const daemon = new FakeDaemon();
    cleanups.push(() => daemon.close());
    await daemon.connect(hostId, DIRS);

    const { body } = await api<TerminalBody>("/api/local/terminals", {
      method: "POST",
      body: JSON.stringify({
        hostId,
        dir: "/tmp/e2e-repo",
        spec: { kind: "command", command: "make test" },
      }),
    });
    const terminalId = body.terminal.id;
    await daemon.next((m) => m.type === "spawn");
    daemon.send({ type: "started", terminalId });
    await waitFor(async () => ((await getTerminal(terminalId)).state === "running" ? true : null));

    // The daemon's final screen (a TUI drawn for 132×40) precedes its exit.
    const screen = "\x1b[2J\x1b[H┌ make test ┐\r\n│ 12 passed │\r\n└───────────┘\r\n";
    daemon.send({
      type: "snapshot",
      terminalId,
      dataB64: Buffer.from(screen).toString("base64"),
      cols: 132,
      rows: 40,
    });
    daemon.send({ type: "exit", terminalId, exitCode: 0 });
    await waitFor(async () => ((await getTerminal(terminalId)).state === "exited" ? true : null));

    // A viewer arriving after the fact gets: status, the recorded grid, the
    // screen bytes, then exit — in that order, so it lays out before painting.
    const viewer = new FakeViewer();
    cleanups.push(() => viewer.close());
    await viewer.connect(terminalId);
    await waitFor(async () => (viewer.control.some((m) => m.type === "exit") ? true : null));
    expect(viewer.order).toEqual(["control:status", "control:size", "binary", "control:exit"]);
    expect(viewer.control[1]).toMatchObject({ type: "size", cols: 132, rows: 40 });
    expect(viewer.text()).toBe(screen);
    // No live attach for a dead terminal.
    expect(daemon.inbox.some((m) => m.type === "attach")).toBe(false);
  });

  /** A running terminal on a fresh host, plus a viewer whose attach reached the daemon. */
  async function runningTerminalWithPendingViewer(hostname: string) {
    const hostId = await registerHost(hostname);
    const daemon = new FakeDaemon();
    cleanups.push(() => daemon.close());
    await daemon.connect(hostId, DIRS);
    const { body } = await api<TerminalBody>("/api/local/terminals", {
      method: "POST",
      body: JSON.stringify({
        hostId,
        dir: "/tmp/e2e-repo",
        spec: { kind: "command", command: "echo hi" },
      }),
    });
    const terminalId = body.terminal.id;
    await daemon.next((m) => m.type === "spawn");
    daemon.send({ type: "started", terminalId });
    await waitFor(async () => ((await getTerminal(terminalId)).state === "running" ? true : null));

    const viewer = new FakeViewer();
    cleanups.push(() => viewer.close());
    await viewer.connect(terminalId);
    const attach = await daemon.next((m) => m.type === "attach" && m.terminalId === terminalId);
    return { daemon, viewer, terminalId, attachId: String(attach.attachId) };
  }

  const screen = "$ echo hi\r\nhi\r\n";
  const finish = (daemon: FakeDaemon, terminalId: string) => {
    daemon.send({
      type: "snapshot",
      terminalId,
      dataB64: Buffer.from(screen).toString("base64"),
      cols: 100,
      rows: 30,
    });
    daemon.send({ type: "exit", terminalId, exitCode: 0 });
  };
  const refuse = (daemon: FakeDaemon, terminalId: string, attachId: string) =>
    daemon.send({
      type: "attach-error",
      terminalId,
      attachId,
      message: "Unknown terminal — the daemon may have restarted since it ran",
    });

  it("replays the recorded screen when the daemon refuses an attach after the exit", async () => {
    // A command that exits instantly: by the time the attach reaches the
    // daemon, its screen and exit are out and the terminal is forgotten.
    const { daemon, viewer, terminalId, attachId } =
      await runningTerminalWithPendingViewer("e2e-instant-exit");
    finish(daemon, terminalId);
    refuse(daemon, terminalId, attachId);

    await waitFor(async () => (viewer.control.some((m) => m.type === "exit") ? true : null));
    // Nothing about "Unknown terminal"; the finished session as a viewer
    // opening it fresh would see it (status first, so it pins the grid).
    expect(viewer.control.some((m) => m.type === "error")).toBe(false);
    expect(viewer.order).toEqual([
      "control:status",
      "control:status",
      "control:size",
      "binary",
      "control:exit",
    ]);
    expect(viewer.control[1]).toMatchObject({ type: "status", state: "exited" });
    expect(viewer.control[2]).toMatchObject({ type: "size", cols: 100, rows: 30 });
    expect(viewer.text()).toBe(screen);
  });

  it("waits for the exit when an older daemon refuses the attach before sending it", async () => {
    // Daemons before the flush-ordering fix forgot a terminal the moment its
    // process ended, then sent the screen and exit up to 1.5 s later.
    const { daemon, viewer, terminalId, attachId } =
      await runningTerminalWithPendingViewer("e2e-old-daemon-exit");
    refuse(daemon, terminalId, attachId);
    await new Promise((r) => setTimeout(r, 300));
    finish(daemon, terminalId);

    await waitFor(async () => (viewer.control.some((m) => m.type === "exit") ? true : null));
    expect(viewer.control.some((m) => m.type === "error")).toBe(false);
    expect(viewer.order).toEqual([
      "control:status",
      "control:status",
      "control:size",
      "binary",
      "control:exit",
    ]);
    expect(viewer.text()).toBe(screen);
  });

  it("tells a viewer watching a terminal exit the grid its final screen was recorded at", async () => {
    const { daemon, viewer, terminalId, attachId } =
      await runningTerminalWithPendingViewer("e2e-watched-exit");
    daemon.send({
      type: "scrollback",
      terminalId,
      attachId,
      dataB64: Buffer.from("$ make\r\n").toString("base64"),
    });
    await waitFor(async () => (viewer.text() === "$ make\r\n" ? true : null));
    finish(daemon, terminalId);

    await waitFor(async () => (viewer.control.some((m) => m.type === "size") ? true : null));
    // exit, then the recorded grid — clients pin it ("Recorded screen").
    expect(viewer.order.slice(-2)).toEqual(["control:exit", "control:size"]);
    expect(viewer.control.at(-1)).toMatchObject({ type: "size", cols: 100, rows: 30 });
  });

  it("still reports the daemon's error for a terminal that keeps running", async () => {
    const { daemon, viewer, terminalId, attachId } =
      await runningTerminalWithPendingViewer("e2e-refused-live");
    refuse(daemon, terminalId, attachId);
    await waitFor(async () => (viewer.control.some((m) => m.type === "error") ? true : null), {
      timeoutMs: 10_000,
    });
    expect(viewer.control.at(-1)).toMatchObject({
      type: "error",
      message: "Unknown terminal — the daemon may have restarted since it ran",
    });
    expect((await getTerminal(terminalId)).state).toBe("running");
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

  it("spawns a headless agent from a GitHub review request and resumes it as a chat", async () => {
    const hostId = await registerHost("e2e-github");
    const daemon = new FakeDaemon();
    cleanups.push(() => daemon.close());
    await daemon.connect(hostId, DIRS);

    const { body: bpBody } = await api<{ blueprint: { id: string; sessionMode: string } }>(
      "/api/local/blueprints",
      {
        method: "POST",
        body: JSON.stringify({
          name: `e2e-pr-review-${Date.now()}`,
          hostId,
          agent: "claude-code",
          sessionMode: "headless",
          commandTemplate: "Review {{url}} on {{headBranch}}",
        }),
      },
    );
    expect(bpBody.blueprint.sessionMode).toBe("headless");
    const { status: trigStatus, body: trigBody } = await api(
      `/api/local/blueprints/${bpBody.blueprint.id}/triggers`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "github",
          config: { events: ["review_requested"], login: "jon" },
        }),
      },
    );
    expect(trigStatus, JSON.stringify(trigBody)).toBe(201);

    const raw = JSON.stringify({
      action: "review_requested",
      repository: { full_name: "acme/e2e", html_url: "https://github.com/acme/e2e" },
      pull_request: {
        number: 9,
        title: "feat: e2e",
        body: "",
        html_url: "https://github.com/acme/e2e/pull/9",
        user: { login: "alice" },
        head: { ref: "feat/e2e" },
        base: { ref: "main" },
      },
      requested_reviewer: { login: "jon" },
    });
    const sig = `sha256=${createHmac("sha256", GITHUB_WEBHOOK_SECRET).update(raw).digest("hex")}`;
    const res = await fetch(`${server.baseUrl}/api/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sig,
      },
      body: raw,
    });
    expect(res.status).toBe(200);

    const spawn = await daemon.next((m) => m.type === "spawn");
    const spec = spawn.spec as Json;
    expect(spec.kind).toBe("agent");
    expect(spec.mode).toBe("headless");
    expect(spec.prompt).toBe("Review https://github.com/acme/e2e/pull/9 on feat/e2e");
    expect(spawn.dir).toBe("/tmp/e2e-repo"); // the PR's repo → the host's matching folder
    const terminalId = String(spawn.terminalId);

    // The daemon reports the agent's session id, the run finishes, and it's resumable.
    daemon.send({ type: "started", terminalId });
    daemon.send({ type: "session", terminalId, agentSessionId: "sess-e2e-1" });
    daemon.send({ type: "exit", terminalId, exitCode: 0 });
    await waitFor(async () => (await getTerminal(terminalId)).state === "exited");
    const finished = await api<{ terminal: { agentSessionId: string; attentionReason: string } }>(
      `/api/local/terminals/${terminalId}`,
    );
    expect(finished.body.terminal.agentSessionId).toBe("sess-e2e-1");
    expect(finished.body.terminal.attentionReason).toBe("done");

    const { status: resumeStatus, body: resumed } = await api<TerminalBody>(
      `/api/local/terminals/${terminalId}/resume`,
      { method: "POST", body: "{}" },
    );
    expect(resumeStatus, JSON.stringify(resumed)).toBe(201);
    const resumeSpawn = await daemon.next(
      (m) => m.type === "spawn" && m.terminalId === resumed.terminal.id,
    );
    expect((resumeSpawn.spec as Json).resumeSessionId).toBe("sess-e2e-1");
  });

  it("spawns an interactive agent from a Slack channel message", async () => {
    const hostId = await registerHost("e2e-slack");
    const daemon = new FakeDaemon();
    cleanups.push(() => daemon.close());
    await daemon.connect(hostId, DIRS);

    const { body: bpBody } = await api<{ blueprint: { id: string } }>("/api/local/blueprints", {
      method: "POST",
      body: JSON.stringify({
        name: `e2e-slack-${Date.now()}`,
        hostId,
        agent: "claude-code",
        commandTemplate: "Slack ({{permalink}}): {{text}}",
      }),
    });
    await api(`/api/local/blueprints/${bpBody.blueprint.id}/triggers`, {
      method: "POST",
      body: JSON.stringify({
        type: "slack",
        config: { channelId: "C0E2E0001", keyword: "deploy" },
      }),
    });

    const raw = JSON.stringify({
      type: "event_callback",
      event_id: `Ev-${Date.now()}`,
      team_id: "T1",
      event: {
        type: "message",
        channel: "C0E2E0001",
        user: "U1",
        text: "please deploy the fix",
        ts: "1700000000.000100",
      },
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac("sha256", SLACK_SIGNING_SECRET).update(`v0:${ts}:${raw}`).digest("hex")}`;
    const res = await fetch(`${server.baseUrl}/api/webhooks/slack/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": ts,
        "x-slack-signature": sig,
      },
      body: raw,
    });
    expect(res.status).toBe(200);

    const spawn = await daemon.next((m) => m.type === "spawn");
    const spec = spawn.spec as Json;
    expect(spec.kind).toBe("agent");
    expect(spec.mode).toBe("interactive");
    expect(spec.prompt).toBe(
      "Slack (https://slack.com/archives/C0E2E0001/p1700000000000100): please deploy the fix",
    );
    // No repo on the event → the host's first folder.
    expect(spawn.dir).toBe("/tmp/e2e-repo");
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

describe("optio local e2e: machine identity, resume, and backfill", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn();
  });

  const SESSION = "c1545b8e-d116-4761-8921-38509a508395";

  async function register(body: Json): Promise<HostBody["host"]> {
    const res = await api<HostBody>("/api/local/hosts/register", {
      method: "POST",
      body: JSON.stringify({ platform: "darwin", dirs: DIRS, ...body }),
    });
    expect(res.status).toBe(200);
    return res.body.host;
  }

  /** An agent session that ran on the host and ended (SIGTERM), having reported its session id. */
  async function finishedAgentSession(daemon: FakeDaemon, hostId: string): Promise<string> {
    const { body } = await api<TerminalBody>("/api/local/terminals", {
      method: "POST",
      body: JSON.stringify({
        hostId,
        dir: "/tmp/e2e-repo",
        spec: { kind: "agent", agent: "claude-code", prompt: "Triage PR #607" },
      }),
    });
    const terminalId = body.terminal.id;
    await daemon.next((m) => m.type === "spawn" && m.terminalId === terminalId);
    daemon.send({ type: "started", terminalId });
    daemon.send({ type: "session", terminalId, agentSessionId: SESSION });
    daemon.send({ type: "exit", terminalId, exitCode: 143 });
    await waitFor(async () => ((await getTerminal(terminalId)).state === "exited" ? true : null));
    return terminalId;
  }

  it("keeps a machine through a hostname change, resumes once, and merges a machine registered twice", async () => {
    // First paired before daemons sent their id; a session ran and ended there.
    const old = await register({ hostname: "e2e-M1-Macbook.local" });
    const oldDaemon = new FakeDaemon();
    cleanups.push(() => oldDaemon.close());
    await oldDaemon.connect(old.id, DIRS);
    const finished = await finishedAgentSession(oldDaemon, old.id);
    oldDaemon.close();

    // The hostname changed under that old daemon: a second row.
    const current = await register({ hostname: "e2e-MacBookPro" });
    expect(current.id).not.toBe(old.id);
    // From here the daemon sends the id it was given: the next rename keeps it.
    const renamed = await register({ hostname: "e2e-MacBookPro-2", hostId: current.id });
    expect(renamed).toMatchObject({ id: current.id, hostname: "e2e-MacBookPro-2" });

    // Resume on the old row waits for that machine — once, however often it's asked.
    await waitFor(async () => {
      const { body } = await api<{ hosts: HostBody["host"][] }>("/api/local/hosts");
      return body.hosts.find((h) => h.id === old.id)?.state === "offline" ? true : null;
    });
    const first = await api<TerminalBody & { reused: boolean }>(
      `/api/local/terminals/${finished}/resume`,
      { method: "POST", body: "{}" },
    );
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      reused: false,
      terminal: { state: "pending", pendingReason: "host_offline" },
    });
    const second = await api<TerminalBody & { reused: boolean }>(
      `/api/local/terminals/${finished}/resume`,
      { method: "POST", body: "{}" },
    );
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ reused: true, terminal: { id: first.body.terminal.id } });

    // A connected machine can't be merged away.
    const daemon = new FakeDaemon();
    cleanups.push(() => daemon.close());
    await daemon.connect(current.id, DIRS);
    await waitFor(async () => {
      const { body } = await api<{ hosts: HostBody["host"][] }>("/api/local/hosts");
      return body.hosts.find((h) => h.id === current.id)?.state === "online" ? true : null;
    });
    const refused = await api<{ error: string }>(`/api/local/hosts/${current.id}/merge`, {
      method: "POST",
      body: JSON.stringify({ intoHostId: old.id }),
    });
    expect(refused.status).toBe(409);
    const self = await api<{ error: string }>(`/api/local/hosts/${old.id}/merge`, {
      method: "POST",
      body: JSON.stringify({ intoHostId: old.id }),
    });
    expect(self.status).toBe(400);

    // Merge the old row into the current machine: its sessions move, and the
    // resume that was waiting starts there as `claude --resume`.
    const merged = await api<{ host: HostBody["host"]; moved: Json }>(
      `/api/local/hosts/${old.id}/merge`,
      { method: "POST", body: JSON.stringify({ intoHostId: current.id }) },
    );
    expect(merged.status).toBe(200);
    expect(merged.body.moved).toEqual({ terminals: 2, automations: 0, runLocations: 0 });
    const spawn = await daemon.next(
      (m) => m.type === "spawn" && m.terminalId === first.body.terminal.id,
    );
    expect((spawn.spec as Json).resumeSessionId).toBe(SESSION);
    expect((await getTerminal(finished)).hostId).toBe(current.id);
    const { body: hosts } = await api<{ hosts: HostBody["host"][] }>("/api/local/hosts");
    expect(hosts.hosts.some((h) => h.id === old.id)).toBe(false);
  });

  it("reads a finished session's conversation off its machine when it was never streamed", async () => {
    const host = await register({ hostname: "e2e-backfill" });
    const daemon = new FakeDaemon();
    cleanups.push(() => daemon.close());
    await daemon.connect(host.id, DIRS, [], { transcriptBackfill: true });
    const terminalId = await finishedAgentSession(daemon, host.id);

    type Page = { entries: Array<{ seq: number; text: string }>; backfilling: boolean };
    const firstRead = await api<Page>(`/api/local/terminals/${terminalId}/transcript`);
    expect(firstRead.body).toMatchObject({ entries: [], backfilling: true });
    const req = await daemon.next((m) => m.type === "transcript-request");
    expect(req).toMatchObject({ terminalId, agent: "claude-code", agentSessionId: SESSION });

    const entry = (seq: number, role: string, kind: string, text: string) => ({
      seq,
      role,
      kind,
      text,
      detail: null,
      toolName: null,
      toolUseId: null,
      isError: false,
      at: "2026-09-20T03:46:20.000Z",
    });
    daemon.send({
      type: "transcript-backfill",
      requestId: req.requestId,
      terminalId,
      entries: [entry(1, "user", "text", "Triage PR #607"), entry(2, "assistant", "text", "…")],
      done: false,
    });
    daemon.send({
      type: "transcript-backfill",
      requestId: req.requestId,
      terminalId,
      entries: [entry(3, "assistant", "text", "Do not merge.")],
      done: true,
    });
    const page = await waitFor(async () => {
      const { body } = await api<Page>(`/api/local/terminals/${terminalId}/transcript`);
      return body.entries.length === 3 ? body : null;
    });
    expect(page.backfilling).toBe(false);
    expect(page.entries.map((e) => e.text)).toEqual(["Triage PR #607", "…", "Do not merge."]);
  });
  it("adds and removes a machine's directories through its daemon", async () => {
    type HostDirs = HostBody["host"] & { dirs: Json[]; manageDirs?: boolean };
    type DirBody = { host: HostDirs; path: string };
    const hostDirs = async (id: string) => {
      const { body } = await api<{ hosts: HostDirs[] }>("/api/local/hosts");
      return body.hosts.find((h) => h.id === id)!;
    };

    // A daemon that didn't offer (an older CLI, or --no-remote-dirs) is never asked.
    const older = await register({ hostname: "e2e-dirs-older" });
    const olderDaemon = new FakeDaemon();
    cleanups.push(() => olderDaemon.close());
    await olderDaemon.connect(older.id, DIRS);
    await waitFor(async () => ((await hostDirs(older.id)).state === "online" ? true : null));
    const refused = await api<{ error: string }>(`/api/local/hosts/${older.id}/dirs`, {
      method: "POST",
      body: JSON.stringify({ path: "~/src/app" }),
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/optio local add/);
    expect((await hostDirs(older.id)).manageDirs).toBe(false);

    const host = await register({ hostname: "e2e-dirs" });
    const daemon = new FakeDaemon();
    cleanups.push(() => daemon.close());
    await daemon.connect(host.id, DIRS, [], { manageDirs: true });
    await waitFor(async () => ((await hostDirs(host.id)).manageDirs ? true : null));

    // Add: the daemon resolves the path and answers with its whole new list.
    const app = { path: "/Users/e2e/src/app", repoUrl: "git@github.com:acme/app.git" };
    const adding = api<DirBody>(`/api/local/hosts/${host.id}/dirs`, {
      method: "POST",
      body: JSON.stringify({ path: "~/src/app" }),
    });
    const addReq = await daemon.next((m) => m.type === "dirs");
    expect(addReq).toMatchObject({ op: "add", path: "~/src/app" });
    daemon.send({
      type: "dirs-result",
      requestId: addReq.requestId,
      path: app.path,
      dirs: [...DIRS, app],
    });
    const added = await adding;
    expect(added.status).toBe(200);
    expect(added.body.path).toBe(app.path);
    expect(added.body.host.dirs).toEqual([...DIRS, app]);
    expect((await hostDirs(host.id)).dirs).toEqual([...DIRS, app]);

    // Work can start there straight away.
    const spawned = await api<TerminalBody>("/api/local/terminals", {
      method: "POST",
      body: JSON.stringify({ hostId: host.id, dir: app.path, spec: { kind: "shell" } }),
    });
    expect(spawned.body.terminal.state).not.toBe("error");
    await daemon.next((m) => m.type === "spawn" && m.dir === app.path);

    // The machine's refusal is the answer; the list doesn't change.
    const missing = api<{ error: string }>(`/api/local/hosts/${host.id}/dirs`, {
      method: "POST",
      body: JSON.stringify({ path: "/nope" }),
    });
    const missingReq = await daemon.next((m) => m.type === "dirs" && m.path === "/nope");
    daemon.send({
      type: "dirs-result",
      requestId: missingReq.requestId,
      error: "No such directory on this machine: /nope",
    });
    expect((await missing).status).toBe(400);
    expect((await missing).body.error).toMatch(/No such directory/);
    expect((await hostDirs(host.id)).dirs).toEqual([...DIRS, app]);

    // A relative path never reaches the machine.
    const relative = await api<{ error: string }>(`/api/local/hosts/${host.id}/dirs`, {
      method: "POST",
      body: JSON.stringify({ path: "src/app" }),
    });
    expect(relative.status).toBe(400);

    // Remove (a bodiless DELETE, the path in the query).
    const removing = fetch(
      `${server.baseUrl}/api/local/hosts/${host.id}/dirs?path=${encodeURIComponent(app.path)}`,
      { method: "DELETE" },
    );
    const removeReq = await daemon.next((m) => m.type === "dirs" && m.op === "remove");
    expect(removeReq.path).toBe(app.path);
    daemon.send({
      type: "dirs-result",
      requestId: removeReq.requestId,
      path: app.path,
      dirs: DIRS,
    });
    const removed = await removing;
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as DirBody).host.dirs).toEqual(DIRS);

    // Offline: a clear 409, not a hang.
    daemon.close();
    await waitFor(async () => ((await hostDirs(host.id)).manageDirs ? null : true));
    const offline = await api<{ error: string }>(`/api/local/hosts/${host.id}/dirs`, {
      method: "POST",
      body: JSON.stringify({ path: "~/src/app" }),
    });
    expect(offline.status).toBe(409);
    expect(offline.body.error).toMatch(/offline/);
  });
});
