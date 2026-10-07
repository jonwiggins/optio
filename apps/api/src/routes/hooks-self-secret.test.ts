/**
 * The self-secret receivers after Pylon: `/api/hooks/alertmanager/:id` and
 * `/api/hooks/datadog/:id`. Each is addressed to one trigger, checks that
 * trigger's own secret (header, Bearer, or basic-auth password), matches
 * the delivery against the trigger's filters, and fires it alone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const mockGetWebhookTriggerByPath = vi.fn();
const mockGetTrigger = vi.fn();
const mockGetDefinition = vi.fn();
const mockCreateWorkflowRun = vi.fn();
const { mockFireTrigger } = vi.hoisted(() => ({ mockFireTrigger: vi.fn() }));

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
vi.mock("../services/task-config-service.js", () => ({ instantiateTask: vi.fn() }));

import { hookRoutes } from "./hooks.js";

const WORKFLOW = { id: "wf-1", kind: "standalone", name: "On call", enabled: true, prompt: "p" };
const AM_ID = "6f1c4d2e-2222-4aaa-9bbb-000000000001";
const DD_ID = "6f1c4d2e-3333-4aaa-9bbb-000000000001";
const trigger = (id: string, type: string, config: Record<string, unknown>) => ({
  id,
  workflowId: "wf-1",
  targetType: "job",
  targetId: "wf-1",
  type,
  config,
  paramMapping: null,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
});
const AM_TRIGGER = trigger(AM_ID, "alertmanager", {
  secret: "am-shared",
  events: ["firing"],
  severities: ["critical"],
});
const DD_TRIGGER = trigger(DD_ID, "datadog", {
  secret: "dd-shared",
  events: ["triggered"],
  priorities: ["P1", "P2"],
});

const GROUP = {
  version: "4",
  status: "firing",
  receiver: "optio",
  groupKey: "{}:{}",
  externalURL: "https://am",
  commonLabels: { alertname: "HighLatency", severity: "critical" },
  alerts: [
    {
      status: "firing",
      labels: { alertname: "HighLatency", severity: "critical" },
      annotations: { summary: "p99 over 2s" },
      fingerprint: "f1",
    },
  ],
};
const MONITOR = {
  id: "1",
  title: "[Triggered] CPU high",
  body: "CPU over 90%",
  alert_id: "555",
  alert_transition: "Triggered",
  alert_type: "error",
  priority: "P1",
  tags: "env:prod",
  link: "https://app.datadoghq.com/event/event?id=1",
};

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  const actual = await vi.importActual<typeof import("../services/trigger-dispatch.js")>(
    "../services/trigger-dispatch.js",
  );
  mockFireTrigger.mockImplementation(actual.fireTrigger as (...args: unknown[]) => unknown);
  mockGetDefinition.mockResolvedValue(WORKFLOW);
  mockCreateWorkflowRun.mockResolvedValue({ id: "run-x", state: "queued" });
  mockGetTrigger.mockImplementation(async (id: string) =>
    id === AM_ID ? AM_TRIGGER : id === DD_ID ? DD_TRIGGER : null,
  );
  app = await buildRouteTestApp(hookRoutes, { user: null });
});

const post = (url: string, headers: Record<string, string>, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url, headers, payload });

describe("POST /api/hooks/alertmanager/:triggerId", () => {
  it("fires the trigger with the group's fields for a Bearer secret", async () => {
    const res = await post(
      `/api/hooks/alertmanager/${AM_ID}`,
      { authorization: "Bearer am-shared" },
      GROUP,
    );
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ runId: "run-x" });
    expect(mockFireTrigger).toHaveBeenCalledWith(
      AM_TRIGGER,
      expect.objectContaining({ source: "alertmanager", title: "[FIRING] HighLatency" }),
    );
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith("wf-1", {
      triggerId: AM_ID,
      params: expect.objectContaining({
        source: "alertmanager",
        event: "firing",
        alertnames: "HighLatency",
        severities: "critical",
        count: "1",
        receiver: "optio",
      }),
    });
    expect(mockGetWebhookTriggerByPath).not.toHaveBeenCalled();
  });

  it("takes the secret as a basic-auth password (Alertmanager's basic_auth) too", async () => {
    const basic = Buffer.from("optio:am-shared").toString("base64");
    const res = await post(
      `/api/hooks/alertmanager/${AM_ID}`,
      { authorization: `Basic ${basic}` },
      GROUP,
    );
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ runId: "run-x" });
  });

  it("rejects a wrong or missing secret, and a trigger of another type at this URL", async () => {
    const wrong = await post(`/api/hooks/alertmanager/${AM_ID}`, { "x-optio-secret": "no" }, GROUP);
    expect(wrong.statusCode).toBe(401);
    const missing = await post(`/api/hooks/alertmanager/${AM_ID}`, {}, GROUP);
    expect(missing.statusCode).toBe(401);
    // A Datadog trigger's id at the Alertmanager URL is not an Alertmanager trigger.
    const other = await post(
      `/api/hooks/alertmanager/${DD_ID}`,
      { "x-optio-secret": "dd-shared" },
      GROUP,
    );
    expect(other.statusCode).toBe(404);
    expect(other.json().error).toBe("Alertmanager trigger not found");
    expect(mockFireTrigger).not.toHaveBeenCalled();
  });

  it("answers 202 matched:false when the group doesn't pass the trigger's filters", async () => {
    const res = await post(
      `/api/hooks/alertmanager/${AM_ID}`,
      { "x-optio-secret": "am-shared" },
      { ...GROUP, status: "resolved" },
    );
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ matched: false });
    const warning = await post(
      `/api/hooks/alertmanager/${AM_ID}`,
      { "x-optio-secret": "am-shared" },
      {
        ...GROUP,
        alerts: [{ ...GROUP.alerts[0], labels: { alertname: "x", severity: "warning" } }],
      },
    );
    expect(warning.json()).toEqual({ matched: false });
    expect(mockFireTrigger).not.toHaveBeenCalled();
  });
});

describe("POST /api/hooks/datadog/:triggerId", () => {
  it("fires the trigger with the monitor's fields when X-Optio-Secret matches", async () => {
    const res = await post(
      `/api/hooks/datadog/${DD_ID}`,
      { "x-optio-secret": "dd-shared" },
      MONITOR,
    );
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ runId: "run-x" });
    expect(mockFireTrigger).toHaveBeenCalledWith(
      DD_TRIGGER,
      expect.objectContaining({ source: "datadog", title: "[Triggered] CPU high" }),
    );
    expect(mockCreateWorkflowRun).toHaveBeenCalledWith("wf-1", {
      triggerId: DD_ID,
      params: expect.objectContaining({
        source: "datadog",
        event: "triggered",
        transition: "Triggered",
        alertId: "555",
        priority: "P1",
        tags: "env:prod",
      }),
    });
  });

  it("filters on the transition and priority, and rejects the wrong secret", async () => {
    const recovered = await post(
      `/api/hooks/datadog/${DD_ID}`,
      { "x-optio-secret": "dd-shared" },
      { ...MONITOR, alert_transition: "Recovered", alert_type: "success" },
    );
    expect(recovered.statusCode).toBe(202);
    expect(recovered.json()).toEqual({ matched: false });
    const low = await post(
      `/api/hooks/datadog/${DD_ID}`,
      { "x-optio-secret": "dd-shared" },
      { ...MONITOR, priority: "P4" },
    );
    expect(low.json()).toEqual({ matched: false });
    const wrong = await post(
      `/api/hooks/datadog/${DD_ID}`,
      { authorization: "Bearer nope" },
      MONITOR,
    );
    expect(wrong.statusCode).toBe(401);
    expect(mockFireTrigger).not.toHaveBeenCalled();
  });

  it("404s an unknown or disabled trigger", async () => {
    mockGetTrigger.mockResolvedValueOnce({ ...DD_TRIGGER, enabled: false });
    const disabled = await post(
      `/api/hooks/datadog/${DD_ID}`,
      { "x-optio-secret": "dd-shared" },
      MONITOR,
    );
    expect(disabled.statusCode).toBe(404);
    const unknown = await post(
      "/api/hooks/datadog/6f1c4d2e-9999-4aaa-9bbb-000000000009",
      { "x-optio-secret": "dd-shared" },
      MONITOR,
    );
    expect(unknown.statusCode).toBe(404);
  });
});
