import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockGetWebhookTriggerByPath = vi.fn();
const mockGetTrigger = vi.fn();
const mockGetDefinition = vi.fn();
const mockCreateWorkflowRun = vi.fn();
const mockInstantiateTask = vi.fn();
/** The dispatcher's `fireTrigger`, spied: calls through unless a test says otherwise. */
const { mockFireTrigger } = vi.hoisted(() => ({ mockFireTrigger: vi.fn() }));

// The route finds the trigger through the trigger service and fires it
// through the dispatcher, which looks the target up as a work definition and
// starts it through the per-kind services mocked here.
vi.mock("../services/trigger-service.js", () => ({
  getWebhookTriggerByPath: (...args: unknown[]) => mockGetWebhookTriggerByPath(...args),
  getTrigger: (...args: unknown[]) => mockGetTrigger(...args),
  markTriggerFired: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../services/trigger-dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/trigger-dispatch.js")>();
  return { ...actual, fireTrigger: (...args: unknown[]) => mockFireTrigger(...args) };
});

vi.mock("../services/work-definition-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/work-definition-service.js")>();
  return {
    definitionKindOf: actual.definitionKindOf,
    getDefinition: (...args: unknown[]) => mockGetDefinition(...args),
  };
});

vi.mock("../services/workflow-service.js", () => ({
  createWorkflowRun: (...args: unknown[]) => mockCreateWorkflowRun(...args),
}));

vi.mock("../services/task-config-service.js", () => ({
  instantiateTask: (...args: unknown[]) => mockInstantiateTask(...args),
}));

import { hookRoutes } from "./hooks.js";

// ─── Helpers ───

function hmacSign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

async function buildTestApp(): Promise<FastifyInstance> {
  // The spy calls the real dispatcher unless a test overrides it.
  const actual = await vi.importActual<typeof import("../services/trigger-dispatch.js")>(
    "../services/trigger-dispatch.js",
  );
  mockFireTrigger.mockImplementation(actual.fireTrigger as (...args: unknown[]) => unknown);
  return buildRouteTestApp(hookRoutes, { user: null });
}

