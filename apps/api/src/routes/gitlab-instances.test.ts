import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
const calls = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  admin: vi.fn(),
}));
vi.mock("../services/gitlab-instance-service.js", () => ({
  listGitLabInstances: calls.list,
  saveGitLabInstance: calls.save,
  deleteGitLabInstance: calls.remove,
  testGitLabInstance: calls.test,
}));
vi.mock("../services/oauth/index.js", () => ({ isAuthDisabled: () => false }));
vi.mock("../services/sign-in-config-service.js", () => ({ isDeploymentAdmin: calls.admin }));
import { gitlabInstanceRoutes } from "./gitlab-instances.js";
const id = randomUUID();
const row = {
  id,
  baseUrl: "https://git.example.test/gitlab",
  displayName: "GitLab",
  caPem: null,
  hasToken: true,
  source: "app",
};
const input = { baseUrl: row.baseUrl, displayName: row.displayName, token: "test-only-token" };
beforeEach(() => {
  vi.clearAllMocks();
  calls.admin.mockResolvedValue(false);
  calls.list.mockResolvedValue([row]);
  calls.save.mockResolvedValue(row);
  calls.remove.mockResolvedValue(true);
  calls.test.mockResolvedValue({ ok: true });
});
describe("GitLab instance deployment ownership", () => {
  it("requires authentication to read instance locations", async () => {
    const app = await buildRouteTestApp(gitlabInstanceRoutes, { user: null });
    expect((await app.inject("/api/gitlab-instances")).statusCode).toBe(401);
    expect(calls.list).not.toHaveBeenCalled();
    await app.close();
  });
  it("lists public metadata as read only for a workspace admin", async () => {
    const app = await buildRouteTestApp(gitlabInstanceRoutes);
    const res = await app.inject("/api/gitlab-instances");
    expect(res.json()).toEqual({ instances: [row], canEdit: false });
    expect(res.body).not.toContain(input.token);
    await app.close();
  });
  it("refuses every configuration mutation by a workspace admin", async () => {
    const app = await buildRouteTestApp(gitlabInstanceRoutes);
    for (const [method, url] of [
      ["POST", "/api/gitlab-instances"],
      ["PUT", `/api/gitlab-instances/${id}`],
      ["DELETE", `/api/gitlab-instances/${id}`],
      ["POST", "/api/gitlab-instances/test"],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        ...(method === "DELETE" ? {} : { payload: input }),
      });
      expect(res.statusCode).toBe(403);
    }
    expect(calls.save).not.toHaveBeenCalled();
    expect(calls.remove).not.toHaveBeenCalled();
    expect(calls.test).not.toHaveBeenCalled();
    await app.close();
  });
  it("lets a deployment admin save without returning a plaintext token", async () => {
    calls.admin.mockResolvedValue(true);
    const app = await buildRouteTestApp(gitlabInstanceRoutes);
    const res = await app.inject({ method: "POST", url: "/api/gitlab-instances", payload: input });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(row);
    expect(calls.save).toHaveBeenCalledWith(input);
    expect(res.body).not.toContain(input.token);
    await app.close();
  });
  it("retains the workspace admin gate for a deployment admin", async () => {
    calls.admin.mockResolvedValue(true);
    const app = await buildRouteTestApp(gitlabInstanceRoutes, {
      user: { id: "member", workspaceId: "ws", workspaceRole: "member" },
    });
    expect(
      (await app.inject({ method: "POST", url: "/api/gitlab-instances", payload: input }))
        .statusCode,
    ).toBe(403);
    expect(calls.save).not.toHaveBeenCalled();
    await app.close();
  });
});
