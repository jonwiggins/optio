/**
 * Work in a GitHub codespace, a Daytona sandbox and an E2B sandbox
 * (docs/remote-workspaces.md), through the service as POST /api/work and the
 * dispatcher drive it, against real Postgres and in-process fakes of each
 * provider's API (test-utils/fake-*.ts): the workspace is made and the
 * pairing bundle reaches it the provider's way, the machine waits for its
 * daemon, the end of the work stops it and revokes the token, a re-run
 * wakes it with a fresh one, and the watcher lets go of one that fails.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { apiKeys, localHosts, users } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { startFakeDaytona, type FakeDaytona } from "../test-utils/fake-daytona.js";
import { startFakeE2b, type FakeE2b } from "../test-utils/fake-e2b.js";
import {
  startFakeGitHubCodespaces,
  type FakeGitHubCodespaces,
} from "../test-utils/fake-github-codespaces.js";

vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: vi.fn().mockRejectedValue(new Error("no token in tests")),
}));

import * as relay from "./local-relay.js";
import { getHost, registerHost } from "./local-host-service.js";
import type { Actor } from "./ownership.js";
import {
  createConnection,
  noteRemoteWorkspaceHello,
  onRemoteWorkspaceTaskSettled,
  startRemoteWorkspaceWork,
  startScriptsSettledForTests,
  sweepStartingRemoteWorkspaces,
  wakeRemoteWorkspaceWork,
} from "./remote-workspace-service.js";
import { setCodespacesPollMsForTests, pairingSecretName } from "./remote-workspaces/codespaces.js";
import { setEnvdUrlForTests } from "./remote-workspaces/e2b.js";

let daytona: FakeDaytona;
let e2b: FakeE2b;
let gh: FakeGitHubCodespaces;
let restoreEnvd: () => void;
let restorePoll: () => void;
let actor: Actor;
let admin: Actor;

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

beforeAll(async () => {
  vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
  vi.stubEnv("PUBLIC_API_URL", "https://optio.example.com");
  daytona = await startFakeDaytona({ apiKey: "dtn_1" });
  e2b = await startFakeE2b({ apiKey: "e2b_1" });
  gh = await startFakeGitHubCodespaces({ token: "ghp_1" });
  restoreEnvd = setEnvdUrlForTests((id) => `${e2b.url}/envd/${id}`);
  restorePoll = setCodespacesPollMsForTests(1);
});

afterAll(async () => {
  restoreEnvd();
  restorePoll();
  vi.unstubAllEnvs();
  await Promise.all([daytona.close(), e2b.close(), gh.close()]);
});

beforeEach(async () => {
  relay.resetRelayForTests();
  const ws = await insertWorkspace();
  const dev = await insertUser("dev");
  const boss = await insertUser("boss");
  actor = { userId: dev.id, workspaceId: ws.id, isAdmin: false, teamIds: [], adminTeamIds: [] };
  admin = { ...actor, userId: boss.id, isAdmin: true };
});

/** The daemon in the workspace says hello with the bundle it was given (ws/local-daemon.ts). */
async function hello(hostId: string) {
  const before = (await getHost(hostId))!;
  await registerHost({
    userId: actor.userId,
    workspaceId: actor.workspaceId,
    hostname: before.remoteWorkspaceName ?? "w",
    platform: "linux",
    dirs: [],
    hostId,
  });
  await db.update(localHosts).set({ lastSeenAt: new Date() }).where(eq(localHosts.id, hostId));
  await noteRemoteWorkspaceHello(before);
}

async function tokenOf(hostId: string) {
  const host = (await getHost(hostId))!;
  if (!host.pairingTokenId) return null;
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, host.pairingTokenId));
  return key;
}

async function revoked(id: string) {
  const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
  return !!key.revokedAt;
}

