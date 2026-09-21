/**
 * Integration tests for Optio Local services against real Postgres + Redis:
 * host registration/upsert, terminal lifecycle + parking, blueprint spawns
 * with shell-quoted params, ticket triggers, and the liveness sweepers.
 *
 * The relay is in-memory, so a fake daemon socket registered via
 * local-relay drives the real spawn path end to end.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { localTerminals, users } from "../db/schema.js";
import * as relay from "./local-relay.js";
import {
  findHostDirForRepo,
  getHost,
  isDirAllowed,
  listHosts,
  registerHost,
  sweepStaleHosts,
} from "./local-host-service.js";
import {
  createTerminal,
  deleteTerminal,
  flushParkedTerminals,
  getSnapshot,
  getTerminal,
  handleAttention,
  handleExit,
  handleSnapshot,
  handleLinks,
  handleSession,
  handleUsage,
  renameTerminal,
  resumeTerminal,
  handleSpawnError,
  handleStarted,
  killTerminal,
  reconcileHello,
  startTerminal,
  sweepStuckLaunching,
} from "./local-terminal-service.js";
import {
  createBlueprint,
  resolveBlueprintDir,
  spawnFromBlueprint,
} from "./local-blueprint-service.js";
import { createTrigger } from "./trigger-service.js";
import { fireTicketTriggers } from "./trigger-dispatch.js";
import { fireEventTriggers, normalizeGitHubEvent } from "./event-trigger-service.js";
import { createNamedTemplate } from "./prompt-template-service.js";
import { insertRepo, insertWorkspace } from "../test-utils/integration/fixtures.js";

class FakeDaemonSocket implements relay.RelaySocket {
  readyState = 1;
  sent: string[] = [];
  send(data: string | Buffer) {
    this.sent.push(String(data));
  }
  close() {
    this.readyState = 3;
  }
  messages(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const DIRS = [
  { path: "/home/dev/optio", repoUrl: "https://github.com/acme/optio" },
  { path: "/home/dev/scratch" },
];

async function makeHost(hostname = `it-host-${Math.random().toString(36).slice(2, 8)}`) {
  return registerHost({
    userId: null,
    workspaceId: null,
    hostname,
    platform: "darwin",
    arch: "arm64",
    daemonVersion: "0.1.0",
    dirs: DIRS,
  });
}

beforeEach(() => relay.resetRelayForTests());
afterEach(() => relay.resetRelayForTests());

describe("local hosts", () => {
  it("registers and upserts by (user, hostname)", async () => {
    const host = await makeHost("it-upsert");
    expect(host.state).toBe("offline");
    expect(host.dirs).toHaveLength(2);

    const again = await registerHost({
      userId: null,
      workspaceId: null,
      hostname: "it-upsert",
      name: "renamed",
      platform: "darwin",
      dirs: [{ path: "/tmp/only" }],
    });
    expect(again.id).toBe(host.id);
    expect(again.name).toBe("renamed");
    expect(again.dirs).toEqual([{ path: "/tmp/only" }]);
  });

  it("scopes host listings by owner", async () => {
    const [alice] = await db
      .insert(users)
      .values({
        provider: "github",
        externalId: `it-${Math.random()}`,
        email: "alice@example.com",
        displayName: "Alice",
      })
      .returning();

    const devHost = await makeHost("it-scope-dev");
    const aliceHost = await registerHost({
      userId: alice.id,
      workspaceId: null,
      hostname: "it-scope-alice",
      platform: "linux",
      dirs: [],
    });

    const aliceHosts = await listHosts(alice.id);
    expect(aliceHosts.map((h) => h.id)).toContain(aliceHost.id);
    expect(aliceHosts.map((h) => h.id)).not.toContain(devHost.id);

    const devHosts = await listHosts(null);
    expect(devHosts.map((h) => h.id)).toContain(devHost.id);
    expect(devHosts.map((h) => h.id)).not.toContain(aliceHost.id);
  });

  it("enforces the dir allowlist and resolves repo dirs", async () => {
    const host = await makeHost();
    expect(isDirAllowed(host, "/home/dev/optio")).toBe(true);
    expect(isDirAllowed(host, "/home/dev/optio/apps/api")).toBe(true);
    expect(isDirAllowed(host, "/home/dev/optio-other")).toBe(false);
    expect(isDirAllowed(host, "/home/dev/optio/../../etc")).toBe(false);
    expect(isDirAllowed(host, "relative/path")).toBe(false);

    expect(findHostDirForRepo(host, "https://github.com/acme/optio.git")).toBe("/home/dev/optio");
    expect(findHostDirForRepo(host, "https://github.com/acme/unknown")).toBeNull();
  });
});

describe("local terminals", () => {
  it("parks spawns while the host is offline and flushes on hello", async () => {
    const host = await makeHost();
    const terminal = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/scratch",
      spec: { kind: "command", command: "echo hi" },
    });
    expect(terminal.state).toBe("pending");
    expect(terminal.pendingReason).toBe("host_offline");

    const daemon = new FakeDaemonSocket();
    relay.registerDaemon(host.id, null, daemon);
    await reconcileHello(host.id, []);

    const flushed = await getTerminal(terminal.id);
    expect(flushed?.state).toBe("launching");
    const spawn = daemon.messages().find((m) => m.type === "spawn");
    expect(spawn).toMatchObject({ terminalId: terminal.id, dir: "/home/dev/scratch" });
  });

  it("claims a parked row under CAS so concurrent flushes send exactly one spawn", async () => {
    const host = await makeHost();
    const terminal = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/scratch",
      spec: { kind: "shell" },
    });
    expect(terminal.state).toBe("pending");

    const daemon = new FakeDaemonSocket();
    relay.registerDaemon(host.id, null, daemon);
    // A hello flush racing a user-initiated start (or a second flush) must
    // not double-spawn: only the caller that wins pending → launching sends.
    await Promise.all([
      flushParkedTerminals(host.id),
      flushParkedTerminals(host.id),
      startTerminal(terminal).catch(() => undefined),
    ]);

    const spawns = daemon.messages().filter((m) => m.type === "spawn");
    expect(spawns).toHaveLength(1);
    expect((await getTerminal(terminal.id))?.state).toBe("launching");
  });

  it("runs the started → exit lifecycle with attention semantics", async () => {
    const host = await makeHost();
    const daemon = new FakeDaemonSocket();
    relay.registerDaemon(host.id, null, daemon);

    const manual = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "agent", agent: "claude-code", prompt: "fix the bug" },
    });
    expect(manual.state).toBe("launching");

    await handleStarted(host.id, manual.id);
    let row = await getTerminal(manual.id);
    expect(row?.state).toBe("running");
    expect(row?.attentionState).toBe("working");

    await handleExit(host.id, manual.id, 0);
    row = await getTerminal(manual.id);
    expect(row?.state).toBe("exited");
    expect(row?.exitCode).toBe(0);
    // Manual spawns exit quietly...
    expect(row?.attentionState).toBe("idle");
  });

  it("rejects dirs outside the allowlist", async () => {
    const host = await makeHost();
    await expect(
      createTerminal({
        host,
        userId: null,
        workspaceId: null,
        dir: "/etc",
        spec: { kind: "shell" },
      }),
    ).rejects.toThrow(/allowlist/);
  });

  it("hold terminals stay pending until started", async () => {
    const host = await makeHost();
    const daemon = new FakeDaemonSocket();
    relay.registerDaemon(host.id, null, daemon);

    const held = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "shell" },
      hold: true,
    });
    expect(held.state).toBe("pending");
    expect(held.pendingReason).toBe("hold");
    expect(daemon.messages().filter((m) => m.type === "spawn")).toHaveLength(0);

    const started = await startTerminal(held);
    expect(started.state).toBe("launching");
    expect(daemon.messages().filter((m) => m.type === "spawn")).toHaveLength(1);
  });

  it("reconcileHello fails rows the daemon no longer has", async () => {
    const host = await makeHost();
    const daemon = new FakeDaemonSocket();
    relay.registerDaemon(host.id, null, daemon);
    const t = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "command", command: "sleep 999" },
      spawnedBy: "trigger",
    });
    await handleStarted(host.id, t.id);

    await reconcileHello(host.id, []); // daemon restarted: no terminals
    const row = await getTerminal(t.id);
    expect(row?.state).toBe("exited");
    // ...but automation spawns land in the needs-you queue.
    expect(row?.attentionState).toBe("needs_you");
  });

  it("reconcileHello promotes a launching terminal the daemon reports running", async () => {
    const host = await makeHost();
    const daemon = new FakeDaemonSocket();
    relay.registerDaemon(host.id, null, daemon);
    const t = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "command", command: "sleep 999" },
    });
    expect(t.state).toBe("launching");
    // The `started` frame was lost mid-reconnect; hello reports it running.
    await reconcileHello(host.id, [{ terminalId: t.id, running: true }]);
    const row = await getTerminal(t.id);
    expect(row?.state).toBe("running");
  });

  it("ignores daemon frames for a terminal owned by another host", async () => {
    const hostA = await makeHost("it-hostA");
    const hostB = await makeHost("it-hostB");
    relay.registerDaemon(hostA.id, null, new FakeDaemonSocket());
    const t = await createTerminal({
      host: hostA,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "command", command: "sleep 999" },
    });
    await handleStarted(hostA.id, t.id);

    // hostB tries to drive hostA's terminal — every handler must no-op.
    await handleExit(hostB.id, t.id, 0);
    await handleSpawnError(hostB.id, t.id, "spoofed");
    await handleAttention(hostB.id, t.id, "idle", "spoofed");
    const row = await getTerminal(t.id);
    expect(row?.state).toBe("running");
    expect(row?.errorMessage).toBeNull();
  });

  it("started/exit CAS resolves a fast-exiting command to exited, never stuck running", async () => {
    const host = await makeHost();
    relay.registerDaemon(host.id, null, new FakeDaemonSocket());
    const t = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "command", command: "false" },
      spawnedBy: "trigger",
    });
    // Even if the exit UPDATE were to land before started, CAS keeps the row
    // terminal: apply exit first, then a late started must not resurrect it.
    await handleExit(host.id, t.id, 1);
    await handleStarted(host.id, t.id);
    const row = await getTerminal(t.id);
    expect(row?.state).toBe("exited");
    expect(row?.exitCode).toBe(1);
  });

  it("force-exits a running terminal when killed on an offline host", async () => {
    const host = await makeHost();
    relay.registerDaemon(host.id, null, new FakeDaemonSocket());
    const t = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "command", command: "sleep 999" },
    });
    await handleStarted(host.id, t.id);
    relay.resetRelayForTests(); // host goes offline (daemon socket gone)

    await killTerminal((await getTerminal(t.id))!);
    const row = await getTerminal(t.id);
    expect(row?.state).toBe("exited");
    expect(row?.errorMessage).toMatch(/offline/);
    // ...and now deletable.
    await deleteTerminal(row!);
    expect(await getTerminal(t.id)).toBeNull();
  });
});

describe("local terminal snapshots", () => {
  async function runningTerminal(host: Awaited<ReturnType<typeof makeHost>>) {
    relay.registerDaemon(host.id, null, new FakeDaemonSocket());
    const t = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "command", command: "make test" },
    });
    await handleStarted(host.id, t.id);
    return t;
  }

  it("records the final screen from the owning host while the terminal is live", async () => {
    const host = await makeHost();
    const t = await runningTerminal(host);
    const screen = Buffer.from("\x1b[2J\x1b[H$ make test\r\nok\r\n");

    expect(await handleSnapshot(host.id, t.id, screen.toString("base64"), 132, 40)).toBe(true);
    await handleExit(host.id, t.id, 0);

    const snap = await getSnapshot(t.id);
    expect(snap?.cols).toBe(132);
    expect(snap?.rows).toBe(40);
    expect(Buffer.from(snap!.data).equals(screen)).toBe(true);
    // The terminal row itself stays lean — no screen bytes ride on it.
    expect(Object.keys((await getTerminal(t.id))!)).not.toContain("data");
  });

  it("ignores snapshots from another host, after exit, or with bad input", async () => {
    const host = await makeHost();
    const other = await makeHost();
    const t = await runningTerminal(host);
    const b64 = Buffer.from("hello").toString("base64");

    expect(await handleSnapshot(other.id, t.id, b64, 80, 24)).toBe(false);
    expect(await handleSnapshot(host.id, t.id, "", 80, 24)).toBe(false);
    expect(await handleSnapshot(host.id, t.id, b64, 0, 24)).toBe(false);
    expect(await handleSnapshot(host.id, t.id, b64, 80, 1.5)).toBe(false);
    expect(await getSnapshot(t.id)).toBeNull();

    await handleExit(host.id, t.id, 0);
    // A late frame from a stale daemon can't rewrite a finished row's screen.
    expect(await handleSnapshot(host.id, t.id, b64, 80, 24)).toBe(false);
    expect(await getSnapshot(t.id)).toBeNull();
  });

  it("clamps oversize grids and drops screens over the byte cap", async () => {
    const host = await makeHost();
    const t = await runningTerminal(host);
    const big = Buffer.alloc(1024 * 1024 + 1, 0x41).toString("base64");
    expect(await handleSnapshot(host.id, t.id, big, 80, 24)).toBe(false);

    const b64 = Buffer.from("x").toString("base64");
    expect(await handleSnapshot(host.id, t.id, b64, 5000, 5000)).toBe(true);
    expect(await getSnapshot(t.id)).toMatchObject({ cols: 1000, rows: 1000 });
  });

  it("goes away with the terminal", async () => {
    const host = await makeHost();
    const t = await runningTerminal(host);
    await handleSnapshot(host.id, t.id, Buffer.from("bye").toString("base64"), 80, 24);
    await handleExit(host.id, t.id, 0);
    await deleteTerminal((await getTerminal(t.id))!);
    expect(await getSnapshot(t.id)).toBeNull();
  });
});

describe("local terminal links", () => {
  it("persists sanitized daemon links, scoped to the owning host", async () => {
    const host = await makeHost();
    const other = await makeHost("it-links-other");
    const socket = new FakeDaemonSocket();
    relay.registerDaemon(host.id, host.userId, socket);
    const t = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "shell" },
    });
    const good = {
      url: "https://github.com/acme/optio/pull/7",
      kind: "pr",
      provider: "github",
      label: "acme/optio#7",
    };
    await handleLinks(host.id, t.id, [
      good,
      { url: "javascript:alert(1)", kind: "pr", provider: "github", label: "x" },
      { url: "https://github.com/acme/optio/pull/7", kind: "pr", provider: "github", label: "dup" },
      { url: "https://linear.app/a/issue/ENG-1", kind: "issue", provider: "nope", label: "ENG-1" },
      "garbage",
    ]);
    expect((await getTerminal(t.id))!.links).toEqual([good]);

    // Another host can't rewrite them.
    await handleLinks(other.id, t.id, []);
    expect((await getTerminal(t.id))!.links).toEqual([good]);
  });

  it("stores sanitized usage from the owning host only", async () => {
    const host = await makeHost();
    const other = await makeHost();
    const t = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "agent", agent: "claude-code" },
    });
    await handleUsage(host.id, t.id, {
      inputTokens: 10,
      outputTokens: -5, // clamped
      cacheReadTokens: 1000,
      cacheWriteTokens: "nope", // dropped
      turns: 2,
      model: "claude-opus-5",
      costUsd: 0.0123,
      updatedAt: "2026-09-17T00:00:00.000Z",
    });
    expect((await getTerminal(t.id))!.usage).toEqual({
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
      turns: 2,
      model: "claude-opus-5",
      costUsd: 0.0123,
      updatedAt: "2026-09-17T00:00:00.000Z",
    });

    // Zero turns / garbage is ignored; another host can't overwrite.
    await handleUsage(host.id, t.id, { turns: 0 });
    await handleUsage(other.id, t.id, { turns: 9, inputTokens: 1 });
    expect((await getTerminal(t.id))!.usage?.turns).toBe(2);
  });

  it("renames with trimming and a length cap", async () => {
    const host = await makeHost();
    const t = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "shell" },
    });
    const renamed = await renameTerminal(t, "  fix flaky tests  ");
    expect(renamed.title).toBe("fix flaky tests");
    expect((await renameTerminal(renamed, "   ")).title).toBe("fix flaky tests");
    expect((await renameTerminal(renamed, "x".repeat(300))).title).toHaveLength(200);
  });
});

describe("local blueprints", () => {
  it("spawns with shell-quoted params substituted into the template", async () => {
    const host = await makeHost();
    const daemon = new FakeDaemonSocket();
    relay.registerDaemon(host.id, null, daemon);

    const blueprint = await createBlueprint({
      userId: null,
      workspaceId: null,
      name: `bp-${Math.random().toString(36).slice(2, 8)}`,
      hostId: host.id,
      repoUrl: "https://github.com/acme/optio",
      commandTemplate: "claude {{prompt}}",
    });

    const terminal = await spawnFromBlueprint(blueprint, {
      params: { prompt: `review PR; echo '$(whoami)'` },
    });
    expect(terminal.dir).toBe("/home/dev/optio");
    expect(terminal.state).toBe("launching");

    const spawn = daemon.messages().find((m) => m.type === "spawn") as {
      spec: { kind: string; command: string };
    };
    expect(spawn.spec.kind).toBe("command");
    // The param is one single-quoted shell word; embedded quotes escaped.
    expect(spawn.spec.command).toBe(`claude 'review PR; echo '\\''$(whoami)'\\'''`);
  });

  it("agent-mode blueprints emit an agent spec with a raw (un-shell-quoted) prompt", async () => {
    const host = await makeHost();
    const daemon = new FakeDaemonSocket();
    relay.registerDaemon(host.id, null, daemon);

    const blueprint = await createBlueprint({
      userId: null,
      workspaceId: null,
      name: `bp-agent-${Math.random().toString(36).slice(2, 8)}`,
      hostId: host.id,
      dir: "/home/dev/optio",
      agent: "claude-code",
      commandTemplate: "Review PR: {{title}}",
    });

    const terminal = await spawnFromBlueprint(blueprint, {
      params: { title: `fix "it's" broken` },
    });
    const spawn = daemon.messages().find((m) => m.type === "spawn") as {
      spec: { kind: string; agent: string; prompt: string };
    };
    expect(spawn.spec.kind).toBe("agent");
    expect(spawn.spec.agent).toBe("claude-code");
    // Raw substitution — the daemon quotes the whole prompt as one argv element.
    expect(spawn.spec.prompt).toBe(`Review PR: fix "it's" broken`);
    expect(terminal.command).toContain("claude");
  });

  it("fires matching ticket triggers and honors label filters", async () => {
    const host = await makeHost();
    const blueprint = await createBlueprint({
      userId: null,
      workspaceId: null,
      name: `bp-ticket-${Math.random().toString(36).slice(2, 8)}`,
      hostId: host.id,
      dir: "/home/dev/optio",
      commandTemplate: "claude {{ticketTitle}}",
    });
    await createTrigger({
      targetType: "local_blueprint",
      targetId: blueprint.id,
      type: "ticket",
      config: { source: "github", labels: ["local"] },
    });

    const miss = await fireTicketTriggers({
      source: "github",
      externalId: "1",
      title: "no matching label",
      labels: ["bug"],
    });
    expect(miss).toHaveLength(0);

    const hit = await fireTicketTriggers({
      source: "github",
      externalId: "2",
      title: "fix the flaky test",
      labels: ["local", "bug"],
    });
    expect(hit).toHaveLength(1);

    const terminal = await getTerminal(hit[0].id);
    expect(terminal?.spawnedBy).toBe("ticket");
    // Host offline → parked for the next hello.
    expect(terminal?.state).toBe("pending");
    expect((terminal?.spec as { command: string }).command).toBe("claude 'fix the flaky test'");
  });

  it("computes nextFireAt for schedule triggers and rejects duplicate webhook paths", async () => {
    const host = await makeHost();
    const blueprint = await createBlueprint({
      userId: null,
      workspaceId: null,
      name: `bp-trig-${Math.random().toString(36).slice(2, 8)}`,
      hostId: host.id,
      dir: "/home/dev/optio",
      commandTemplate: "true",
    });

    const schedule = await createTrigger({
      targetType: "local_blueprint",
      targetId: blueprint.id,
      type: "schedule",
      config: { cronExpression: "*/5 * * * *" },
    });
    expect(schedule.nextFireAt).toBeInstanceOf(Date);

    const path = `it-hook-${Math.random().toString(36).slice(2, 8)}`;
    await createTrigger({
      targetType: "local_blueprint",
      targetId: blueprint.id,
      type: "webhook",
      config: { path },
    });
    await expect(
      createTrigger({
        targetType: "local_blueprint",
        targetId: blueprint.id,
        type: "webhook",
        config: { path },
      }),
    ).rejects.toThrow("duplicate_webhook_path");
  });
});

