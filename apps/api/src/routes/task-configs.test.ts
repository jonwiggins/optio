import type { FastifyInstance, InjectOptions } from "fastify";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const mocks = vi.hoisted(() => ({
  listTaskConfigs: vi.fn(),
  getTaskConfig: vi.fn(),
  createTaskConfig: vi.fn(),
  updateTaskConfig: vi.fn(),
  deleteTaskConfig: vi.fn(),
  instantiateTask: vi.fn(),
  listTriggers: vi.fn(),
  createTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
  readRows: vi.fn(),
  validateRunLocation: vi.fn(),
  providerSelectionError: vi.fn(),
  credentialSelectionError: vi.fn(),
  podSecretsSelectionError: vi.fn(),
  getModelProviderRow: vi.fn(),
  listPickableSecrets: vi.fn(),
  logAction: vi.fn(),
}));
vi.mock("../services/task-config-service.js", () => ({
  listTaskConfigs: mocks.listTaskConfigs,
  getTaskConfig: mocks.getTaskConfig,
  createTaskConfig: mocks.createTaskConfig,
  updateTaskConfig: mocks.updateTaskConfig,
  deleteTaskConfig: mocks.deleteTaskConfig,
  instantiateTask: mocks.instantiateTask,
}));
// Keep real trigger target checks, validation and secret redaction. Only storage
// and mutations are mocked, so a nested route cannot silently bypass its parent.
vi.mock("../services/trigger-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/trigger-service.js")>()),
  listTriggers: mocks.listTriggers,
  createTrigger: mocks.createTrigger,
  updateTrigger: mocks.updateTrigger,
  deleteTrigger: mocks.deleteTrigger,
}));
vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({ where: (query: unknown) => mocks.readRows(table, query) }),
    }),
  },
}));
vi.mock("../services/oauth/index.js", () => ({ isAuthDisabled: () => false }));
vi.mock("../services/model-provider-service.js", () => ({
  getModelProviderRow: mocks.getModelProviderRow,
  providerSelectionError: mocks.providerSelectionError,
}));
vi.mock("../services/agent-credential-service.js", () => ({
  credentialSelectionError: mocks.credentialSelectionError,
}));
vi.mock("../services/secret-service.js", () => ({
  listPickableSecrets: mocks.listPickableSecrets,
  podSecretsSelectionError: mocks.podSecretsSelectionError,
}));
vi.mock("../services/local-run-service.js", () => ({
  validateRunLocation: mocks.validateRunLocation,
}));
vi.mock("../services/optio-action-service.js", () => ({ logAction: mocks.logAction }));
vi.mock("../services/config/managed.js", () => ({
  withManagedBy: async (rows: unknown[]) => rows,
}));

import { workflowTriggers } from "../db/schema.js";
import { taskConfigRoutes } from "./task-configs.js";

