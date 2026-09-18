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
  getTerminal,
  handleAttention,
  handleExit,
  handleLinks,
  handleSpawnError,
  handleStarted,
  killTerminal,
  reconcileHello,
  startTerminal,
  sweepStuckLaunching,
} from "./local-terminal-service.js";
import {
  createBlueprint,
  createBlueprintTrigger,
  fireLocalTicketTriggers,
  spawnFromBlueprint,
} from "./local-blueprint-service.js";

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
    await createBlueprintTrigger({
      blueprintId: blueprint.id,
      type: "ticket",
      config: { source: "github", labels: ["local"] },
    });

    const miss = await fireLocalTicketTriggers({
      source: "github",
      externalId: "1",
      title: "no matching label",
      labels: ["bug"],
    });
    expect(miss).toHaveLength(0);

    const hit = await fireLocalTicketTriggers({
      source: "github",
      externalId: "2",
      title: "fix the flaky test",
      labels: ["local", "bug"],
    });
    expect(hit).toHaveLength(1);

    const terminal = await getTerminal(hit[0].terminalId);
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

    const schedule = await createBlueprintTrigger({
      blueprintId: blueprint.id,
      type: "schedule",
      config: { cronExpression: "*/5 * * * *" },
    });
    expect(schedule.nextFireAt).toBeInstanceOf(Date);

    const path = `it-hook-${Math.random().toString(36).slice(2, 8)}`;
    await createBlueprintTrigger({
      blueprintId: blueprint.id,
      type: "webhook",
      config: { path },
    });
    await expect(
      createBlueprintTrigger({ blueprintId: blueprint.id, type: "webhook", config: { path } }),
    ).rejects.toThrow("duplicate_webhook_path");
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
