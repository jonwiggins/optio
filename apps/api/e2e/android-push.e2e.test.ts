/**
 * E2E: Android push (FCM) through the real API server.
 *
 * Auth is ENABLED (devices belong to a user, and every push hook keys on the
 * user) with one seeded admin; FCM runs on its fake transport
 * (OPTIO_FCM_TRANSPORT=fake), which appends every HTTP v1 request body to
 * OPTIO_FCM_FAKE_OUTBOX — this file reads that outbox to see exactly what the
 * server would have sent to Google.
 *
 * Covers: device registration / listing / deletion over HTTP, the Watch
 * (`start` when an agent terminal starts running, an alerting `update` when
 * it needs you) driven by a scripted Optio Local daemon, the needs-you alert,
 * repo-task alerts (`[[mock:fail]]` → failed, `[[mock:pr]]` → pr_opened with
 * the PR URL) through the real task pipeline, and the test route.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer, waitFor, type ApiServerHandle } from "../src/test-utils/e2e/api-server.js";

const REPO_URL = "https://github.com/e2e-org/android-push";
const WS_ID = randomUUID();
const USER_ID = randomUUID();
const SESSION = `e2e-android-${randomBytes(16).toString("hex")}`;
/** A realistic registration token: longer than find-my-way's default 100-char param limit. */
const FCM_TOKEN = `eX9mQ1aT0uYp3Lr8Vw2KdZ:APA91bH-Ek_7vQpZ${"Rk3_n".repeat(24)}`;
const DIRS = [{ path: "/tmp/e2e-android", repoUrl: "https://github.com/e2e-org/android-push" }];

let server: ApiServerHandle;
let tmp: string;
let outbox: string;

interface OutboxLine {
  message: {
    token: string;
    data: Record<string, string>;
    android: { priority: string; ttl: string; collapse_key?: string };
  };
}

function sent(): OutboxLine["message"][] {
  if (!existsSync(outbox)) return [];
  return readFileSync(outbox, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as OutboxLine).message)
    .filter((m) => m.token === FCM_TOKEN);
}
const alerts = () => sent().filter((m) => m.data.type === "alert");
const watches = () => sent().filter((m) => m.data.type === "watch");