const ROOT = "/api/task-configs";
const ID = "blueprint-1";
const PATH = `${ROOT}/${ID}`;
const TRIGGER_PATH = `${PATH}/triggers/trigger-1`;
const USER = { id: "user-1", workspaceId: "ws-1", workspaceRole: "member" as const };
const HOST_ID = "12345678-1234-1234-1234-123456789abc";
const createBody = {
  name: "Nightly",
  title: "Fix {{issue}}",
  prompt: "Fix the issue",
  repoUrl: "https://github.com/acme/app",
};
const clusterLocation = {
  runTarget: "cluster",
  localHostId: null,
  localDir: null,
  localSessionMode: null,
};
const config = {
  id: ID,
  ...createBody,
  workspaceId: "ws-1",
  ownerUserId: "user-1" as string | null,
  description: null,
  promptTemplateId: null,
  repoBranch: "main",
  agentType: "claude-code",
  maxRetries: 3,
  priority: 0,
  agentOptions: null,
  podSecrets: null,
  ...clusterLocation,
  enabled: true,
  createdBy: "user-1",
  createdAt: "2026-10-26T00:00:00Z",
  updatedAt: "2026-10-26T00:00:00Z",
};
const trigger = {
  id: "trigger-1",
  targetType: "task_config",
  targetId: ID,
  type: "webhook",
  config: { path: "/nightly", secret: "stored-trigger-secret" },
  paramMapping: null,
  enabled: true,
  createdAt: "2026-10-26T00:00:00Z",
  updatedAt: "2026-10-26T00:00:00Z",
};
const requests: InjectOptions[] = [
  { method: "GET", url: PATH },
  { method: "PATCH", url: PATH, payload: { title: "Changed" } },
  { method: "DELETE", url: PATH },
  { method: "GET", url: `${PATH}/triggers` },
  { method: "POST", url: `${PATH}/triggers`, payload: { type: "manual" } },
  { method: "PATCH", url: TRIGGER_PATH, payload: { enabled: false } },
  { method: "DELETE", url: TRIGGER_PATH },
  { method: "POST", url: `${PATH}/run` },
];
const mutations = requests.filter((request) => request.method !== "GET");
const writeMocks = [
  mocks.createTaskConfig,
  mocks.updateTaskConfig,
  mocks.deleteTaskConfig,
  mocks.instantiateTask,
  mocks.createTrigger,
  mocks.updateTrigger,
  mocks.deleteTrigger,
];
const apps: FastifyInstance[] = [];
async function appFor(role: "admin" | "member" | "viewer" = "member") {
  const app = await buildRouteTestApp(taskConfigRoutes, { user: { ...USER, workspaceRole: role } });
  apps.push(app);
  return app;
}
function expectNoWrites() {
  for (const write of writeMocks) expect(write).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getTaskConfig.mockResolvedValue(config);
  mocks.listTaskConfigs.mockResolvedValue([config]);
  mocks.createTaskConfig.mockImplementation(async (input) => ({ ...config, ...input }));
  mocks.updateTaskConfig.mockImplementation(async (_id, input) => ({ ...config, ...input }));
  mocks.instantiateTask.mockResolvedValue({ id: "spawned-task" });
  mocks.listTriggers.mockResolvedValue([trigger]);
  mocks.createTrigger.mockImplementation(async (input) => ({ ...trigger, ...input }));
  mocks.updateTrigger.mockImplementation(async (_id, input) => ({ ...trigger, ...input }));
  mocks.readRows.mockImplementation(async (table, query) => {
    const ids = new PgDialect().sqlToQuery(query).params;
    const rows =
      table === workflowTriggers
        ? [trigger]
        : [
            { id: "user-1", displayName: "Owner", email: "owner@example.com" },
            { id: "user-2", displayName: "Other Owner", email: "other@example.com" },
          ];
    return rows.filter((row) => ids.includes(row.id));
  });
  mocks.validateRunLocation.mockResolvedValue({ ok: true, location: clusterLocation });
  mocks.providerSelectionError.mockResolvedValue(null);
  mocks.credentialSelectionError.mockResolvedValue(null);
  mocks.podSecretsSelectionError.mockResolvedValue(null);
  mocks.listPickableSecrets.mockResolvedValue([]);
  mocks.logAction.mockResolvedValue(undefined);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("legacy task-config authorization", () => {
  it.each(requests)("treats missing configs as missing: $method $url", async (request) => {
    mocks.getTaskConfig.mockResolvedValue(null);
    const response = await (await appFor()).inject(request);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Task config not found" });
    expectNoWrites();
    expect(mocks.listTriggers).not.toHaveBeenCalled();
  });
  it.each(requests)("hides another workspace from an admin: $method $url", async (request) => {
    mocks.getTaskConfig.mockResolvedValue({ ...config, workspaceId: "ws-other" });
    const response = await (await appFor("admin")).inject(request);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Task config not found" });
    expectNoWrites();
    expect(mocks.readRows).not.toHaveBeenCalled();
  });
  it.each(requests)("hides another member's private config: $method $url", async (request) => {
    mocks.getTaskConfig.mockResolvedValue({ ...config, ownerUserId: "user-2" });
    const response = await (await appFor()).inject(request);
    expect(response.statusCode).toBe(404);
    expectNoWrites();
    expect(mocks.readRows).not.toHaveBeenCalled();
  });
  it.each(mutations.filter((request) => !(request.method === "DELETE" && request.url === PATH)))(
    "admins cannot execute or alter another owner's credentials: $method $url",
    async (request) => {
      mocks.getTaskConfig.mockResolvedValue({ ...config, ownerUserId: "user-2" });
      const response = await (await appFor("admin")).inject(request);
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toMatch(/Only Other Owner can .*own credentials/);
      expectNoWrites();
    },
  );
  it.each([
    ...mutations,
    { method: "POST", url: ROOT, payload: createBody } satisfies InjectOptions,
  ])("viewers cannot mutate even their own config: $method $url", async (request) => {
    const response = await (await appFor("viewer")).inject(request);
    expect(response.statusCode).toBe(403);
    expect(mocks.getTaskConfig).not.toHaveBeenCalled();
    expectNoWrites();
  });
  it("allows an admin to read private work with owner attribution and remove it for offboarding", async () => {
    mocks.getTaskConfig.mockResolvedValue({ ...config, ownerUserId: "user-2" });
    const app = await appFor("admin");
    const read = await app.inject({ method: "GET", url: PATH });
    expect(read.statusCode).toBe(200);
    expect(read.json().taskConfig.ownerName).toBe("Other Owner");
    const removed = await app.inject({ method: "DELETE", url: PATH });
    expect(removed.statusCode).toBe(204);
    expect(mocks.deleteTaskConfig).toHaveBeenCalledExactlyOnceWith(ID);
  });
  it.each(["member", "viewer", "admin"] as const)(
    "passes the current workspace and real viewer to listing for %s",
    async (role) => {
      const response = await (await appFor(role)).inject({ method: "GET", url: ROOT });
      expect(response.statusCode).toBe(200);
      expect(mocks.listTaskConfigs).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "ws-1",
        viewer: { userId: "user-1", workspaceId: "ws-1", isAdmin: role === "admin" },
      });
    },
  );
  it("lets the owner read and manually run their private config", async () => {
    const app = await appFor();
    expect((await app.inject({ method: "GET", url: PATH })).json().taskConfig.ownerName).toBe(
      "Owner",
    );
    const response = await app.inject({ method: "POST", url: `${PATH}/run` });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ taskId: "spawned-task" });
    expect(mocks.instantiateTask).toHaveBeenCalledExactlyOnceWith(ID);
  });
});

