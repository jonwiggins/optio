/**
 * Remote workspaces (docs/remote-workspaces.md), with Coder, against real
 * Postgres: one connection per scope, the pre-registered machine the
 * workspace's daemon claims by id (keeping the checkout allowlisted), the
 * watcher's query over pairing tokens, a resumed run waking a stopped
 * workspace, the stop when its Task settles, and the idle stop. Coder itself
 * is a mocked fetch.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { TaskState } from "@optio/shared";
import { db } from "../db/client.js";
import {
  apiKeys,
  remoteWorkspaceConnections,
  localHosts,
  tasks,
  teams,
  users,
} from "../db/schema.js";
import { setOutboundDefaults } from "../utils/outbound-url.js";
import { insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";

vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: vi.fn().mockRejectedValue(new Error("no token in tests")),
}));

import * as relay from "./local-relay.js";
import { deleteHost, getHost, markHostOnline, registerHost } from "./local-host-service.js";
import type { Actor } from "./ownership.js";
import * as taskService from "./task-service.js";
import {
  createConnection,
  listConnections,
  onRemoteWorkspaceRunEnded,
  preparePairing,
  resolveConnectionFor,
  startRemoteWorkspaceWork,
  sweepStartingRemoteWorkspaces,
  sweepIdleRemoteWorkspaces,
  wakeRemoteWorkspaceWork,
} from "./remote-workspace-service.js";

let actor: Actor;
let admin: Actor;
let restore: () => void;
const answers: Array<(url: string, init: RequestInit) => Response> = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function insertUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "oidc",
      externalId: `it-${name}-${Math.random()}`,
      email: `${name}@example.com`,
      displayName: name,
    })
    .returning();
  return row;
}

beforeEach(async () => {
  relay.resetRelayForTests();
  const ws = await insertWorkspace();
  const dev = await insertUser("dev");
  const boss = await insertUser("boss");
  actor = { userId: dev.id, workspaceId: ws.id, isAdmin: false, teamIds: [], adminTeamIds: [] };
  admin = { ...actor, userId: boss.id, isAdmin: true };
  answers.length = 0;
  restore = setOutboundDefaults({
    resolveHost: async () => [{ address: "10.20.0.5", family: 4 }],
    policy: { allowPrivate: true, allowedHosts: [], allowAll: false },
    fetchImpl: async (url, init) => {
      const next = answers.shift();
      if (!next) throw new Error("unexpected Coder request");
      return next(url, init);
    },
  });
});

afterEach(() => {
  restore();
  relay.resetRelayForTests();
  delete process.env.OPTIO_CODER_IDLE_STOP_MS;
});

describe("Coder connections", () => {
  it("keep one per scope and resolve the person's over the organization's", async () => {
    const org = await createConnection(
      {
        provider: "coder",
        name: "Org",
        url: "https://coder.example.com",
        token: "org-token-12345",
      },
      admin,
    );
    await expect(
      createConnection(
        {
          provider: "coder",
          name: "Org 2",
          url: "https://coder.example.com",
          token: "org-token-67890",
        },
        admin,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await resolveConnectionFor(actor))?.id).toBe(org.id);

    const mine = await createConnection(
      {
        provider: "coder",
        name: "Mine",
        url: "https://coder.example.com",
        token: "my-token-12345",
        owner: "me",
      },
      actor,
    );
    expect((await resolveConnectionFor(actor))?.id).toBe(mine.id);
    expect((await listConnections(actor)).map((c) => c.id).sort()).toEqual(
      [org.id, mine.id].sort(),
    );
    // The admin sees the organization's, not the person's token.
    expect((await listConnections(admin)).map((c) => c.id)).toEqual([org.id]);
  });

  it("show a team's to its members only — not to its creator once they leave", async () => {
    const [team] = await db
      .insert(teams)
      .values({ workspaceId: actor.workspaceId!, name: "Payments", slug: "payments" })
      .returning();
    const member = { ...actor, teamIds: [team.id], adminTeamIds: [team.id] };
    const conn = await createConnection(
      {
        provider: "coder",
        name: "Team",
        url: "https://coder.example.com",
        token: "team-token-12345",
        owner: `team:${team.id}`,
      },
      member,
    );
    expect((await resolveConnectionFor(member))?.id).toBe(conn.id);
    const left = { ...actor, teamIds: [], adminTeamIds: [] };
    expect(await listConnections(left)).toEqual([]);
    expect(await resolveConnectionFor(left, { connectionId: conn.id })).toBeNull();
  });
});

describe("the Coder machine", () => {
  it("is claimed by its daemon by id and keeps the checkout allowlisted", async () => {
    await createConnection(
      {
        provider: "coder",
        name: "Mine",
        url: "https://coder.example.com",
        token: "my-token-12345",
        owner: "me",
      },
      actor,
    );
    const [conn] = await db.select().from(remoteWorkspaceConnections);
    const { host, bundle, tokenId } = await preparePairing(conn, actor, {
      workspaceName: "optio-fix-1",
      checkoutDir: "/home/coder/repo",
    });
    expect(bundle.OPTIO_LOCAL_HOST_ID).toBe(host.id);
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, tokenId));
    expect(key.name).toBe("coder:optio-fix-1");

    // The daemon registers with the id from its environment and no dirs.
    const claimed = await registerHost({
      userId: actor.userId,
      workspaceId: actor.workspaceId,
      hostname: "optio-fix-1",
      platform: "linux",
      dirs: [],
      hostId: host.id,
    });
    expect(claimed.id).toBe(host.id);
    expect(claimed.name).toBe("optio-fix-1");
    expect(claimed.dirs).toEqual([{ path: "/home/coder/repo" }]);

    await markHostOnline(host.id, { dirs: [{ path: "/tmp/scratch" }] });
    expect((await getHost(host.id))?.dirs.map((d) => d.path).sort()).toEqual([
      "/home/coder/repo",
      "/tmp/scratch",
    ]);
  });

  it("is let go by the watcher when its build failed", async () => {
    await createConnection(
      {
        provider: "coder",
        name: "Mine",
        url: "https://coder.example.com",
        token: "my-token-12345",
        owner: "me",
      },
      actor,
    );
    answers.push(() =>
      json([
        { name: "optio_server", type: "string", mutable: true },
        { name: "optio_token", type: "string", mutable: true },
        { name: "optio_host_id", type: "string", mutable: true },
      ]),
    );
    answers.push(() =>
      json({
        id: "w-1",
        name: "optio-fix-2",
        latest_build: {
          id: "b-1",
          status: "pending",
          transition: "start",
          template_version_id: "tv-1",
        },
      }),
    );
    const started = await startRemoteWorkspaceWork(
      { templateVersionId: "tv-1", name: "optio-fix-2" },
      actor,
    );
    const [row] = await db.select().from(localHosts).where(eq(localHosts.id, started.localHostId));
    expect(row).toMatchObject({ origin: "coder", remoteWorkspaceId: "w-1" });

    // Not yet seen: the watcher asks Coder, which says the build failed.
    answers.push(() =>
      json({
        id: "w-1",
        name: "optio-fix-2",
        latest_build: {
          id: "b-1",
          status: "failed",
          transition: "start",
          template_version_id: "tv-1",
          job: { error: "quota exceeded" },
        },
      }),
    );
    answers.push(() => json({ id: "b-2", status: "pending", transition: "stop" }));
    expect(await sweepStartingRemoteWorkspaces()).toBe(1);

    const [after] = await db.select().from(localHosts).where(eq(localHosts.id, row.id));
    expect(after.pairingTokenId).toBeNull();
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, row.pairingTokenId!));
    expect(key.revokedAt).not.toBeNull();
    // Nothing left to watch.
    expect(await sweepStartingRemoteWorkspaces()).toBe(0);
  });

  it("takes its pairing token with it when it is unpaired", async () => {
    await createConnection(
      {
        provider: "coder",
        name: "Mine",
        url: "https://coder.example.com",
        token: "my-token-12345",
        owner: "me",
      },
      actor,
    );
    const [conn] = await db.select().from(remoteWorkspaceConnections);
    const { host, tokenId } = await preparePairing(conn, actor, {
      workspaceName: "optio-fix-3",
      checkoutDir: "/home/coder/repo",
    });
    expect(await deleteHost(host.id)).toBe(true);
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, tokenId));
    expect(key.revokedAt).not.toBeNull();
  });
});

const PAIRING_PARAMS = [
  { name: "optio_server", type: "string", mutable: true },
  { name: "optio_token", type: "string", mutable: true },
  { name: "optio_host_id", type: "string", mutable: true },
];

/** A Coder machine whose daemon paired once and that has stopped since. */
async function stoppedWorkspace(name: string) {
  const mine = await createConnection(
    {
      provider: "coder",
      name: "Mine",
      url: "https://coder.example.com",
      token: "my-token-12345",
      owner: "me",
    },
    actor,
  );
  const [conn] = await db
    .select()
    .from(remoteWorkspaceConnections)
    .where(eq(remoteWorkspaceConnections.id, mine.id));
  const { host, tokenId } = await preparePairing(conn, actor, {
    workspaceName: name,
    checkoutDir: "/home/coder/repo",
  });
  await db
    .update(localHosts)
    // Workspace ids are unique per test: the file's tests share one database.
    .set({ remoteWorkspaceId: `w-${name}`, lastSeenAt: sql`now()`, state: "offline" })
    .where(eq(localHosts.id, host.id));
  return { host, tokenId };
}

