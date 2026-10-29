import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const mockGetWorkLinkStatuses = vi.fn();
vi.mock("../services/work-link-status-service.js", () => ({
  getWorkLinkStatuses: (...args: unknown[]) => mockGetWorkLinkStatuses(...args),
}));

import { workLinkRoutes } from "./work-links.js";

describe("GET /api/work-links/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("looks up each url as the caller", async () => {
    mockGetWorkLinkStatuses.mockResolvedValue([
      { url: "https://github.com/a/b/pull/1", state: "open", checks: "passing", review: "none" },
    ]);
    const app = await buildRouteTestApp(workLinkRoutes);
    const res = await app.inject({
      method: "GET",
      url: "/api/work-links/status?url=https://github.com/a/b/pull/1&url=https://github.com/a/b/pull/2",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().statuses).toHaveLength(1);
    expect(mockGetWorkLinkStatuses).toHaveBeenCalledWith(
      ["https://github.com/a/b/pull/1", "https://github.com/a/b/pull/2"],
      { userId: "user-1", workspaceId: "ws-1" },
    );
  });

  it("rejects a url that is not one", async () => {
    const app = await buildRouteTestApp(workLinkRoutes);
    const res = await app.inject({ method: "GET", url: "/api/work-links/status?url=nope" });
    expect(res.statusCode).toBe(400);
    expect(mockGetWorkLinkStatuses).not.toHaveBeenCalled();
  });
});