describe("task-config creation and updates", () => {
  it.each([undefined, "workspace", "me"] as const)(
    "creates work with the planned owner (%s) and authenticated workspace",
    async (owner) => {
      const response = await (
        await appFor()
      ).inject({
        method: "POST",
        url: ROOT,
        payload: {
          ...createBody,
          owner,
          workspaceId: "ws-attacker",
          createdBy: "attacker",
          ownerUserId: "attacker",
        },
      });
      expect(response.statusCode).toBe(201);
      expect(mocks.createTaskConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-1",
          createdBy: "user-1",
          ownerUserId: owner === "me" ? "user-1" : null,
          ...clusterLocation,
        }),
      );
      expect(mocks.createTaskConfig.mock.calls[0][0]).not.toHaveProperty("owner");
    },
  );
  it("normalizes selected pod secrets before storing and checks them against the work owner", async () => {
    const response = await (
      await appFor()
    ).inject({
      method: "POST",
      url: ROOT,
      payload: { ...createBody, owner: "me", podSecrets: ["TOKEN", " TOKEN ", " "] },
    });
    expect(response.statusCode).toBe(201);
    expect(mocks.createTaskConfig).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: "user-1", podSecrets: ["TOKEN"] }),
    );
    expect(mocks.podSecretsSelectionError).toHaveBeenCalledExactlyOnceWith(["TOKEN"], {
      workspaceId: "ws-1",
      ownerUserId: "user-1",
    });
  });
  it("local work always uses the signed-in owner, even when workspace ownership was requested", async () => {
    const location = {
      runTarget: "local",
      localHostId: HOST_ID,
      localDir: "/safe/repo",
      localSessionMode: "headless",
    };
    mocks.validateRunLocation.mockResolvedValue({ ok: true, location });
    const response = await (
      await appFor()
    ).inject({
      method: "POST",
      url: ROOT,
      payload: { ...createBody, ...location, owner: "workspace", agentType: "codex" },
    });
    expect(response.statusCode).toBe(201);
    expect(mocks.createTaskConfig).toHaveBeenCalledWith(
      expect.objectContaining({ ...location, ownerUserId: "user-1" }),
    );
    expect(mocks.validateRunLocation).toHaveBeenCalledWith(
      expect.objectContaining(location),
      "user-1",
    );
    expect(mocks.providerSelectionError).toHaveBeenCalledWith(
      expect.objectContaining({ runsOn: "local", agentType: "codex", ownerUserId: "user-1" }),
    );
    expect(mocks.podSecretsSelectionError).not.toHaveBeenCalled();
  });
  it.each(["POST", "PATCH"] as const)(
    "rejects an invalid run location before persisting (%s)",
    async (method) => {
      mocks.validateRunLocation.mockResolvedValue({ ok: false, error: "Machine is not yours" });
      const response = await (
        await appFor()
      ).inject({
        method,
        url: method === "POST" ? ROOT : PATH,
        payload: method === "POST" ? createBody : { localHostId: HOST_ID },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Machine is not yours" });
      expectNoWrites();
    },
  );
  it.each(["POST", "PATCH"] as const)(
    "rejects a credential unusable by the selected owner (%s)",
    async (method) => {
      mocks.credentialSelectionError.mockResolvedValue(
        "The credential is private to another owner",
      );
      const payload =
        method === "POST"
          ? { ...createBody, agentOptions: { credential: "secret:other" } }
          : { agentOptions: { credential: "secret:other" } };
      const response = await (
        await appFor()
      ).inject({ method, url: method === "POST" ? ROOT : PATH, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("private to another owner");
      expectNoWrites();
    },
  );
  it("a partial runtime patch validates the merged stored location", async () => {
    const storedLocation = {
      runTarget: "local",
      localHostId: HOST_ID,
      localDir: "/safe/repo",
      localSessionMode: "headless",
    };
    mocks.getTaskConfig.mockResolvedValue({ ...config, ...storedLocation });
    mocks.validateRunLocation.mockResolvedValue({ ok: true, location: storedLocation });
    const response = await (
      await appFor()
    ).inject({ method: "PATCH", url: PATH, payload: { agentType: "codex" } });
    expect(response.statusCode).toBe(200);
    expect(mocks.validateRunLocation).toHaveBeenCalledExactlyOnceWith(
      { ...storedLocation, agentType: "codex", repoUrl: config.repoUrl },
      "user-1",
    );
    expect(mocks.updateTaskConfig).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ agentType: "codex", ...storedLocation }),
    );
  });
  it("moving local work back to a pod retains explicit nulls rather than resurrecting stored values", async () => {
    mocks.getTaskConfig.mockResolvedValue({
      ...config,
      runTarget: "local",
      localHostId: HOST_ID,
      localDir: "/safe/repo",
      localSessionMode: "headless",
    });
    const response = await (
      await appFor()
    ).inject({
      method: "PATCH",
      url: PATH,
      payload: { ...clusterLocation, agentType: null, repoUrl: "https://github.com/acme/other" },
    });
    expect(response.statusCode).toBe(200);
    expect(mocks.validateRunLocation).toHaveBeenCalledExactlyOnceWith(
      { ...clusterLocation, agentType: null, repoUrl: "https://github.com/acme/other" },
      "user-1",
    );
    expect(mocks.providerSelectionError).toHaveBeenCalledWith(
      expect.objectContaining({ agentType: "claude-code", runsOn: "pod" }),
    );
  });
  it.each([true, false, undefined])(
    "records enable, disable and ordinary update actions without revalidating untouched credentials (%s)",
    async (enabled) => {
      const payload = enabled === undefined ? { title: "New title" } : { enabled };
      const response = await (await appFor()).inject({ method: "PATCH", url: PATH, payload });
      expect(response.statusCode).toBe(200);
      expect(mocks.validateRunLocation).not.toHaveBeenCalled();
      expect(mocks.providerSelectionError).not.toHaveBeenCalled();
      expect(mocks.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action:
            enabled === undefined
              ? "task_config.update"
              : enabled
                ? "task_config.enable"
                : "task_config.disable",
        }),
      );
    },
  );
  it("allows the owner to return work to the workspace and clear its selected secrets", async () => {
    const response = await (
      await appFor()
    ).inject({ method: "PATCH", url: PATH, payload: { owner: "workspace", podSecrets: null } });
    expect(response.statusCode).toBe(200);
    expect(mocks.updateTaskConfig).toHaveBeenCalledExactlyOnceWith(ID, {
      ownerUserId: null,
      podSecrets: null,
    });
  });
  it("does not let a member claim workspace work created by someone else", async () => {
    mocks.getTaskConfig.mockResolvedValue({ ...config, ownerUserId: null, createdBy: "user-2" });
    const response = await (
      await appFor()
    ).inject({ method: "PATCH", url: PATH, payload: { owner: "me" } });
    expect(response.statusCode).toBe(403);
    expectNoWrites();
  });
  it("returns 404 if a config disappears between read and update", async () => {
    mocks.updateTaskConfig.mockResolvedValue(null);
    const response = await (
      await appFor()
    ).inject({ method: "PATCH", url: PATH, payload: { title: "Changed" } });
    expect(response.statusCode).toBe(404);
    expect(mocks.logAction).not.toHaveBeenCalled();
  });
  it.each([
    ["POST", ROOT, createBody, "createTaskConfig"],
    ["PATCH", PATH, { title: "Changed" }, "updateTaskConfig"],
    ["POST", `${PATH}/run`, undefined, "instantiateTask"],
  ] as const)(
    "reports service failures without success audit records: %s %s",
    async (method, url, payload, service) => {
      mocks[service].mockRejectedValue(new Error("Cannot perform operation"));
      const response = await (await appFor()).inject({ method, url, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "Cannot perform operation" });
      expect(mocks.logAction).not.toHaveBeenCalled();
    },
  );
});

