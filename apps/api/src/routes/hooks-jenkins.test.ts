/**
 * `/api/hooks/jenkins/:triggerId`: Jenkins can't sign, so the delivery
 * carries its trigger's own secret; the build is matched against that
 * trigger's filters and fired for it alone, keyed by job, build and result
 * so the Notification plugin's COMPLETED and FINALIZED start one run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const mockGetTrigger = vi.fn();
const { mockFireDurably } = vi.hoisted(() => ({ mockFireDurably: vi.fn() }));

vi.mock("../services/trigger-service.js", () => ({
  getWebhookTriggerByPath: vi.fn(),
  getTrigger: (...args: unknown[]) => mockGetTrigger(...args),
  markTriggerFired: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../services/trigger-dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/trigger-dispatch.js")>();
  return { ...actual, fireTrigger: vi.fn() };
});
vi.mock("../services/trigger-delivery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/trigger-delivery.js")>();
  return {
    ...actual,
    fireTriggerDurably: (...args: unknown[]) => mockFireDurably(...args),
  };
});

import { hookRoutes } from "./hooks.js";
import { deliveryKey } from "../services/trigger-delivery.js";

const ID = "6f1c4d2e-4444-4aaa-9bbb-000000000001";
const TRIGGER = {
  id: ID,
  targetType: "task_config",
  targetId: "cfg-1",
  type: "jenkins",
  config: { secret: "jk-shared", events: ["failed", "unstable"], jobs: ["platform/api/*"] },
  paramMapping: null,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const build = (phase: string, status: string, job = "main") => ({
  name: job,
  url: `job/platform/job/api/job/${job}/`,
  build: {
    full_url: `https://jenkins.example.com/job/platform/job/api/job/${job}/42/`,
    number: 42,
    phase,
    status,
    scm: {
      url: "https://gitlab.example.com/platform/api.git",
      branch: "origin/main",
      commit: "abc",
    },
  },
});

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mockGetTrigger.mockImplementation(async (id: string) => (id === ID ? TRIGGER : null));
  mockFireDurably.mockResolvedValue({ kind: "task", id: "task-1" });
  app = await buildRouteTestApp(hookRoutes, { user: null });
});

const post = (headers: Record<string, string>, payload: Record<string, unknown>, id = ID) =>
  app.inject({ method: "POST", url: `/api/hooks/jenkins/${id}`, headers, payload });

describe("POST /api/hooks/jenkins/:triggerId", () => {
  it("fires the trigger with the build's facts when X-Optio-Secret matches", async () => {
    const res = await post({ "x-optio-secret": "jk-shared" }, build("COMPLETED", "FAILURE"));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ taskId: "task-1" });
    expect(mockFireDurably).toHaveBeenCalledWith(
      expect.objectContaining({ id: ID }),
      expect.objectContaining({
        source: "jenkins",
        title: "platform/api/main #42 failed",
        repoUrlHint: "https://gitlab.example.com/platform/api.git",
        params: expect.objectContaining({ job: "platform/api/main", branch: "main", number: "42" }),
      }),
      `hook:${ID}:${deliveryKey("jenkins:platform/api/main#42:failed")}`,
    );
  });

  it("gives COMPLETED and FINALIZED of one build the same delivery key", async () => {
    await post({ authorization: "Bearer jk-shared" }, build("COMPLETED", "FAILURE"));
    await post({ authorization: "Bearer jk-shared" }, build("FINALIZED", "FAILURE"));
    const keys = mockFireDurably.mock.calls.map((c) => c[2]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it("lets an Idempotency-Key header decide the delivery's identity", async () => {
    await post(
      { "x-optio-secret": "jk-shared", "idempotency-key": "retry-1" },
      build("COMPLETED", "FAILURE"),
    );
    expect(mockFireDurably.mock.calls[0][2]).toBe(`hook:${ID}:${deliveryKey("retry-1")}`);
  });

  it("answers matched:false for a result or job the trigger doesn't listen for", async () => {
    const ok = await post({ "x-optio-secret": "jk-shared" }, build("COMPLETED", "SUCCESS"));
    expect(ok.json()).toEqual({ matched: false });
    const other = await post(
      { "x-optio-secret": "jk-shared" },
      { ...build("COMPLETED", "FAILURE"), url: "job/platform/job/web/job/main/" },
    );
    expect(other.json()).toEqual({ matched: false });
    const queued = await post({ "x-optio-secret": "jk-shared" }, build("QUEUED", ""));
    expect(queued.json()).toEqual({ matched: false });
    expect(mockFireDurably).not.toHaveBeenCalled();
  });

  it("rejects a wrong or missing secret, and 404s an unknown trigger", async () => {
    expect(
      (await post({ "x-optio-secret": "nope" }, build("COMPLETED", "FAILURE"))).statusCode,
    ).toBe(401);
    expect((await post({}, build("COMPLETED", "FAILURE"))).statusCode).toBe(401);
    const unknown = await post(
      { "x-optio-secret": "jk-shared" },
      build("COMPLETED", "FAILURE"),
      "6f1c4d2e-4444-4aaa-9bbb-000000000099",
    );
    expect(unknown.statusCode).toBe(404);
    expect(mockFireDurably).not.toHaveBeenCalled();
  });
});