describe("local automations (event triggers + session modes)", () => {
  it("resolves the dir from the blueprint, the event's repo, or the host's first folder", () => {
    const host = {
      dirs: [
        { path: "/home/dev/optio", repoUrl: "https://github.com/acme/optio" },
        { path: "/home/dev/scratch" },
      ],
    } as Parameters<typeof resolveBlueprintDir>[1];
    expect(resolveBlueprintDir({ dir: "/x", repoUrl: null }, host)).toBe("/x");
    expect(resolveBlueprintDir({ dir: null, repoUrl: "git@github.com:acme/optio.git" }, host)).toBe(
      "/home/dev/optio",
    );
    expect(
      resolveBlueprintDir({ dir: null, repoUrl: null }, host, "https://github.com/acme/optio"),
    ).toBe("/home/dev/optio");
    // An event about a repo the host doesn't have must not run in some other
    // checkout — null is an error, not a fallback.
    expect(
      resolveBlueprintDir({ dir: null, repoUrl: null }, host, "https://github.com/x/y"),
    ).toBeNull();
    // Only repo-less spawns (Slack, manual) fall back to the first folder.
    expect(resolveBlueprintDir({ dir: null, repoUrl: null }, host)).toBe("/home/dev/optio");
    // A pinned repo the host doesn't have is an error, not a silent fallback.
    expect(resolveBlueprintDir({ dir: null, repoUrl: "https://github.com/x/y" }, host)).toBeNull();
  });

  it("fires a GitHub review-request trigger for the configured login, with event params and a headless spec", async () => {
    const host = await makeHost();
    const daemon = new FakeDaemonSocket();
    relay.registerDaemon(host.id, null, daemon);

    const blueprint = await createBlueprint({
      userId: null,
      workspaceId: null,
      name: `auto-gh-${Math.random().toString(36).slice(2, 8)}`,
      hostId: host.id,
      agent: "claude-code",
      sessionMode: "headless",
      commandTemplate: "Review {{url}} ({{repo}} #{{number}}) on {{headBranch}}",
    });
    await createTrigger({
      targetType: "local_blueprint",
      targetId: blueprint.id,
      type: "github",
      config: { events: ["review_requested"], login: "Jon" },
    });

    const payload = {
      action: "review_requested",
      repository: { full_name: "acme/optio", html_url: "https://github.com/acme/optio" },
      pull_request: {
        number: 7,
        title: "feat: x",
        body: "",
        html_url: "https://github.com/acme/optio/pull/7",
        user: { login: "alice" },
        head: { ref: "feat/x" },
        base: { ref: "main" },
      },
      requested_reviewer: { login: "someone-else" },
    };
    const miss = await fireEventTriggers("github", normalizeGitHubEvent("pull_request", payload)!);
    expect(miss).toHaveLength(0);

    payload.requested_reviewer = { login: "jon" };
    const hit = await fireEventTriggers("github", normalizeGitHubEvent("pull_request", payload)!);
    expect(hit).toHaveLength(1);
    expect(hit[0].matched).toBe("review_requested");

    const terminal = await getTerminal(hit[0].id);
    expect(terminal?.spawnedBy).toBe("trigger");
    expect(terminal?.dir).toBe("/home/dev/optio"); // resolved from the PR's repo
    expect(terminal?.ticketExternalId).toBe("acme/optio#7");
    expect(terminal?.title).toContain("PR #7");
    const spec = terminal?.spec as { kind: string; prompt: string; mode: string };
    expect(spec.kind).toBe("agent");
    expect(spec.mode).toBe("headless");
    expect(spec.prompt).toBe(
      "Review https://github.com/acme/optio/pull/7 (acme/optio #7) on feat/x",
    );
    expect(terminal?.command).toContain("claude -p");
  });

  it("renders a linked saved prompt instead of the inline template", async () => {
    const host = await makeHost();
    relay.registerDaemon(host.id, null, new FakeDaemonSocket());
    const saved = await createNamedTemplate({
      name: `it-prompt-${Math.random().toString(36).slice(2, 8)}`,
      template: "Saved: implement {{identifier}}{{#if commentBody}} — note: {{commentBody}}{{/if}}",
    });
    const blueprint = await createBlueprint({
      userId: null,
      workspaceId: null,
      name: `auto-saved-${Math.random().toString(36).slice(2, 8)}`,
      hostId: host.id,
      agent: "claude-code",
      commandTemplate: "",
      promptTemplateId: saved.id,
    });
    const terminal = await spawnFromBlueprint(blueprint, {
      params: { identifier: "ENG-1", commentBody: "" },
    });
    expect((terminal.spec as { prompt: string }).prompt).toBe("Saved: implement ENG-1");
  });

  it("decides {{#if}} on raw values in command mode, so an empty param drops the block", async () => {
    const host = await makeHost();
    relay.registerDaemon(host.id, null, new FakeDaemonSocket());
    const blueprint = await createBlueprint({
      userId: null,
      workspaceId: null,
      name: `auto-if-${Math.random().toString(36).slice(2, 8)}`,
      hostId: host.id,
      commandTemplate: "run {{a}}{{#if b}} --with {{b}}{{/if}}",
    });
    const empty = await spawnFromBlueprint(blueprint, { params: { a: "x", b: "" } });
    expect((empty.spec as { command: string }).command).toBe("run 'x'");
    const full = await spawnFromBlueprint(blueprint, { params: { a: "x", b: "y z" } });
    expect((full.spec as { command: string }).command).toBe("run 'x' --with 'y z'");
  });

  it("refuses to spawn on a host that belongs to another user", async () => {
    const [owner, other] = await db
      .insert(users)
      .values(
        ["owner", "other"].map((n) => ({
          provider: "github",
          externalId: `it-${n}-${Math.random()}`,
          email: `${n}@example.com`,
          displayName: n,
        })),
      )
      .returning();
    const host = await registerHost({
      userId: owner.id,
      workspaceId: null,
      hostname: `it-host-${Math.random().toString(36).slice(2, 8)}`,
      platform: "darwin",
      arch: "arm64",
      daemonVersion: "0.1.0",
      dirs: DIRS,
    });
    relay.registerDaemon(host.id, owner.id, new FakeDaemonSocket());
    const blueprint = await createBlueprint({
      userId: other.id,
      workspaceId: null,
      name: `auto-steal-${Math.random().toString(36).slice(2, 8)}`,
      hostId: host.id,
      commandTemplate: "id",
    });
    await expect(spawnFromBlueprint(blueprint)).rejects.toThrow(/another user/);
  });

  it("does not fire a registered repo's events into another workspace's automations", async () => {
    const wsA = await insertWorkspace();
    const wsB = await insertWorkspace();
    const repoUrl = `https://github.com/acme/scoped-${Math.random().toString(36).slice(2, 8)}`;
    await insertRepo({
      repoUrl,
      fullName: repoUrl.replace("https://github.com/", ""),
      workspaceId: wsA.id,
    });
    const host = await registerHost({
      userId: null,
      workspaceId: null,
      hostname: `it-host-${Math.random().toString(36).slice(2, 8)}`,
      platform: "darwin",
      arch: "arm64",
      daemonVersion: "0.1.0",
      dirs: [{ path: "/home/dev/scoped", repoUrl }],
    });
    relay.registerDaemon(host.id, null, new FakeDaemonSocket());
    // wsA owns the repo, wsB must not hear about it, and a workspace-less
    // (auth-disabled) blueprint is unscoped and still fires.
    for (const ws of [wsA, wsB, null]) {
      const bp = await createBlueprint({
        userId: null,
        workspaceId: ws?.id ?? null,
        name: `auto-ws-${ws?.id.slice(0, 8) ?? "unscoped"}-${Math.random().toString(36).slice(2, 6)}`,
        hostId: host.id,
        agent: "claude-code",
        commandTemplate: "Review {{url}}",
      });
      await createTrigger({
        targetType: "local_blueprint",
        targetId: bp.id,
        type: "github",
        config: { events: ["pr_opened"] },
      });
    }
    const fired = await fireEventTriggers(
      "github",
      normalizeGitHubEvent("pull_request", {
        action: "opened",
        repository: { full_name: repoUrl.replace("https://github.com/", ""), html_url: repoUrl },
        pull_request: {
          number: 1,
          title: "t",
          body: "",
          html_url: `${repoUrl}/pull/1`,
          user: { login: "alice" },
          head: { ref: "f" },
          base: { ref: "main" },
        },
      })!,
    );
    expect(fired).toHaveLength(2);
    const workspaces = await Promise.all(
      fired.map(async (f) => (await getTerminal(f.id))?.workspaceId ?? null),
    );
    expect(workspaces.sort()).toEqual([wsA.id, null].sort());
  });

  it("records the agent session id, lands headless exits as done, and resumes as a new terminal", async () => {
    const host = await makeHost();
    const daemon = new FakeDaemonSocket();
    relay.registerDaemon(host.id, null, daemon);

    const run = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "agent", agent: "claude-code", prompt: "triage", mode: "headless" },
      spawnedBy: "trigger",
      ticket: { source: "linear", externalId: "ENG-1", url: "https://linear.app/x" },
    });
    await handleStarted(host.id, run.id);
    await handleSession(host.id, run.id, "sess-abc-123");
    await handleSession(host.id, run.id, "not valid!!"); // ignored
    await handleExit(host.id, run.id, 0);

    const done = await getTerminal(run.id);
    expect(done?.agentSessionId).toBe("sess-abc-123");
    expect(done?.attentionState).toBe("needs_you");
    expect(done?.attentionReason).toBe("done");

    const resumed = await resumeTerminal(done!);
    expect(resumed.spawnedBy).toBe("resume");
    expect(resumed.dir).toBe("/home/dev/optio");
    expect(resumed.ticketExternalId).toBe("ENG-1");
    expect(resumed.title.startsWith("↺ ")).toBe(true);
    const spawn = daemon
      .messages()
      .find((m) => m.type === "spawn" && m.terminalId === resumed.id) as {
      spec: { resumeSessionId: string };
    };
    expect(spawn.spec.resumeSessionId).toBe("sess-abc-123");

    // A resumed session that exits goes quiet, like a manual one.
    await handleStarted(host.id, resumed.id);
    await handleExit(host.id, resumed.id, 0);
    expect((await getTerminal(resumed.id))?.attentionState).toBe("idle");

    // Shells and non-headless agents keep the plain "exit" reason.
    const shell = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "command", command: "make test" },
      spawnedBy: "blueprint",
    });
    await handleStarted(host.id, shell.id);
    await handleExit(host.id, shell.id, 0);
    expect((await getTerminal(shell.id))?.attentionReason).toBe("exit");
  });

  it("rejects resume for sessions without a session id", async () => {
    const host = await makeHost();
    const t = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "agent", agent: "gemini" },
    });
    await expect(resumeTerminal(t)).rejects.toThrow(/session id|not supported/);
  });
});

