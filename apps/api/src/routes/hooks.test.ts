import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Mocks ───

const mockGetWebhookTriggerByPath = vi.fn();
const mockGetWorkflow = vi.fn();
const mockCreateWorkflowRun = vi.fn();

vi.mock("../services/workflow-service.js", () => ({
  getWebhookTriggerByPath: (...args: unknown[]) => mockGetWebhookTriggerByPath(...args),
  getWorkflow: (...args: unknown[]) => mockGetWorkflow(...args),
  createWorkflowRun: (...args: unknown[]) => mockCreateWorkflowRun(...args),
}));

import { hookRoutes } from "./hooks.js";

// ─── Helpers ───

function hmacSign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await hookRoutes(app);
  await app.ready();
  return app;
}

const TRIGGER = {
  id: "trig-1",
  workflowId: "wf-1",
  type: "webhook",
  config: { webhookPath: "my-hook", secret: "test-secret" },
  paramMapping: null,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const WORKFLOW = {
  id: "wf-1",
  name: "Deploy",
  enabled: true,
  promptTemplate: "Do the thing",
};

describe("POST /api/hooks/:webhookPath", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns 202 with runId on valid webhook", async () => {
    mockGetWebhookTriggerByPath.mockResolvedValue(TRIGGER);
    mockGetWorkflow.mockResolvedValue(WORKFLOW);
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
    mockGetWorkflow.mockResolvedValue(null);

    const body = JSON.stringify({});
    const sig = hmacSign(body, "test-secret");

    const res = await app.inject({
      method: "POST",
      url: "/api/hooks/my-hook",
      headers: { "x-optio-signature": sig, "content-type": "application/json" },
      payload: body,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("Workflow not found");
  });

  it("returns 404 when workflow is disabled", async () => {
    mockGetWebhookTriggerByPath.mockResolvedValue(TRIGGER);
    mockGetWorkflow.mockResolvedValue({ ...WORKFLOW, enabled: false });

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
    mockGetWorkflow.mockResolvedValue(WORKFLOW);
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
    mockGetWorkflow.mockResolvedValue(WORKFLOW);
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
    mockGetWorkflow.mockResolvedValue(WORKFLOW);
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
    mockGetWorkflow.mockResolvedValue(WORKFLOW);
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
