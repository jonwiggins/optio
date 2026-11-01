import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const getPrInbox = vi.fn();
const setViewerHandles = vi.fn();
const sendPrToAgent = vi.fn();

vi.mock("../services/pr-inbox-service.js", () => {
  class PrInboxError extends Error {
    constructor(
      message: string,
      readonly status = 400,
    ) {
      super(message);
    }
  }
  return {
    PrInboxError,
    getPrInbox: (...a: unknown[]) => getPrInbox(...a),
    setViewerHandles: (...a: unknown[]) => setViewerHandles(...a),
    sendPrToAgent: (...a: unknown[]) => sendPrToAgent(...a),
  };
});
vi.mock("../services/optio-action-service.js", () => ({
  logAction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./work-defaults.js", () => ({ settingsUserId: async () => "user-1" }));

const { prInboxRoutes } = await import("./pr-inbox.js");
const svc = await import("../services/pr-inbox-service.js");

describe("pr-inbox routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET returns the panel and passes refresh / repoId through", async () => {
    const app = await buildRouteTestApp(prInboxRoutes);
    const body = {
      viewer: { handles: ["jon"], source: "sign-in", suggestedHandle: null },
      items: [
        {
          facts: { url: "u" },
          status: { action: "fix_ci" },
          repo: {},
          agent: null,
          optioReview: null,
        },
      ],
      errors: [],
      fetchedAt: "2026-11-01T00:00:00.000Z",
    };
    getPrInbox.mockResolvedValue(body);
    const repoId = "4a7b3a52-5b1f-4c9e-9a51-0e5d8f3f0e11";
    const res = await app.inject({
      method: "GET",
      url: `/api/pr-inbox?refresh=true&repoId=${repoId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(body);
    expect(getPrInbox).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", refresh: true, repoId }),
    );
  });

  it("PUT handles maps service errors", async () => {
    const app = await buildRouteTestApp(prInboxRoutes);
    setViewerHandles.mockResolvedValueOnce({ handles: ["kim"], source: "linked" });
    let res = await app.inject({
      method: "PUT",
      url: "/api/pr-inbox/handles",
      payload: { github: "kim" },
    });
    expect(res.json()).toEqual({ handles: ["kim"], source: "linked" });
    setViewerHandles.mockRejectedValueOnce(new svc.PrInboxError("bad handle"));
    res = await app.inject({
      method: "PUT",
      url: "/api/pr-inbox/handles",
      payload: { github: "a b" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST agent validates the action and maps conflicts", async () => {
    const app = await buildRouteTestApp(prInboxRoutes);
    let res = await app.inject({
      method: "POST",
      url: "/api/pr-inbox/agent",
      payload: { prUrl: "https://github.com/a/b/pull/1", action: "make_coffee" },
    });
    expect(res.statusCode).toBe(400);
    sendPrToAgent.mockResolvedValueOnce({ taskId: "t1", mode: "created" });
    res = await app.inject({
      method: "POST",
      url: "/api/pr-inbox/agent",
      payload: { prUrl: "https://github.com/a/b/pull/1", action: "fix_ci" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ taskId: "t1", mode: "created" });
    sendPrToAgent.mockRejectedValueOnce(new svc.PrInboxError("busy", 409));
    res = await app.inject({
      method: "POST",
      url: "/api/pr-inbox/agent",
      payload: { prUrl: "https://github.com/a/b/pull/1", action: "fix_ci" },
    });
    expect(res.statusCode).toBe(409);
  });
});