describe("a Daytona sandbox", () => {
  it("is made from a snapshot, gets the start script once it has started, stops when the work ends and starts again for a re-run", async () => {
    await createConnection(
      { provider: "daytona", name: "Sandboxes", url: daytona.url, token: "dtn_1" },
      admin,
    );
    const launch = {
      provider: "daytona" as const,
      templateId: "optio-node",
      parameters: { repo_url: "https://git.example.com/acme/app" },
    };
    const started = await startRemoteWorkspaceWork(launch, actor, { workName: "Fix it" });
    expect(started.localDir).toBe("/home/daytona/repo");
    const host = (await getHost(started.localHostId))!;
    expect(host).toMatchObject({
      origin: "daytona",
      remoteWorkspaceId: started.workspaceId,
      remoteWorkspaceName: started.workspaceName,
    });
    expect(host.dirs).toEqual([{ path: "/home/daytona/repo" }]);
    expect(daytona.sandboxes.get(started.workspaceId)?.labels).toEqual({
      "optio-host-id": host.id,
    });

    // The sandbox reads `creating`, then `started`: the script runs then.
    await startScriptsSettledForTests();
    const first = daytona.executed.filter((x) => x.sandboxId === started.workspaceId);
    expect(first).toHaveLength(1);
    const key = (await tokenOf(host.id))!;
    expect(key.name).toBe(`daytona:${started.workspaceName}`);
    expect(first[0].envs).toMatchObject({
      OPTIO_SERVER: "https://optio.example.com",
      OPTIO_LOCAL_HOST_ID: host.id,
      OPTIO_CHECKOUT_DIR: "/home/daytona/repo",
      OPTIO_REPO_URL: "https://git.example.com/acme/app",
    });
    expect(first[0].envs.OPTIO_TOKEN).toMatch(/^optio_pat_/);

    await hello(host.id);
    await onRemoteWorkspaceTaskSettled(host.id);
    expect(daytona.sandboxes.get(started.workspaceId)?.state).toBe("stopped");
    expect(await revoked(key.id)).toBe(true);
    expect((await getHost(host.id))?.pairingTokenId).toBeNull();

    // A re-run: the stopped sandbox starts again and gets a fresh bundle.
    const place = await wakeRemoteWorkspaceWork({
      launch,
      localHostId: host.id,
      localDir: "/home/daytona/repo",
      userId: actor.userId,
      workspaceId: actor.workspaceId,
      pin: async (p) => p,
    });
    expect(place).toEqual({ localHostId: host.id, localDir: "/home/daytona/repo" });
    await startScriptsSettledForTests();
    const again = daytona.executed.filter((x) => x.sandboxId === started.workspaceId);
    expect(again).toHaveLength(2);
    expect(again[1].envs.OPTIO_TOKEN).not.toBe(first[0].envs.OPTIO_TOKEN);
    expect(daytona.callsTo(`POST /sandbox/${started.workspaceId}/start`)).toHaveLength(1);
  });

  it("is let go by the watcher when it errors before pairing", async () => {
    await createConnection(
      { provider: "daytona", name: "Sandboxes", url: daytona.url, token: "dtn_1" },
      admin,
    );
    const started = await startRemoteWorkspaceWork(
      { provider: "daytona", templateId: "optio-node" },
      actor,
    );
    await startScriptsSettledForTests();
    const sandbox = daytona.sandboxes.get(started.workspaceId)!;
    sandbox.state = "error";
    expect(await sweepStartingRemoteWorkspaces()).toBeGreaterThanOrEqual(1);
    expect((await getHost(started.localHostId))?.pairingTokenId).toBeNull();
    expect(sandbox.state).toBe("stopped");
  });
});

