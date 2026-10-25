import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────
// A queue-driven Drizzle stand-in: each `select` resolves the next queued
// result; inserts and updates are recorded and answer with what's queued (or
// the inserted values as the row).

const h = vi.hoisted(() => {
  process.env.OPTIO_ENCRYPTION_KEY = "a".repeat(63) + "b";
  const state = {
    selects: [] as unknown[][],
    updates: [] as unknown[][],
    inserted: [] as Array<Record<string, unknown>>,
    updated: [] as Array<Record<string, unknown>>,
    deleted: 0,
  };
  const chain = (result: () => unknown) => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit", "innerJoin"]) c[m] = () => c;
    c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(res, rej);
    return c;
  };
  const now = new Date("2026-10-23T10:00:00Z");
  const db = {
    select: () => chain(() => state.selects.shift() ?? []),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        state.inserted.push(v);
        return {
          returning: async () => [
            {
              createdAt: now,
              updatedAt: now,
              enabled: true,
              insecureSkipVerify: false,
              deleteWhenDone: false,
              defaultParameters: {},
              caPem: null,
              organizationId: null,
              templateId: null,
              templateVersionId: null,
              templateName: null,
              ttlMs: null,
              lastTestedAt: null,
              lastError: null,
              ...v,
            },
          ],
        };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        state.updated.push(v);
        return chain(() => state.updates.shift() ?? []) as Record<string, unknown> & {
          returning: () => Promise<unknown>;
        };
      },
    }),
    delete: () => ({
      where: async () => {
        state.deleted++;
      },
    }),
  };
  // `.returning()` on an update chain resolves the same queued result.
  const origUpdate = db.update;
  db.update = () => {
    const u = origUpdate();
    return {
      set: (v: Record<string, unknown>) => {
        const c = u.set(v) as Record<string, unknown>;
        c.where = () => c;
        c.returning = () => c;
        return c;
      },
    } as ReturnType<typeof origUpdate>;
  };
  return {
    state,
    db,
    createApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
    getHost: vi.fn(),
    markHostOffline: vi.fn(),
    isHostOnline: vi.fn(),
    handleSpawnError: vi.fn(),
  };
});

