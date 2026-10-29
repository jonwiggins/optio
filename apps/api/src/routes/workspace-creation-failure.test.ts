import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
const createWorkspace = vi.hoisted(() => vi.fn());
vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.reject(new Error("policy database unavailable")),
      }),
    }),
  },
}));
vi.mock("../services/workspace-service.js", () => ({ createWorkspace }));
import { workspaceRoutes } from "./workspaces.js";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("workspace creation when policy storage fails", () => {
  it("refuses to create instead of falling back to the permissive environment default", async () => {
    vi.stubEnv("OPTIO_WORKSPACE_CREATION", "everyone");
    const app = await buildRouteTestApp(workspaceRoutes);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "Forbidden", slug: "forbidden" },
      });
      expect(response.statusCode).toBe(500);
      expect(createWorkspace).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