describe("an E2B sandbox", () => {
  it("runs the start script through envd at once, pauses when the work ends and resumes for a re-run", async () => {
    await createConnection(
      { provider: "e2b", name: "E2B", url: e2b.url, token: "e2b_1", deleteWhenDone: false },
      admin,
    );
    const launch = { provider: "e2b" as const, templateId: "tpl-node" };
    const started = await startRemoteWorkspaceWork(launch, actor, { workName: "Nightly" });
    expect(started.localDir).toBe("/home/user/repo");
    await startScriptsSettledForTests();
    const runs = e2b.started.filter((x) => x.sandboxId === started.workspaceId);
    expect(runs).toHaveLength(1);
    expect(runs[0].envs).toMatchObject({ OPTIO_LOCAL_HOST_ID: started.localHostId });
    const key = (await tokenOf(started.localHostId))!;
    expect(key.name).toBe(`e2b:${started.workspaceName}`);

    await hello(started.localHostId);
    await onRemoteWorkspaceTaskSettled(started.localHostId);
    expect(e2b.sandboxes.get(started.workspaceId)?.state).toBe("paused");
    expect(await revoked(key.id)).toBe(true);

    await wakeRemoteWorkspaceWork({
      launch,
      localHostId: started.localHostId,
      localDir: started.localDir,
      userId: actor.userId,
      workspaceId: actor.workspaceId,
      pin: async (p) => p,
    });
    await startScriptsSettledForTests();
    expect(e2b.sandboxes.get(started.workspaceId)?.state).toBe("running");
    expect(e2b.started.filter((x) => x.sandboxId === started.workspaceId)).toHaveLength(2);
  });

  it("deletes the sandbox when the connection says so", async () => {
    await createConnection(
      { provider: "e2b", name: "E2B", url: e2b.url, token: "e2b_1", deleteWhenDone: true },
      admin,
    );
    const started = await startRemoteWorkspaceWork(
      { provider: "e2b", templateId: "tpl-node" },
      actor,
    );
    await startScriptsSettledForTests();
    await hello(started.localHostId);
    await onRemoteWorkspaceTaskSettled(started.localHostId);
    expect(e2b.sandboxes.has(started.workspaceId)).toBe(false);
  });
});

describe("a GitHub codespace", () => {
  it("is a person's own connection only", async () => {
    await expect(
      createConnection({ provider: "codespaces", name: "GH", url: gh.url, token: "ghp_1" }, admin),
    ).rejects.toThrow(/a person's own/);
  });

  it("is made for the work's repository, paired through its own secret, which goes after the hello", async () => {
    await createConnection(
      { provider: "codespaces", name: "GH", url: gh.url, token: "ghp_1", owner: "me" },
      actor,
    );
    const started = await startRemoteWorkspaceWork(
      { provider: "codespaces", parameters: { repo_url: "https://github.com/acme/app" } },
      actor,
      { workName: "Fix it" },
    );
    expect(started.localDir).toBe("/workspaces/app");
    const codespace = gh.codespaces.get(started.workspaceId)!;
    expect(codespace.repository.full_name).toBe("acme/app");
    const host = (await getHost(started.localHostId))!;
    expect(host.remoteWorkspaceName).toBe(codespace.name);
    const secret = gh.secrets.get(pairingSecretName(codespace.name))!;
    expect(secret.repositories).toEqual([9001]);
    const exports = Buffer.from(secret.value, "base64").toString("utf8");
    expect(exports).toContain(`export OPTIO_LOCAL_HOST_ID='${host.id}'`);
    expect(exports).toContain("export OPTIO_CHECKOUT_DIR='/workspaces/app'");
    expect(exports).toMatch(/export OPTIO_TOKEN='optio_pat_[^']+'/);

    // The daemon said hello: the secret has done its job.
    await hello(host.id);
    expect(gh.secrets.has(pairingSecretName(codespace.name))).toBe(false);

    await onRemoteWorkspaceTaskSettled(host.id);
    expect(codespace.state).toBe("ShuttingDown");

    // A re-run writes a fresh secret before it starts the codespace again.
    codespace.state = "Shutdown";
    codespace.pending = [];
    await wakeRemoteWorkspaceWork({
      launch: { provider: "codespaces", parameters: { repo_url: "https://github.com/acme/app" } },
      localHostId: host.id,
      localDir: started.localDir,
      userId: actor.userId,
      workspaceId: actor.workspaceId,
      pin: async (p) => p,
    });
    expect(codespace.state).toBe("Starting");
    expect(gh.secrets.has(pairingSecretName(codespace.name))).toBe(true);
  });
});