const TRIGGER = {
  id: "trig-1",
  workflowId: "wf-1",
  targetType: "job",
  targetId: "wf-1",
  type: "webhook",
  config: { webhookPath: "my-hook", secret: "test-secret" },
  paramMapping: null,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const TASK_CONFIG_TRIGGER = {
  id: "trig-tc-1",
  workflowId: null,
  targetType: "task_config",
  targetId: "tc-1",
  type: "webhook",
  config: { webhookPath: "tc-hook", secret: "test-secret" },
  paramMapping: null,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** The Job the webhook fires — a `standalone` work definition. */
const WORKFLOW = {
  id: "wf-1",
  kind: "standalone",
  name: "Deploy",
  enabled: true,
  prompt: "Do the thing",
};

describe("POST /api/hooks/:webhookPath", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns 202 with runId on valid webhook", async () => {
    mockGetWebhookTriggerByPath.mockResolvedValue(TRIGGER);
    mockGetDefinition.mockResolvedValue(WORKFLOW);
    mockCreateWorkflowRun.mockResolvedValue({ id: "run-1", state: "queued" });

    const body = JSON.stringify({ ref: "main" });
    const sig = hmacSign(body, "test-secret");

    const res = await app.inject({
      method: "POST",
      url: "/api/hooks/my-hook",
      headers: {
        "content-type": "application/json",
        "x-optio-signature": sig,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    const json = res.json();
    expect(json.runId).toBe("run-1");
    expect(mockGetDefinition).toHaveBeenCalledWith("wf-1", "standalone");
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith("wf-1", {
      triggerId: "trig-1",
      params: expect.any(Object),
    });
  });

  it("returns 404 when trigger not found", async () => {
    mockGetWebhookTriggerByPath.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/hooks/nonexistent",
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });

  it("returns 404 when trigger is disabled", async () => {
    mockGetWebhookTriggerByPath.mockResolvedValue({ ...TRIGGER, enabled: false });

    const res = await app.inject({
      method: "POST",
      url: "/api/hooks/disabled-hook",
      payload: {},
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });

  it("returns 404 when workflow not found", async () => {
    mockGetWebhookTriggerByPath.mockResolvedValue(TRIGGER);
    mockGetDefinition.mockResolvedValue(null);

    const body = JSON.stringify({});
    const sig = hmacSign(body, "test-secret");

    const res = await app.inject({
      method: "POST",
      url: "/api/hooks/my-hook",
      headers: { "x-optio-signature": sig, "content-type": "application/json" },
      payload: body,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found or disabled");
  });

  it("returns 404 when workflow is disabled", async () => {
    mockGetWebhookTriggerByPath.mockResolvedValue(TRIGGER);
    mockGetDefinition.mockResolvedValue({ ...WORKFLOW, enabled: false });

    const body = JSON.stringify({});
    const sig = hmacSign(body, "test-secret");

    const res = await app.inject({
      method: "POST",
      url: "/api/hooks/my-hook",
      headers: { "x-optio-signature": sig, "content-type": "application/json" },
      payload: body,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("disabled");
  });

  it("returns 401 when HMAC signature is missing and secret is configured", async () => {
    mockGetWebhookTriggerByPath.mockResolvedValue(TRIGGER);

    const res = await app.inject({
      method: "POST",
      url: "/api/hooks/my-hook",
      payload: { ref: "main" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toContain("signature");
  });

  it("returns 401 when HMAC signature is invalid", async () => {
    mockGetWebhookTriggerByPath.mockResolvedValue(TRIGGER);

    const body = JSON.stringify({ ref: "main" });

    const res = await app.inject({
      method: "POST",
      url: "/api/hooks/my-hook",
      headers: {
        "content-type": "application/json",
        "x-optio-signature": "deadbeef",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toContain("Invalid signature");
  });

  it("skips HMAC verification when no secret is configured", async () => {
    const triggerNoSecret = {
      ...TRIGGER,
      config: { webhookPath: "open-hook" },
    };
    mockGetWebhookTriggerByPath.mockResolvedValue(triggerNoSecret);
    mockGetDefinition.mockResolvedValue(WORKFLOW);
    mockCreateWorkflowRun.mockResolvedValue({ id: "run-2", state: "queued" });

    const res = await app.inject({
      method: "POST",
      url: "/api/hooks/open-hook",
      payload: { ref: "main" },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().runId).toBe("run-2");
  });

  it("applies param mapping from JSON path expressions", async () => {
    const triggerWithMapping = {
      ...TRIGGER,
      config: { webhookPath: "mapped-hook", secret: "test-secret" },
      paramMapping: {
        branch: "$.ref",
        repo: "$.repository.full_name",
        action: "$.action",
      },
    };
    mockGetWebhookTriggerByPath.mockResolvedValue(triggerWithMapping);
    mockGetDefinition.mockResolvedValue(WORKFLOW);
    mockCreateWorkflowRun.mockResolvedValue({ id: "run-3", state: "queued" });

    const payload = {
      ref: "refs/heads/main",
      repository: { full_name: "org/repo" },
      action: "push",
    };
    const body = JSON.stringify(payload);
    const sig = hmacSign(body, "test-secret");

    const res = await app.inject({
      method: "POST",
      url: "/api/hooks/mapped-hook",
      headers: {
        "content-type": "application/json",
        "x-optio-signature": sig,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith("wf-1", {
      triggerId: "trig-1",
      params: {
        branch: "refs/heads/main",
        repo: "org/repo",
        action: "push",
      },
    });
  });

  it("passes raw body as params when no param mapping is configured", async () => {
    const triggerNoMapping = {
      ...TRIGGER,
      paramMapping: null,
    };
    mockGetWebhookTriggerByPath.mockResolvedValue(triggerNoMapping);
    mockGetDefinition.mockResolvedValue(WORKFLOW);
    mockCreateWorkflowRun.mockResolvedValue({ id: "run-4", state: "queued" });

    const payload = { ref: "main", action: "push" };
    const body = JSON.stringify(payload);
    const sig = hmacSign(body, "test-secret");

    const res = await app.inject({
      method: "POST",
      url: "/api/hooks/my-hook",
      headers: {
        "content-type": "application/json",
        "x-optio-signature": sig,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith("wf-1", {
      triggerId: "trig-1",
      params: payload,
    });
  });

  it("dispatches task_config webhook triggers to instantiateTask", async () => {
    mockGetWebhookTriggerByPath.mockResolvedValue(TASK_CONFIG_TRIGGER);
    mockGetDefinition.mockResolvedValue({
      id: "tc-1",
      kind: "repo-blueprint",
      name: "CVE patch",
      enabled: true,
    });
    mockInstantiateTask.mockResolvedValue({ id: "task-42" });

    const body = JSON.stringify({ severity: "high" });
    const sig = hmacSign(body, "test-secret");

    const res = await app.inject({
      method: "POST",
      url: "/api/hooks/tc-hook",
      headers: { "content-type": "application/json", "x-optio-signature": sig },
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ taskId: "task-42" });
    expect(mockGetDefinition).toHaveBeenCalledWith("tc-1", "repo-blueprint");
    expect(mockInstantiateTask).toHaveBeenCalledWith("tc-1", {
      triggerId: "trig-tc-1",
      params: { severity: "high" },
      ticket: undefined,
    });
    expect(mockCreateWorkflowRun).not.toHaveBeenCalled();
  });

  it("returns 404 when task_config webhook target is disabled", async () => {
    mockGetWebhookTriggerByPath.mockResolvedValue(TASK_CONFIG_TRIGGER);
    mockGetDefinition.mockResolvedValue({
      id: "tc-1",
      kind: "repo-blueprint",
      name: "Off",
      enabled: false,
    });

    const body = JSON.stringify({});
    const sig = hmacSign(body, "test-secret");

    const res = await app.inject({
      method: "POST",
      url: "/api/hooks/tc-hook",
      headers: { "content-type": "application/json", "x-optio-signature": sig },
      payload: body,
    });

    expect(res.statusCode).toBe(404);
    expect(mockInstantiateTask).not.toHaveBeenCalled();
  });

  it("handles nested JSON path expressions gracefully when path does not exist", async () => {
    const triggerWithMapping = {
      ...TRIGGER,
      config: { webhookPath: "mapped-hook", secret: "test-secret" },
      paramMapping: {
        branch: "$.ref",
        missing: "$.does.not.exist",
      },
    };
    mockGetWebhookTriggerByPath.mockResolvedValue(triggerWithMapping);
    mockGetDefinition.mockResolvedValue(WORKFLOW);
    mockCreateWorkflowRun.mockResolvedValue({ id: "run-5", state: "queued" });

    const payload = { ref: "main" };
    const body = JSON.stringify(payload);
    const sig = hmacSign(body, "test-secret");

    const res = await app.inject({
      method: "POST",
      url: "/api/hooks/mapped-hook",
      headers: {
        "content-type": "application/json",
        "x-optio-signature": sig,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith("wf-1", {
      triggerId: "trig-1",
      params: {
        branch: "main",
        missing: undefined,
      },
    });
  });
});

describe("POST /api/hooks/pylon/:triggerId", () => {
  let app: FastifyInstance;
  const PYLON_ID = "6f1c4d2e-1111-4aaa-9bbb-000000000001";
  const PYLON_TRIGGER = {
    id: PYLON_ID,
    workflowId: "wf-1",
    targetType: "job",
    targetId: "wf-1",
    type: "pylon",
    config: { secret: "pylon-shared", events: ["issue.created"] },
    paramMapping: null,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const DELIVERY = {
    event: "issue.created",
    issue: {
      id: "iss_1",
      number: 77,
      title: "Login broken",
      body_html: "<p>help</p>",
      state: "new",
      link: "https://app.usepylon.com/issues/77",
      account: { name: "Acme" },
      requester: { email: "alice@acme.test" },
      tags: [{ name: "bug" }],
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetTrigger.mockResolvedValue(PYLON_TRIGGER);
    mockGetDefinition.mockResolvedValue(WORKFLOW);
    mockCreateWorkflowRun.mockResolvedValue({ id: "run-py", state: "queued" });
    app = await buildTestApp();
  });

  const post = (
    headers: Record<string, string>,
    payload: Record<string, unknown> = DELIVERY,
    id = PYLON_ID,
  ) => app.inject({ method: "POST", url: `/api/hooks/pylon/${id}`, headers, payload });

  it("fires that trigger with the issue's fields when X-Optio-Secret matches", async () => {
    const res = await post({ "x-optio-secret": "pylon-shared" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ runId: "run-py" });
    expect(mockGetTrigger).toHaveBeenCalledWith(PYLON_ID);
    expect(mockFireTrigger).toHaveBeenCalledTimes(1);
    expect(mockFireTrigger).toHaveBeenCalledWith(
      PYLON_TRIGGER,
      expect.objectContaining({
        source: "pylon",
        title: "#77 Login broken",
        ticket: { source: "pylon", externalId: "iss_1", url: "https://app.usepylon.com/issues/77" },
      }),
    );
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith("wf-1", {
      triggerId: PYLON_ID,
      params: expect.objectContaining({
        source: "pylon",
        event: "issue.created",
        issueId: "iss_1",
        issueNumber: "77",
        title: "Login broken",
        account: "Acme",
        requester: "alice@acme.test",
        tags: "bug",
      }),
    });
    // Only the addressed trigger fires — nothing is looked up by path.
    expect(mockGetWebhookTriggerByPath).not.toHaveBeenCalled();
  });

  it("takes the secret as a Bearer token too", async () => {
    const res = await post({ authorization: "Bearer pylon-shared" });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ runId: "run-py" });
  });

  it("returns 401 for a wrong or missing secret without firing", async () => {
    const wrong = await post({ "x-optio-secret": "nope" });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toMatch(/X-Optio-Secret/);
    const missing = await post({});
    expect(missing.statusCode).toBe(401);
    const otherAuth = await post({ authorization: "Basic abc" });
    expect(otherAuth.statusCode).toBe(401);
    expect(mockFireTrigger).not.toHaveBeenCalled();
  });

  it("returns 404 for a disabled trigger, another type, or an unknown id", async () => {
    mockGetTrigger.mockResolvedValue({ ...PYLON_TRIGGER, enabled: false });
    expect((await post({ "x-optio-secret": "pylon-shared" })).statusCode).toBe(404);
    mockGetTrigger.mockResolvedValue({ ...PYLON_TRIGGER, type: "webhook" });
    expect((await post({ "x-optio-secret": "pylon-shared" })).statusCode).toBe(404);
    mockGetTrigger.mockResolvedValue(null);
    expect((await post({ "x-optio-secret": "pylon-shared" })).statusCode).toBe(404);
    expect(mockFireTrigger).not.toHaveBeenCalled();
    // Not a uuid: schema validation, before any lookup.
    const bad = await post({ "x-optio-secret": "pylon-shared" }, DELIVERY, "not-a-uuid");
    expect(bad.statusCode).toBe(400);
  });

  it("answers 202 matched:false when the event kind isn't one it listens for", async () => {
    const res = await post(
      { "x-optio-secret": "pylon-shared" },
      { ...DELIVERY, event: "issue.closed" },
    );
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ matched: false });
    expect(mockFireTrigger).not.toHaveBeenCalled();
  });

  it("fires any kind for a trigger with no events filter, with the whole payload", async () => {
    mockGetTrigger.mockResolvedValue({ ...PYLON_TRIGGER, config: { secret: "pylon-shared" } });
    const res = await post({ "x-optio-secret": "pylon-shared" }, { hello: "world" });
    expect(res.statusCode).toBe(202);
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith("wf-1", {
      triggerId: PYLON_ID,
      params: expect.objectContaining({ source: "pylon", event: "", payload: '{"hello":"world"}' }),
    });
  });

  it("answers 404 when the target can't start (not a 500)", async () => {
    mockFireTrigger.mockResolvedValueOnce(null);
    const gone = await post({ "x-optio-secret": "pylon-shared" });
    expect(gone.statusCode).toBe(404);
    mockFireTrigger.mockRejectedValueOnce(new Error("no host"));
    const failed = await post({ "x-optio-secret": "pylon-shared" });
    expect(failed.statusCode).toBe(404);
    expect(failed.json().error).toBe("no host");
  });
});