vi.mock("../db/client.js", () => ({ db: h.db }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("./api-key-service.js", () => ({
  createApiKey: (...a: unknown[]) => h.createApiKey(...a),
  revokeApiKey: (...a: unknown[]) => h.revokeApiKey(...a),
}));
vi.mock("./local-host-service.js", () => ({
  getHost: (...a: unknown[]) => h.getHost(...a),
  markHostOffline: (...a: unknown[]) => h.markHostOffline(...a),
}));
vi.mock("./local-relay.js", () => ({ isHostOnline: (...a: unknown[]) => h.isHostOnline(...a) }));
vi.mock("./local-terminal-service.js", () => ({
  handleSpawnError: (...a: unknown[]) => h.handleSpawnError(...a),
}));
vi.mock("./task-service.js", () => ({ updateTaskResult: vi.fn(), tryTransitionTask: vi.fn() }));
vi.mock("./team-service.js", () => ({ teamMembershipsOf: vi.fn(async () => []) }));
// The agent policy's parameters (agent-policy.int.test.ts covers them).
vi.mock("./agent-policy.js", () => ({
  remoteWorkspacePolicyParameters: vi.fn(async () => ({})),
  teamOfOwner: () => null,
}));

import { setOutboundDefaults } from "../utils/outbound-url.js";
import { encrypt } from "./secret-service.js";
import type { Actor } from "./ownership.js";
import {
  RemoteWorkspaceError,
  createConnection,
  onRemoteWorkspaceRunEnded,
  onRemoteWorkspaceTaskSettled,
  pickConnection,
  preparePairing,
  releaseWorkspacePairings,
  startRemoteWorkspaceWork,
  sweepStartingRemoteWorkspaces,
  sweepIdleRemoteWorkspaces,
  toConnectionView,
  wakeRemoteWorkspaceWork,
  workspaceNameFor,
  type RemoteWorkspaceConnectionRow,
} from "./remote-workspace-service.js";
import {
  CoderClient,
  parameterValues,
  type CoderRichParameter,
  type CoderWorkspace,
} from "./remote-workspaces/coder.js";

const TOKEN = "coder-session-token-SECRET-1234";
const NOW = new Date("2026-10-23T10:00:00Z");

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
let calls: Call[];
let answers: Array<(call: Call) => Response>;
let restore: () => void;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.selects = [];
  h.state.updates = [];
  h.state.inserted = [];
  h.state.updated = [];
  h.state.deleted = 0;
  calls = [];
  answers = [];
  process.env.PUBLIC_API_URL = "https://optio.example.com";
  restore = setOutboundDefaults({
    resolveHost: async () => [{ address: "10.20.0.5", family: 4 }],
    policy: { allowPrivate: true, allowedHosts: [], allowAll: false },
    fetchImpl: async (url, init) => {
      const call: Call = {
        url,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const next = answers.shift();
      if (!next) throw new Error(`unexpected request ${call.method} ${url}`);
      return next(call);
    },
  });
  h.createApiKey.mockResolvedValue({
    token: "optio_pat_pairing",
    tokenId: "key-1",
    prefix: "optio_pat_pa",
    name: "coder:x",
  });
  h.revokeApiKey.mockResolvedValue(true);
  h.isHostOnline.mockResolvedValue(false);
  h.markHostOffline.mockResolvedValue(undefined);
  h.handleSpawnError.mockResolvedValue(undefined);
});

afterEach(() => {
  restore();
  delete process.env.PUBLIC_API_URL;
});

const actor: Actor = {
  userId: "u-1",
  workspaceId: "ws-1",
  isAdmin: false,
  teamIds: ["team-1"],
  adminTeamIds: [],
};

function connRow(
  overrides: Partial<RemoteWorkspaceConnectionRow> = {},
): RemoteWorkspaceConnectionRow {
  const id = overrides.id ?? "conn-1";
  const blob = encrypt(TOKEN, Buffer.from(`coder_connection|${id}`));
  return {
    id,
    provider: "coder",
    workspaceId: "ws-1",
    ownerUserId: null,
    ownerTeamId: null,
    createdBy: "u-0",
    name: "Corp Coder",
    url: "https://coder.example.com",
    encryptedToken: blob.ciphertext,
    tokenIv: blob.iv,
    tokenAuthTag: blob.authTag,
    tokenHint: "1234",
    caPem: null,
    insecureSkipVerify: false,
    organizationId: "org-1",
    templateId: "tpl-1",
    templateVersionId: "tv-1",
    templateName: "Kubernetes",
    defaultParameters: { cpu: "4" },
    ttlMs: 2 * 60 * 60_000,
    deleteWhenDone: false,
    lastTestedAt: null,
    lastError: null,
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function workspace(
  status: string,
  agents: string[] = [],
  extra: Partial<CoderWorkspace["latest_build"]> = {},
): CoderWorkspace {
  return {
    id: "w-1",
    name: "optio-fix-1",
    owner_id: "cu-1",
    latest_build: {
      id: "b-1",
      status,
      transition: "start",
      template_version_id: "tv-1",
      resources: [{ agents: agents.map((s) => ({ status: s })) }],
      ...extra,
    },
  };
}

const CODER_ME = { id: "cu-1", username: "optio-svc" };

const PARAMS: CoderRichParameter[] = [
  { name: "optio_server", type: "string", mutable: true },
  { name: "optio_token", type: "string", mutable: true, ephemeral: true },
  { name: "optio_host_id", type: "string", mutable: true },
  { name: "optio_checkout_dir", type: "string", mutable: false },
  { name: "cpu", type: "number", mutable: false },
  { name: "repo_url", type: "string", mutable: true },
];

// ── The REST client ──────────────────────────────────────────────────────────

describe("CoderClient", () => {
  const client = () => new CoderClient({ url: "https://coder.example.com/", token: TOKEN });

  it("signs every request with the session token and reads JSON", async () => {
    answers.push(() => json({ id: "cu-1", username: "dev", email: "dev@example.com" }));
    const me = await client().me();
    expect(me.username).toBe("dev");
    expect(calls[0].url).toBe("https://coder.example.com/api/v2/users/me");
    expect(calls[0].headers["Coder-Session-Token"]).toBe(TOKEN);
  });

  it("creates a workspace from a template version with the parameters and the TTL", async () => {
    answers.push(() => json(workspace("pending")));
    await client().createWorkspace({
      templateVersionId: "tv-1",
      name: "optio-fix-1",
      ttlMs: 3_600_000,
      richParameterValues: [{ name: "optio_token", value: "t" }],
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://coder.example.com/api/v2/users/me/workspaces",
      body: {
        template_version_id: "tv-1",
        name: "optio-fix-1",
        ttl_ms: 3_600_000,
        rich_parameter_values: [{ name: "optio_token", value: "t" }],
      },
    });
  });

  it("starts, stops and deletes with a build", async () => {
    answers.push(() => json({ id: "b-2", status: "pending", transition: "stop" }));
    await client().build("w-1", "stop");
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://coder.example.com/api/v2/workspaces/w-1/builds",
      body: { transition: "stop" },
    });
  });

  it("turns Coder's errors into RemoteWorkspaceError without the token", async () => {
    answers.push(() => json({ message: "Unauthorized", detail: "token expired" }, 401));
    const err = await client()
      .me()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteWorkspaceError);
    expect((err as RemoteWorkspaceError).status).toBe(403);
    expect((err as RemoteWorkspaceError).message).toContain("Unauthorized — token expired");
    expect((err as RemoteWorkspaceError).message).not.toContain(TOKEN);
  });

  it("waits until the build runs and every agent is connected", async () => {
    answers.push(() => json(workspace("starting")));
    answers.push(() => json(workspace("running", ["connecting"])));
    answers.push(() => json(workspace("running", ["connected", "connected"])));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const ws = await client().waitForRunning("w-1", { sleep, pollMs: 1 });
    expect(ws.latest_build.status).toBe("running");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("stops waiting when the build failed, with Coder's reason", async () => {
    answers.push(() => json(workspace("failed", [], { job: { error: "quota exceeded" } })));
    await expect(client().waitForRunning("w-1", { sleep: async () => {} })).rejects.toThrow(
      "The Coder workspace optio-fix-1's build failed: quota exceeded",
    );
  });
});

// ── Parameters, names, picking ───────────────────────────────────────────────

describe("parameterValues", () => {
  const bundle = {
    OPTIO_SERVER: "https://optio.example.com",
    OPTIO_TOKEN: "optio_pat_x",
    OPTIO_LOCAL_HOST_ID: "host-1",
  };

  it("sends the bundle, the checkout and only the parameters the template declares", () => {
    const values = parameterValues(PARAMS, { cpu: "4", unknown: "x" }, bundle, {
      checkoutDir: "/home/coder/repo",
    });
    expect(Object.fromEntries(values.map((v) => [v.name, v.value]))).toEqual({
      cpu: "4",
      optio_checkout_dir: "/home/coder/repo",
      optio_server: "https://optio.example.com",
      optio_token: "optio_pat_x",
      optio_host_id: "host-1",
    });
  });

  it("changes only mutable parameters on an existing workspace", () => {
    const values = parameterValues(PARAMS, { cpu: "8", repo_url: "r" }, bundle, {
      checkoutDir: "/home/coder/repo",
      existing: true,
    });
    expect(values.map((v) => v.name).sort()).toEqual([
      "optio_host_id",
      "optio_server",
      "optio_token",
      "repo_url",
    ]);
  });

  it("refuses a template that can't take the pairing token", () => {
    expect(() =>
      parameterValues([{ name: "cpu", type: "number", mutable: true }], {}, bundle, {
        checkoutDir: "/r",
        templateName: "Plain",
      }),
    ).toThrow(/The template Plain has no optio_token parameter/);
  });
});

describe("workspaceNameFor", () => {
  it("makes a Coder name of at most 32 characters from the work's name", () => {
    expect(workspaceNameFor("Fix the login bug!", "abc123")).toBe("optio-fix-the-login-bug-abc123");
    const long = workspaceNameFor("a very long name for a piece of work indeed", "abc123");
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(workspaceNameFor(null, "abc123")).toBe("optio-abc123");
  });
});

describe("pickConnection", () => {
  const org = { id: "org", ownerUserId: null, ownerTeamId: null, enabled: true };
  const team = { id: "team", ownerUserId: "u-9", ownerTeamId: "team-1", enabled: true };
  const mine = { id: "mine", ownerUserId: "u-1", ownerTeamId: null, enabled: true };

  it("prefers the person's own, then a team's, then the organization's", () => {
    expect(pickConnection([org, team, mine], actor)?.id).toBe("mine");
    expect(pickConnection([org, team], actor)?.id).toBe("team");
    expect(pickConnection([org], actor)?.id).toBe("org");
  });

  it("skips disabled rows and teams the person isn't in", () => {
    expect(pickConnection([org, { ...mine, enabled: false }], actor)?.id).toBe("org");
    expect(pickConnection([{ ...team, ownerTeamId: "team-2" }], actor)).toBeNull();
  });
});

// ── Connections ──────────────────────────────────────────────────────────────

describe("connections", () => {
  it("never return the token", () => {
    const view = toConnectionView(connRow(), actor);
    const text = JSON.stringify(view);
    expect(text).not.toContain(TOKEN);
    expect(view).not.toHaveProperty("encryptedToken");
    expect(view).toMatchObject({ hasToken: true, tokenHint: "1234", canEdit: false });
  });

  it("seal the token on create, bound to the row's id", async () => {
    const view = await createConnection(
      {
        provider: "coder",
        name: "Mine",
        url: "https://coder.example.com/",
        token: TOKEN,
        owner: "me",
      },
      actor,
    );
    const values = h.state.inserted[0];
    expect(values.ownerUserId).toBe("u-1");
    expect(values.url).toBe("https://coder.example.com");
    expect(Buffer.isBuffer(values.encryptedToken)).toBe(true);
    expect(JSON.stringify(values)).not.toContain(TOKEN);
    expect(values.tokenHint).toBe("1234");
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(view.canEdit).toBe(true);
  });

  it("refuse the organization's to a member and a team's to an outsider", async () => {
    await expect(
      createConnection(
        { provider: "coder", name: "Org", url: "https://c.example", token: TOKEN },
        actor,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createConnection(
        {
          provider: "coder",
          name: "T",
          url: "https://c.example",
          token: TOKEN,
          owner: "team:00000000-0000-0000-0000-000000000002",
        },
        actor,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(h.state.inserted).toHaveLength(0);
  });
});

// ── Pairing and starting work ────────────────────────────────────────────────

describe("preparePairing", () => {
  it("mints a coder:<workspace> PAT past the TTL and pre-registers the machine", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      const { bundle, host } = await preparePairing(connRow(), actor, {
        workspaceName: "optio-fix-1",
        checkoutDir: "/home/coder/repo",
      });
      const [userId, name, expiresAt] = h.createApiKey.mock.calls[0];
      expect(userId).toBe("u-1");
      expect(name).toBe("coder:optio-fix-1");
      expect((expiresAt as Date).getTime()).toBe(NOW.getTime() + 2 * 3_600_000 + 3_600_000);
      const row = h.state.inserted[0];
      expect(row).toMatchObject({
        userId: "u-1",
        workspaceId: "ws-1",
        name: "optio-fix-1",
        origin: "coder",
        dirs: [{ path: "/home/coder/repo" }],
        remoteWorkspaceConnectionId: "conn-1",
        pairingTokenId: "key-1",
      });
      expect(row.hostname).toBe(`coder:${row.id}`);
      expect(bundle).toEqual({
        OPTIO_SERVER: "https://optio.example.com",
        OPTIO_TOKEN: "optio_pat_pairing",
        OPTIO_LOCAL_HOST_ID: host.id,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("needs a signed-in person", async () => {
    await expect(
      preparePairing(
        connRow(),
        { ...actor, userId: null },
        { workspaceName: "w", checkoutDir: "/r" },
      ),
    ).rejects.toThrow(/signed-in person/);
  });
});

describe("startRemoteWorkspaceWork", () => {
  it("creates a workspace from the connection's template with the bundle and returns at once", async () => {
    h.state.selects.push([connRow()]); // resolveConnectionFor
    answers.push(() => json(PARAMS)); // rich-parameters
    answers.push(() => json(workspace("pending"))); // create
    const started = await startRemoteWorkspaceWork({ parameters: { repo_url: "r" } }, actor, {
      workName: "Fix it",
    });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /api/v2/templateversions/tv-1/rich-parameters",
      "POST /api/v2/users/me/workspaces",
    ]);
    const body = calls[1].body as {
      name: string;
      template_version_id: string;
      rich_parameter_values: Array<{ name: string; value: string }>;
    };
    expect(body.template_version_id).toBe("tv-1");
    expect(body.name).toMatch(/^optio-fix-it-[0-9a-f]{6}$/);
    const values = Object.fromEntries(body.rich_parameter_values.map((v) => [v.name, v.value]));
    expect(values).toMatchObject({
      cpu: "4",
      repo_url: "r",
      optio_token: "optio_pat_pairing",
      optio_server: "https://optio.example.com",
      optio_checkout_dir: "/home/coder/repo",
    });
    expect(values.optio_host_id).toBe(started.localHostId);
    expect(started).toMatchObject({ localDir: "/home/coder/repo", workspaceId: "w-1" });
    expect(h.state.updated.at(-1)).toMatchObject({ remoteWorkspaceId: "w-1" });
  });

  it("starts an existing workspace with a build and the bundle", async () => {
    h.state.selects.push([connRow()]); // connection
    h.state.selects.push([]); // no host for the workspace yet
    answers.push(() => json(workspace("stopped", [], { transition: "stop" })));
    answers.push(() => json(CODER_ME));
    answers.push(() => json(PARAMS));
    answers.push(() => json({ id: "b-2", status: "pending", transition: "start" }));
    const started = await startRemoteWorkspaceWork({ workspaceId: "w-1" }, actor);
    expect(calls[3]).toMatchObject({
      method: "POST",
      url: "https://coder.example.com/api/v2/workspaces/w-1/builds",
      body: { transition: "start" },
    });
    const names = (
      calls[3].body as { rich_parameter_values: Array<{ name: string }> }
    ).rich_parameter_values
      .map((v) => v.name)
      .sort();
    expect(names).toEqual(["optio_host_id", "optio_server", "optio_token"]);
    expect(started.workspaceName).toBe("optio-fix-1");
  });

  it("won't start a workspace that isn't the token user's", async () => {
    h.state.selects.push([connRow()]);
    answers.push(() => json({ ...workspace("stopped"), owner_id: "cu-2" }));
    answers.push(() => json(CODER_ME));
    await expect(startRemoteWorkspaceWork({ workspaceId: "w-1" }, actor)).rejects.toMatchObject({
      status: 403,
    });
    expect(h.createApiKey).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
  });

  it("won't start one Optio paired as another person's machine", async () => {
    h.state.selects.push([connRow()]);
    h.state.selects.push([{ ...coderHost, userId: "u-2" }]);
    answers.push(() => json(workspace("running", ["connected"])));
    answers.push(() => json(CODER_ME));
    await expect(startRemoteWorkspaceWork({ workspaceId: "w-1" }, actor)).rejects.toThrow(
      /another person's machine/,
    );
    expect(h.createApiKey).not.toHaveBeenCalled();
  });

  it("revokes the token and drops the row when Coder refuses the workspace", async () => {
    h.state.selects.push([connRow()]);
    answers.push(() => json(PARAMS));
    answers.push(() => json({ message: "name taken" }, 409));
    await expect(startRemoteWorkspaceWork({ name: "taken" }, actor)).rejects.toThrow(/name taken/);
    expect(h.revokeApiKey).toHaveBeenCalledWith("key-1", "u-1");
    expect(h.state.deleted).toBe(1);
  });

  it("says where to add a connection when there is none", async () => {
    h.state.selects.push([]);
    await expect(startRemoteWorkspaceWork({}, actor)).rejects.toThrow(
      /Settings → Integrations → Remote workspaces/,
    );
  });
});

// ── The end of a run, and the watcher ────────────────────────────────────────

const coderHost = {
  id: "host-1",
  userId: "u-1",
  name: "optio-fix-1",
  origin: "coder",
  remoteWorkspaceId: "w-1",
  remoteWorkspaceName: "optio-fix-1",
  remoteWorkspaceConnectionId: "conn-1",
  pairingTokenId: "key-1",
  dirs: [{ path: "/home/coder/repo" }],
  lastSeenAt: null,
};

describe("onRemoteWorkspaceRunEnded", () => {
  const ended = {
    id: "t-1",
    hostId: "host-1",
    state: "exited",
    taskId: "task-1",
    workflowRunId: null,
  } as const;

  it("stops the workspace, revokes the pairing token and marks the host offline", async () => {
    h.getHost.mockResolvedValue(coderHost);
    h.state.selects.push([{ state: "completed" }]); // the task settled
    h.state.selects.push([]); // nothing else running there
    h.state.selects.push([]); // no other open Task there
    h.state.updates.push([{ id: "host-1" }]); // the pairing claimed
    h.state.selects.push([connRow()]);
    answers.push(() => json({ id: "b-3", status: "pending", transition: "stop" }));
    await onRemoteWorkspaceRunEnded(ended);
    expect(h.revokeApiKey).toHaveBeenCalledWith("key-1", "u-1");
    expect(calls[0].body).toEqual({ transition: "stop" });
    expect(h.markHostOffline).toHaveBeenCalledWith("host-1");
  });

  it("deletes it when the connection says so", async () => {
    h.getHost.mockResolvedValue(coderHost);
    h.state.selects.push([{ state: "failed" }]);
    h.state.selects.push([]);
    h.state.selects.push([]);
    h.state.updates.push([{ id: "host-1" }]);
    h.state.selects.push([connRow({ deleteWhenDone: true })]);
    answers.push(() => json({ id: "b-3", status: "pending", transition: "delete" }));
    await onRemoteWorkspaceRunEnded(ended);
    expect(calls[0].body).toEqual({ transition: "delete" });
  });

  it("leaves a machine alone, and a workspace another run still uses", async () => {
    h.getHost.mockResolvedValue({ ...coderHost, origin: "machine" });
    await onRemoteWorkspaceRunEnded(ended);
    h.getHost.mockResolvedValue(coderHost);
    h.state.selects.push([{ state: "completed" }]);
    h.state.selects.push([{ id: "t-2" }]);
    await onRemoteWorkspaceRunEnded(ended);
    expect(h.revokeApiKey).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("keeps a Task's workspace while the task may resume (a PR waiting on CI or review)", async () => {
    h.getHost.mockResolvedValue(coderHost);
    h.state.selects.push([{ state: "pr_opened" }]);
    await onRemoteWorkspaceRunEnded(ended);
    expect(h.revokeApiKey).not.toHaveBeenCalled();
    expect(h.markHostOffline).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("keeps it while another Task there is still open", async () => {
    h.getHost.mockResolvedValue(coderHost);
    h.state.selects.push([{ state: "completed" }]);
    h.state.selects.push([]); // no live terminal
    h.state.selects.push([{ id: "task-2" }]); // task-2 waits on its PR there
    await onRemoteWorkspaceRunEnded(ended);
    expect(h.revokeApiKey).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("stops a Job's workspace when its run ends", async () => {
    h.getHost.mockResolvedValue(coderHost);
    h.state.selects.push([]);
    h.state.selects.push([]);
    h.state.updates.push([{ id: "host-1" }]);
    h.state.selects.push([connRow()]);
    answers.push(() => json({ id: "b-3", status: "pending", transition: "stop" }));
    await onRemoteWorkspaceRunEnded({ ...ended, taskId: null, workflowRunId: "run-1" });
    expect(calls[0].body).toEqual({ transition: "stop" });
  });

  it("does nothing for a live terminal", async () => {
    await onRemoteWorkspaceRunEnded({ ...ended, state: "running" });
    expect(h.getHost).not.toHaveBeenCalled();
  });
});

describe("onRemoteWorkspaceTaskSettled", () => {
  it("lets the workspace go once the task is completed, failed or cancelled", async () => {
    h.getHost.mockResolvedValue(coderHost);
    h.state.selects.push([]);
    h.state.selects.push([]);
    h.state.updates.push([{ id: "host-1" }]);
    h.state.selects.push([connRow()]);
    answers.push(() => json({ id: "b-3", status: "pending", transition: "stop" }));
    await onRemoteWorkspaceTaskSettled("host-1");
    expect(h.getHost).toHaveBeenCalledWith("host-1");
    expect(calls[0].body).toEqual({ transition: "stop" });
    expect(h.revokeApiKey).toHaveBeenCalledWith("key-1", "u-1");
    expect(h.markHostOffline).toHaveBeenCalledWith("host-1");
  });

  it("leaves a machine, and a workspace already let go, alone", async () => {
    h.getHost.mockResolvedValue({ ...coderHost, origin: "machine" });
    await onRemoteWorkspaceTaskSettled("host-1");
    h.getHost.mockResolvedValue({ ...coderHost, pairingTokenId: null });
    await onRemoteWorkspaceTaskSettled("host-1");
    expect(calls).toHaveLength(0);
    expect(h.revokeApiKey).not.toHaveBeenCalled();
  });
});

describe("wakeRemoteWorkspaceWork", () => {
  const launch = { templateVersionId: "tv-1" };
  const pin = vi.fn();
  const base = {
    launch,
    localHostId: "host-1",
    localDir: "/home/coder/repo",
    userId: "u-1",
    workspaceId: "ws-1",
    workName: "Fix it",
    pin,
  };
  // The pairing token was minted an hour ago and the daemon said hello since.
  const paired = { ...coderHost, lastSeenAt: new Date(Date.now() - 30 * 60_000), updatedAt: NOW };
  const oldKey = { createdAt: new Date(Date.now() - 60 * 60_000), revokedAt: null };

  beforeEach(() => {
    pin.mockReset();
    pin.mockImplementation(async (place: unknown) => place);
  });

  it("does nothing without a launch, on a machine, or while the workspace is online", async () => {
    expect(await wakeRemoteWorkspaceWork({ ...base, launch: null })).toBeNull();
    h.getHost.mockResolvedValue({ ...paired, origin: "machine" });
    expect(await wakeRemoteWorkspaceWork(base)).toBeNull();
    h.getHost.mockResolvedValue(paired);
    h.isHostOnline.mockResolvedValue(true);
    expect(await wakeRemoteWorkspaceWork(base)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("leaves a workspace that is still coming up to come up", async () => {
    h.getHost.mockResolvedValue({ ...paired, lastSeenAt: null });
    h.state.selects.push([{ createdAt: new Date(Date.now() - 60_000), revokedAt: null }]);
    expect(await wakeRemoteWorkspaceWork(base)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(h.createApiKey).not.toHaveBeenCalled();
  });

  it("starts a stopped workspace again with a fresh pairing bundle (a resume)", async () => {
    h.getHost.mockResolvedValue(paired);
    h.state.selects.push([oldKey]); // the pairing token: seen since, so not starting
    h.state.updates.push([{ id: "host-1" }]); // the claim on the host
    h.state.selects.push([connRow()]); // the host's connection
    h.state.selects.push([paired]); // the machine Optio paired the workspace as
    h.state.updates.push([{ ...paired, pairingTokenId: "key-1" }]); // preparePairing
    answers.push(() => json(workspace("stopped", [], { transition: "stop" })));
    answers.push(() => json(CODER_ME));
    answers.push(() => json(PARAMS));
    answers.push(() => json({ id: "b-5", status: "pending", transition: "start" }));
    const place = await wakeRemoteWorkspaceWork(base);
    expect(place).toEqual({ localHostId: "host-1", localDir: "/home/coder/repo" });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /api/v2/workspaces/w-1",
      "GET /api/v2/users/me",
      "GET /api/v2/templateversions/tv-1/rich-parameters",
      "POST /api/v2/workspaces/w-1/builds",
    ]);
    const body = calls[3].body as {
      transition: string;
      rich_parameter_values: Array<{ name: string; value: string }>;
    };
    expect(body.transition).toBe("start");
    expect(body.rich_parameter_values).toContainEqual({
      name: "optio_token",
      value: "optio_pat_pairing",
    });
    expect(h.createApiKey).toHaveBeenCalledWith("u-1", "coder:optio-fix-1", expect.any(Date));
    expect(pin).not.toHaveBeenCalled();
  });

  it("parks when another dispatcher is waking it", async () => {
    h.getHost.mockResolvedValue({ ...paired, pairingTokenId: null });
    h.state.updates.push([]); // the claim lost
    expect(await wakeRemoteWorkspaceWork(base)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("makes a new workspace from the launch when the old one is gone, and pins it", async () => {
    h.getHost.mockResolvedValue(paired);
    h.state.selects.push([oldKey]);
    h.state.updates.push([{ id: "host-1" }]); // the claim
    h.state.selects.push([connRow()]);
    answers.push(() => json({ message: "Resource not found" }, 404));
    h.state.updates.push([{ id: "host-1" }]); // the old pairing revoked
    h.state.selects.push([connRow()]); // the connection again, for the new one
    answers.push(() => json(PARAMS));
    answers.push(() => json({ ...workspace("pending"), id: "w-2", name: "optio-fix-it-2" }));
    const place = await wakeRemoteWorkspaceWork(base);
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /api/v2/workspaces/w-1",
      "GET /api/v2/templateversions/tv-1/rich-parameters",
      "POST /api/v2/users/me/workspaces",
    ]);
    const made = h.state.inserted.at(-1) as { id: string; origin: string };
    expect(made.origin).toBe("coder");
    expect(place).toEqual({ localHostId: made.id, localDir: "/home/coder/repo" });
    expect(pin).toHaveBeenCalledWith(place, "host-1");
    expect(h.revokeApiKey).toHaveBeenCalledWith("key-1", "u-1");
  });

  it("makes the workspace of a definition's first firing, and lets it go when another dispatcher pinned one first", async () => {
    h.state.selects.push([connRow()]);
    answers.push(() => json(PARAMS));
    answers.push(() => json(workspace("pending")));
    pin.mockResolvedValue({ localHostId: "host-9", localDir: "/home/coder/repo" });
    h.getHost.mockResolvedValue(null);
    const place = await wakeRemoteWorkspaceWork({ ...base, localHostId: null, localDir: null });
    expect(place).toEqual({ localHostId: "host-9", localDir: "/home/coder/repo" });
    const made = h.state.inserted.at(-1) as { id: string };
    expect(pin).toHaveBeenCalledWith({ localHostId: made.id, localDir: "/home/coder/repo" }, null);
    // cancelRemoteWorkspaceWork looked the one made here up to let it go.
    expect(h.getHost).toHaveBeenLastCalledWith(made.id);
  });

  it("fails the runs parked on the workspace when it can't be started", async () => {
    h.getHost.mockResolvedValue(paired);
    h.state.selects.push([oldKey]);
    h.state.updates.push([{ id: "host-1" }]);
    h.state.selects.push([connRow()]);
    answers.push(() => json({ message: "boom" }, 500));
    h.state.selects.push([{ id: "term-7" }]); // parked there meanwhile
    await expect(wakeRemoteWorkspaceWork(base)).rejects.toThrow(/Coder answered 500/);
    expect(h.handleSpawnError).toHaveBeenCalledWith(
      "host-1",
      "term-7",
      expect.stringMatching(/Coder answered 500/),
    );
  });
});

describe("sweepIdleRemoteWorkspaces", () => {
  it("stops a paired workspace nothing ran in for the idle time", async () => {
    h.state.selects.push([{ host: { ...coderHost, lastSeenAt: NOW } }]);
    h.state.updates.push([{ id: "host-1" }]);
    h.state.selects.push([connRow()]);
    answers.push(() => json({ id: "b-6", status: "pending", transition: "stop" }));
    expect(await sweepIdleRemoteWorkspaces()).toBe(1);
    expect(calls[0].body).toEqual({ transition: "stop" });
    expect(h.revokeApiKey).toHaveBeenCalledWith("key-1", "u-1");
    expect(h.markHostOffline).toHaveBeenCalledWith("host-1");
  });

  it("counts nothing when no workspace is idle, or another pass let it go first", async () => {
    expect(await sweepIdleRemoteWorkspaces()).toBe(0);
    h.state.selects.push([{ host: coderHost }]);
    h.state.updates.push([]); // the pairing already cleared
    expect(await sweepIdleRemoteWorkspaces()).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("releaseWorkspacePairings", () => {
  it("revokes the pairing tokens of a stopped workspace's machines", async () => {
    h.state.selects.push([coderHost]);
    h.state.updates.push([{ id: "host-1" }]);
    await releaseWorkspacePairings("conn-1", "w-1");
    expect(h.state.updated.at(-1)).toMatchObject({ pairingTokenId: null });
    expect(h.revokeApiKey).toHaveBeenCalledWith("key-1", "u-1");
    expect(h.markHostOffline).toHaveBeenCalledWith("host-1");
    expect(calls).toHaveLength(0);
  });
});

describe("sweepStartingRemoteWorkspaces", () => {
  it("fails the parked run when the workspace build failed", async () => {
    h.state.selects.push([{ host: coderHost, pairedAt: new Date(Date.now() - 60_000) }]);
    h.state.selects.push([connRow()]); // the connection, for the build status
    h.state.selects.push([{ id: "term-1" }]); // parked terminals
    h.state.selects.push([]); // queued tasks without one
    h.state.updates.push([{ id: "host-1" }]); // the pairing claimed
    h.state.selects.push([connRow()]); // the connection, to stop it
    answers.push(() => json(workspace("failed", [], { job: { error: "image pull failed" } })));
    answers.push(() => json({ id: "b-4", status: "pending", transition: "stop" }));
    expect(await sweepStartingRemoteWorkspaces()).toBe(1);
    expect(h.handleSpawnError).toHaveBeenCalledWith(
      "host-1",
      "term-1",
      "The Coder workspace optio-fix-1's build failed: image pull failed",
    );
    expect(h.revokeApiKey).toHaveBeenCalledWith("key-1", "u-1");
  });

  it("fails it when the workspace never paired in time, and waits otherwise", async () => {
    h.state.selects.push([{ host: coderHost, pairedAt: new Date(Date.now() - 60_000) }]);
    h.state.selects.push([connRow()]);
    answers.push(() => json(workspace("running", ["connected"])));
    expect(await sweepStartingRemoteWorkspaces()).toBe(0);

    h.state.selects.push([{ host: coderHost, pairedAt: new Date(Date.now() - 16 * 60_000) }]);
    h.state.selects.push([connRow()]);
    h.state.selects.push([{ id: "term-1" }]);
    h.state.selects.push([]);
    h.state.updates.push([{ id: "host-1" }]);
    h.state.selects.push([connRow()]);
    answers.push(() => json(workspace("running", ["connected"])));
    answers.push(() => json({ id: "b-4", status: "pending", transition: "stop" }));
    expect(await sweepStartingRemoteWorkspaces()).toBe(1);
    expect(h.handleSpawnError.mock.calls[0][2]).toMatch(
      /didn't pair with Optio within 15 minutes .*\/tmp\/optio-local\.log/,
    );
  });
});