async function api<T = any>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${server.baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${SESSION}`,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

async function seedAdmin(): Promise<void> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    await sql`INSERT INTO workspaces (id, name, slug) VALUES (${WS_ID}, 'Android push e2e', ${`android-e2e-${WS_ID.slice(0, 8)}`})`;
    await sql`
      INSERT INTO users (id, provider, external_id, email, display_name, default_workspace_id)
      VALUES (${USER_ID}, 'github', 'android-e2e', 'android@push.e2e', 'Android E2E', ${WS_ID})`;
    await sql`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (${WS_ID}, ${USER_ID}, 'admin')`;
    const tokenHash = createHash("sha256").update(SESSION).digest("hex");
    await sql`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${USER_ID}, ${tokenHash}, NOW() + INTERVAL '1 day')`;
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "optio-e2e-fcm-"));
  outbox = join(tmp, "fcm-outbox.jsonl");
  // Bare-pod provisioning shells out to kubectl for a home PVC; a failing shim
  // keeps a live local cluster untouched (see repo-task.e2e.test.ts).
  writeFileSync(join(tmp, "kubectl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  await seedAdmin();
  server = await startApiServer({
    env: {
      OPTIO_AUTH_DISABLED: "false",
      OPTIO_FCM_TRANSPORT: "fake",
      OPTIO_FCM_FAKE_OUTBOX: outbox,
      PATH: `${tmp}:${process.env.PATH ?? ""}`,
      OPTIO_PR_WATCH_INTERVAL: "600000",
    },
  });

  for (const name of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) {
    const res = await api("/api/secrets", {
      method: "POST",
      body: { name, value: `e2e-dummy-${name}`, scope: "global" },
    });
    expect(res.status).toBe(201);
  }
  const repo = await api("/api/repos", {
    method: "POST",
    body: { repoUrl: REPO_URL, fullName: "e2e-org/android-push", defaultBranch: "main" },
  });
  expect(repo.status).toBe(201);
}, 150_000);

afterAll(async () => {
  await server?.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

type Json = Record<string, unknown>;

/** Minimal scripted Optio Local daemon, authenticated with a single-use WS token. */
class FakeDaemon {
  ws!: WebSocket;
  inbox: Json[] = [];
  closed: string | null = null;

  async connect(hostId: string): Promise<void> {
    const { body } = await api<{ token: string }>("/api/auth/ws-token");
    const wsUrl = `${server.baseUrl.replace(/^http/, "ws")}/ws/local/daemon`;
    this.ws = new WebSocket(wsUrl, ["optio-ws-v1", `optio-auth-${body.token}`]);
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("daemon ws failed"));
    });
    this.ws.onmessage = (ev) => this.inbox.push(JSON.parse(String(ev.data)) as Json);
    this.ws.onclose = (ev) => {
      this.closed = `${ev.code} ${ev.reason}`;
    };
    this.hello(hostId);
  }

  /**
   * With auth enabled the server attaches its message handler only after the
   * (async) token check, so a hello sent the instant the socket opens can be
   * missed; callers repeat it until the host shows online (duplicates are ignored).
   */
  hello(hostId: string): void {
    this.send({ type: "hello", hostId, daemonVersion: "0.0.0-e2e", dirs: DIRS, terminals: [] });
  }

  send(msg: Json): void {
    this.ws.send(JSON.stringify(msg));
  }

  next(match: (m: Json) => boolean): Promise<Json> {
    return waitFor(async () => this.inbox.find(match) ?? null, {
      timeoutMs: 15_000,
      label: "daemon message",
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

describe("Android push (FCM) e2e", () => {
  it("registers, lists and re-registers an Android device", async () => {
    const bad = await api("/api/notifications/devices", {
      method: "POST",
      body: { platform: "android", token: "not a token", appId: "dev.optio.android" },
    });
    expect(bad.status).toBe(400);

    const reg = await api("/api/notifications/devices", {
      method: "POST",
      body: {
        platform: "android",
        token: FCM_TOKEN,
        appId: "dev.optio.android",
        appVersion: "0.1.0 (1)",
        deviceName: "Pixel 9",
        serverId: "e2e-server",
      },
    });
    expect(reg.status).toBe(201);
    expect(reg.body.device).toMatchObject({
      platform: "android",
      appId: "dev.optio.android",
      serverId: "e2e-server",
      token: `${FCM_TOKEN.slice(0, 6)}…${FCM_TOKEN.slice(-4)}`,
    });

    const again = await api("/api/notifications/devices", {
      method: "POST",
      body: {
        platform: "android",
        token: FCM_TOKEN,
        appId: "dev.optio.android",
        serverId: "e2e-server",
      },
    });
    expect(again.body.device.id).toBe(reg.body.device.id);

    const list = await api("/api/notifications/devices");
    expect(list.status).toBe(200);
    expect(list.body.push).toEqual({ apns: false, fcm: true });
    expect(list.body.devices).toHaveLength(1);
    expect(list.body.devices[0]).toMatchObject({ id: reg.body.device.id, platform: "android" });
  });

  it("drives the Watch and the needs-you alert from an Optio Local agent terminal", async () => {
    const host = await api<{ host: { id: string } }>("/api/local/hosts/register", {
      method: "POST",
      body: { hostname: "e2e-android-mbp", platform: "darwin", arch: "arm64", dirs: DIRS },
    });
    expect(host.status).toBe(200);
    const hostId = host.body.host.id;
    const daemon = new FakeDaemon();
    try {
      await daemon.connect(hostId);
      await waitFor(
        async () => {
          if (daemon.closed) throw new Error(`daemon socket closed: ${daemon.closed}`);
          const { body } = await api<{ hosts: Array<{ id: string; state: string }> }>(
            "/api/local/hosts",
          );
          if (body.hosts.find((h) => h.id === hostId)?.state === "online") return true;
          daemon.hello(hostId);
          return null;
        },
        { timeoutMs: 15_000, intervalMs: 250, label: "host online" },
      );

      const created = await api<{ terminal: { id: string } }>("/api/local/terminals", {
        method: "POST",
        body: {
          hostId,
          dir: "/tmp/e2e-android",
          spec: { kind: "agent", agent: "claude-code", prompt: "fix the flaky test" },
        },
      });
      expect(created.status).toBe(201);
      const terminalId = created.body.terminal.id;
      await daemon.next((m) => m.type === "spawn" && m.terminalId === terminalId);
      daemon.send({ type: "started", terminalId });

      // Running agent terminal → the Android Watch starts.
      const start = await waitFor(async () => watches().find((w) => w.data.event === "start"), {
        timeoutMs: 15_000,
        label: "watch start",
      });
      expect(start.android).toEqual({ priority: "NORMAL", ttl: "3600s", collapse_key: "watch" });
      expect(start.data.serverId).toBe("e2e-server");
      const startState = JSON.parse(start.data.state);
      expect(startState).toMatchObject({ phase: "working", runningCount: 1, needsYouCount: 0 });
      expect(startState.head).toMatchObject({
        kind: "local",
        id: terminalId,
        link: `optio://local/${terminalId}?compose=1`,
        who: "claude-code",
      });

      // Past the per-device coalescing window, the terminal asks for permission.
      await new Promise((r) => setTimeout(r, 1100));
      daemon.send({
        type: "attention",
        terminalId,
        state: "needs_you",
        reason: "notification",
      });

      const alert = await waitFor(
        async () => alerts().find((a) => a.data.category === "LOCAL_NEEDS_YOU"),
        { timeoutMs: 15_000, label: "needs-you alert" },
      );
      expect(alert.android).toEqual({ priority: "HIGH", ttl: "86400s" });
      expect(alert.data).toMatchObject({
        type: "alert",
        title: "Needs you · e2e-android",
        subtitle: expect.stringContaining("claude-code"), // the terminal's title
        url: `optio://local/${terminalId}?compose=1`,
        kind: "local",
        id: terminalId,
        threadId: terminalId,
        sound: "default",
        timeSensitive: "1",
        collapseId: `local-${terminalId}`,
        serverId: "e2e-server",
      });
      expect(alert.data.body).toMatch(/^Waiting on a permission/);

      const update = await waitFor(
        async () =>
          watches().find(
            (w) => w.data.event === "update" && JSON.parse(w.data.state).phase === "waiting",
          ),
        { timeoutMs: 15_000, label: "alerting watch update" },
      );
      // The queue was empty, so the frame alerts: HIGH priority.
      expect(update.android.priority).toBe("HIGH");
      expect(JSON.parse(update.data.state)).toMatchObject({
        needsYouCount: 1,
        head: { id: terminalId, state: "needs_you", reason: "Waiting on a permission" },
      });
      for (const m of sent())
        for (const v of Object.values(m.data)) expect(typeof v).toBe("string");
    } finally {
      daemon.close();
    }
  });

  it("alerts on a failed task and on an opened PR through the real task pipeline", async () => {
    const create = async (title: string) => {
      const res = await api<{ task: { id: string } }>("/api/tasks", {
        method: "POST",
        body: { title, prompt: `E2E: ${title}`, repoUrl: REPO_URL, agentType: "claude-code" },
      });
      expect(res.status).toBe(201);
      return res.body.task.id;
    };
    const failedId = await create("Android push fails [[mock:fail]]");
    const prId = await create("Android push opens a PR [[mock:pr]]");

    const failed = await waitFor(
      async () =>
        alerts().find((a) => a.data.id === failedId && a.data.category === "TASK_ATTENTION"),
      { timeoutMs: 90_000, label: "task failed alert" },
    );
    expect(failed.data).toMatchObject({
      title: "Task failed",
      url: `optio://tasks/${failedId}`,
      kind: "task",
      threadId: `task-${failedId}`,
      collapseId: `task-${failedId}`,
      sound: "default",
      timeSensitive: "1",
    });
    expect(failed.android.priority).toBe("HIGH");

    const pr = await waitFor(
      async () => alerts().find((a) => a.data.id === prId && a.data.category === "TASK_PR_OPENED"),
      { timeoutMs: 90_000, label: "PR opened alert" },
    );
    expect(pr.data).toMatchObject({ title: "PR opened", url: `optio://tasks/${prId}` });
    expect(pr.data.prUrl).toMatch(/^https:\/\/github\.com\/e2e-org\/android-push\/pull\/\d+$/);
    expect(pr.data.timeSensitive).toBeUndefined();

    const { body } = await api<{ task: { state: string; prUrl: string } }>(`/api/tasks/${prId}`);
    expect(body.task.state).toBe("pr_opened");
    expect(pr.data.prUrl).toBe(body.task.prUrl);
  }, 180_000);

  it("sends a test push, then forgets the device by its raw token", async () => {
    const before = alerts().length;
    const test = await api("/api/notifications/devices/test", { method: "POST" });
    expect(test.status).toBe(200);
    expect(test.body).toEqual({ sent: 1 });
    const testAlert = alerts()[before];
    expect(testAlert.data).toMatchObject({
      category: "TEST",
      body: "If you see this, Android push is working.",
      url: "optio://settings",
    });

    const del = await fetch(
      `${server.baseUrl}/api/notifications/devices/${encodeURIComponent(FCM_TOKEN)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${SESSION}` } },
    );
    expect(del.status).toBe(204);
    const list = await api("/api/notifications/devices");
    expect(list.body.devices).toHaveLength(0);

    const none = await api("/api/notifications/devices/test", { method: "POST" });
    expect(none.body).toEqual({ sent: 0 });
  });
});