describe("local sweepers", () => {
  it("marks stale hosts offline", async () => {
    const host = await makeHost();
    const daemon = new FakeDaemonSocket();
    relay.registerDaemon(host.id, null, daemon);
    const { markHostOnline } = await import("./local-host-service.js");
    await markHostOnline(host.id, {});

    // Fresh heartbeat → untouched.
    await sweepStaleHosts();
    expect((await getHost(host.id))?.state).toBe("online");

    const { localHosts } = await import("../db/schema.js");
    await db
      .update(localHosts)
      .set({ lastSeenAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(localHosts.id, host.id));
    const swept = await sweepStaleHosts();
    expect(swept).toContain(host.id);
    expect((await getHost(host.id))?.state).toBe("offline");
  });

  it("fails launching terminals the daemon never acked", async () => {
    const host = await makeHost();
    const daemon = new FakeDaemonSocket();
    relay.registerDaemon(host.id, null, daemon);
    const t = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/optio",
      spec: { kind: "shell" },
    });
    expect(t.state).toBe("launching");

    await sweepStuckLaunching();
    expect((await getTerminal(t.id))?.state).toBe("launching"); // still fresh

    await db
      .update(localTerminals)
      .set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(eq(localTerminals.id, t.id));
    await sweepStuckLaunching();
    const row = await getTerminal(t.id);
    expect(row?.state).toBe("error");
    expect(row?.errorMessage).toMatch(/timed out/);
  });
});