const coderWorkspace = (name: string, status: string, transition: string) =>
  json({
    id: `w-${name}`,
    name,
    owner_id: "cu-1",
    latest_build: { id: "b-1", status, transition, template_version_id: "tv-1" },
  });

describe("a Coder workspace between runs", () => {
  it("is started again, with a fresh pairing token, when a resumed run is dispatched to it", async () => {
    const { host, tokenId } = await stoppedWorkspace("optio-fix-4");
    let build: unknown;
    answers.push(() => coderWorkspace("optio-fix-4", "stopped", "stop"));
    answers.push(() => json({ id: "cu-1", username: "dev" }));
    answers.push(() => json(PAIRING_PARAMS));
    answers.push((_url, init) => {
      build = JSON.parse(String(init.body));
      return json({ id: "b-2", status: "pending", transition: "start" });
    });
    const wake = {
      launch: { templateVersionId: "tv-1" },
      localHostId: host.id,
      localDir: "/home/coder/repo",
      userId: actor.userId,
      workspaceId: actor.workspaceId,
      pin: async (place: { localHostId: string; localDir: string }) => place,
    };
    expect(await wakeRemoteWorkspaceWork(wake)).toEqual({
      localHostId: host.id,
      localDir: "/home/coder/repo",
    });
    expect(answers).toHaveLength(0);
    const sent = build as { transition: string; rich_parameter_values: Array<{ name: string }> };
    expect(sent.transition).toBe("start");
    expect(sent.rich_parameter_values.map((v) => v.name).sort()).toEqual([
      "optio_host_id",
      "optio_server",
      "optio_token",
    ]);

    const [after] = await db.select().from(localHosts).where(eq(localHosts.id, host.id));
    expect(after.pairingTokenId).not.toBeNull();
    expect(after.pairingTokenId).not.toBe(tokenId);
    const [old] = await db.select().from(apiKeys).where(eq(apiKeys.id, tokenId));
    expect(old.revokedAt).not.toBeNull();

    // A second run dispatched while it comes up parks on it: no second start.
    expect(await wakeRemoteWorkspaceWork(wake)).toBeNull();
  });

  it("stays up while its Task may resume, and stops once the Task settles", async () => {
    const { host, tokenId } = await stoppedWorkspace("optio-fix-5");
    const task = await insertTask({
      runTarget: "local",
      localHostId: host.id,
      localDir: "/home/coder/repo",
      state: "pr_opened",
      workspaceId: actor.workspaceId,
      ownerUserId: actor.userId,
    });
    // The run's terminal ended with the merge request open: the workspace stays.
    await onRemoteWorkspaceRunEnded({
      id: randomUUID(),
      hostId: host.id,
      state: "exited",
      taskId: task.id,
      workflowRunId: null,
    });
    expect((await getHost(host.id))?.pairingTokenId).toBe(tokenId);

    // The merge request merged: the task completes, and its workspace goes.
    let build: unknown;
    answers.push((_url, init) => {
      build = JSON.parse(String(init.body));
      return json({ id: "b-3", status: "pending", transition: "stop" });
    });
    await taskService.tryTransitionTask(task.id, TaskState.COMPLETED, "pr_merged");
    // The pairing is cleared first (once, by CAS), then Coder is asked to stop
    // it: wait for both, or a slow run checks the request before it is sent.
    await vi.waitFor(
      async () => {
        expect((await getHost(host.id))?.pairingTokenId).toBeNull();
        expect(build).toEqual({ transition: "stop" });
      },
      { timeout: 10_000, interval: 100 },
    );
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, tokenId));
    expect(key.revokedAt).not.toBeNull();
  });

  it("is stopped by the watcher once nothing ran in it for the idle time", async () => {
    process.env.OPTIO_CODER_IDLE_STOP_MS = String(60 * 60_000);
    const { host, tokenId } = await stoppedWorkspace("optio-fix-6");
    // Paired two hours ago; nothing has run since.
    await db
      .update(apiKeys)
      .set({ createdAt: sql`now() - interval '2 hours'` })
      .where(eq(apiKeys.id, tokenId));

    // A Task queued there keeps it.
    const queued = await insertTask({
      runTarget: "local",
      localHostId: host.id,
      localDir: "/home/coder/repo",
      state: "queued",
    });
    expect(await sweepIdleRemoteWorkspaces()).toBe(0);
    await db.update(tasks).set({ state: "pr_opened" }).where(eq(tasks.id, queued.id));

    answers.push(() => json({ id: "b-4", status: "pending", transition: "stop" }));
    expect(await sweepIdleRemoteWorkspaces()).toBe(1);
    expect(answers).toHaveLength(0);
    expect((await getHost(host.id))?.pairingTokenId).toBeNull();
    // Nothing left to stop.
    expect(await sweepIdleRemoteWorkspaces()).toBe(0);
  });

  it("isn't idle while it is still coming up", async () => {
    process.env.OPTIO_CODER_IDLE_STOP_MS = String(60 * 60_000);
    const { host, tokenId } = await stoppedWorkspace("optio-fix-7");
    await db.update(localHosts).set({ lastSeenAt: null }).where(eq(localHosts.id, host.id));
    await db
      .update(apiKeys)
      .set({ createdAt: sql`now() - interval '2 hours'` })
      .where(eq(apiKeys.id, tokenId));
    expect(await sweepIdleRemoteWorkspaces()).toBe(0);
  });
});