describe("nested task-config triggers", () => {
  it("redacts stored webhook secrets on list and update but returns a newly created secret once", async () => {
    const app = await appFor();
    const listed = await app.inject({ method: "GET", url: `${PATH}/triggers` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().triggers[0].config).toEqual({ path: "/nightly", hasSecret: true });
    expect(mocks.listTriggers).toHaveBeenCalledExactlyOnceWith("task_config", ID);
    const updated = await app.inject({
      method: "PATCH",
      url: TRIGGER_PATH,
      payload: { enabled: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().trigger.config).toEqual({ path: "/nightly", hasSecret: true });
    const created = await app.inject({
      method: "POST",
      url: `${PATH}/triggers`,
      payload: {
        type: "webhook",
        config: trigger.config,
        paramMapping: { issue: "$.issue.id" },
        enabled: false,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().trigger.config.secret).toBe("stored-trigger-secret");
    expect(mocks.createTrigger).toHaveBeenCalledExactlyOnceWith({
      targetType: "task_config",
      targetId: ID,
      type: "webhook",
      config: trigger.config,
      paramMapping: { issue: "$.issue.id" },
      enabled: false,
    });
  });
  it.each(["PATCH", "DELETE"] as const)(
    "rejects a trigger from another parent before mutation (%s)",
    async (method) => {
      mocks.readRows.mockResolvedValue([{ ...trigger, targetId: "other-blueprint" }]);
      const response = await (
        await appFor()
      ).inject({
        method,
        url: TRIGGER_PATH,
        ...(method === "PATCH" ? { payload: { enabled: false } } : {}),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Trigger not found" });
      expectNoWrites();
    },
  );
  it.each(["PATCH", "DELETE"] as const)(
    "rejects a trigger targeting a different resource kind (%s)",
    async (method) => {
      mocks.readRows.mockResolvedValue([{ ...trigger, targetType: "job" }]);
      const response = await (
        await appFor()
      ).inject({
        method,
        url: TRIGGER_PATH,
        ...(method === "PATCH" ? { payload: { enabled: false } } : {}),
      });
      expect(response.statusCode).toBe(404);
      expectNoWrites();
    },
  );
  it.each(["PATCH", "DELETE"] as const)(
    "returns 404 for a nonexistent trigger (%s)",
    async (method) => {
      mocks.readRows.mockResolvedValue([]);
      const response = await (
        await appFor()
      ).inject({
        method,
        url: TRIGGER_PATH,
        ...(method === "PATCH" ? { payload: { enabled: false } } : {}),
      });
      expect(response.statusCode).toBe(404);
      expectNoWrites();
    },
  );
  it("validates replacement config against the stored trigger type and redacts the response", async () => {
    const response = await (
      await appFor()
    ).inject({
      method: "PATCH",
      url: TRIGGER_PATH,
      payload: { config: { path: "/new-path", secret: "rotated-secret" } },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().trigger.config).toEqual({ path: "/new-path", hasSecret: true });
    expect(mocks.updateTrigger).toHaveBeenCalledExactlyOnceWith("trigger-1", {
      config: { path: "/new-path", secret: "rotated-secret" },
    });
  });
  it.each(["POST", "PATCH"] as const)(
    "rejects invalid trigger config before writes (%s)",
    async (method) => {
      const response = await (
        await appFor()
      ).inject({
        method,
        url: method === "POST" ? `${PATH}/triggers` : TRIGGER_PATH,
        payload: method === "POST" ? { type: "schedule", config: {} } : { config: {} },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatch(/cronExpression|path/);
      expectNoWrites();
    },
  );
  it.each(["POST", "PATCH"] as const)(
    "reports duplicate webhook paths as conflicts (%s)",
    async (method) => {
      (method === "POST" ? mocks.createTrigger : mocks.updateTrigger).mockRejectedValue(
        new Error("duplicate_webhook_path"),
      );
      const response = await (
        await appFor()
      ).inject({
        method,
        url: method === "POST" ? `${PATH}/triggers` : TRIGGER_PATH,
        payload:
          method === "POST"
            ? { type: "webhook", config: { path: "/taken" } }
            : { config: { path: "/taken" } },
      });
      expect(response.statusCode).toBe(409);
      expect(mocks.logAction).not.toHaveBeenCalled();
    },
  );
  it.each(["POST", "PATCH"] as const)(
    "reports other trigger write failures without a success audit (%s)",
    async (method) => {
      (method === "POST" ? mocks.createTrigger : mocks.updateTrigger).mockRejectedValue(
        "trigger storage unavailable",
      );
      const response = await (
        await appFor()
      ).inject({
        method,
        url: method === "POST" ? `${PATH}/triggers` : TRIGGER_PATH,
        payload: method === "POST" ? { type: "manual" } : { enabled: false },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "trigger storage unavailable" });
      expect(mocks.logAction).not.toHaveBeenCalled();
    },
  );
  it("returns 404 if the trigger disappears during an update", async () => {
    mocks.updateTrigger.mockResolvedValue(null);
    const response = await (
      await appFor()
    ).inject({ method: "PATCH", url: TRIGGER_PATH, payload: { enabled: false } });
    expect(response.statusCode).toBe(404);
    expect(mocks.logAction).not.toHaveBeenCalled();
  });
  it("allows the owner to remove a trigger and audit the parent binding", async () => {
    const response = await (await appFor()).inject({ method: "DELETE", url: TRIGGER_PATH });
    expect(response.statusCode).toBe(204);
    expect(mocks.deleteTrigger).toHaveBeenCalledExactlyOnceWith("trigger-1");
    expect(mocks.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "task_config_trigger.delete",
        params: { taskConfigId: ID, triggerId: "trigger-1" },
      }),
    );
  });
});
