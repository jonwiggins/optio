import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, FastifyReply } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const mocks = vi.hoisted(() => ({
  admin: true,
  list: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
}));
vi.mock("../services/deployment-admin-gates.js", () => ({
  requesterIsDeploymentAdmin: async () => mocks.admin,
  refuseUnlessDeploymentAdmin: async (_req: unknown, reply: FastifyReply, message: string) => {
    if (mocks.admin) return false;
    void reply.code(403).send({ error: message });
    return true;
  },
}));
vi.mock("../services/gitlab-instance-service.js", () => ({
  listGitLabInstances: mocks.list,
  saveGitLabInstance: mocks.save,
  deleteGitLabInstance: mocks.remove,
  testGitLabInstance: mocks.test,
}));
import { gitlabInstanceRoutes } from "./gitlab-instances.js";

let app: FastifyInstance;
const id = "00000000-0000-4000-8000-000000000001";
const input = {
  baseUrl: "https://git.example.com/gitlab",
  displayName: "Test GitLab",
  token: "private-token",
};
const row = {
  id,
  baseUrl: input.baseUrl,
  displayName: input.displayName,
  caPem: null,
  hasToken: true,
  source: "app",
};
beforeEach(async () => {
  vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
  mocks.admin = true;
  mocks.list.mockReset().mockResolvedValue([row]);
  mocks.save.mockReset().mockResolvedValue(row);
  mocks.remove.mockReset().mockResolvedValue(true);
  mocks.test.mockReset().mockResolvedValue({ ok: true, version: "18.0", username: "test-bot" });
  app = await buildRouteTestApp(gitlabInstanceRoutes);
});
afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
});

describe("GitLab instance API", () => {
  it("lists public connection metadata without returning a token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/gitlab-instances" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ instances: [row], canEdit: true });
    expect(res.body).not.toContain("private-token");
  });
  it("rejects unauthenticated listing", async () => {
    const anonymous = await buildRouteTestApp(gitlabInstanceRoutes, { user: null });
    try {
      expect((await anonymous.inject("/api/gitlab-instances")).statusCode).toBe(401);
    } finally {
      await anonymous.close();
    }
  });
  it("creates, updates, tests and removes an instance", async () => {
    for (const [method, url, payload] of [
      ["POST", "/api/gitlab-instances", input],
      ["PUT", `/api/gitlab-instances/${id}`, { ...input, token: null }],
      ["POST", "/api/gitlab-instances/test", { ...input, id }],
      ["DELETE", `/api/gitlab-instances/${id}`, undefined],
    ] as const)
      expect((await app.inject({ method, url, payload })).statusCode).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(input);
    expect(mocks.save).toHaveBeenCalledWith({ ...input, token: null }, id);
    expect(mocks.test).toHaveBeenCalledWith({ ...input, id }, id);
    expect(mocks.remove).toHaveBeenCalledWith(id);
  });
  it("refuses every mutation by a workspace admin who is not a deployment admin", async () => {
    mocks.admin = false;
    for (const [method, url, payload] of [
      ["POST", "/api/gitlab-instances", input],
      ["PUT", `/api/gitlab-instances/${id}`, input],
      ["POST", "/api/gitlab-instances/test", input],
      ["DELETE", `/api/gitlab-instances/${id}`, undefined],
    ] as const)
      expect((await app.inject({ method, url, payload })).statusCode).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.test).not.toHaveBeenCalled();
  });
  it("validates required names, URLs, ids and PEM size", async () => {
    for (const bad of [
      { ...input, displayName: "" },
      { ...input, baseUrl: "" },
      { ...input, caPem: "x".repeat(100001) },
    ]) {
      expect(
        (await app.inject({ method: "POST", url: "/api/gitlab-instances", payload: bad }))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/gitlab-instances/environment:git.example.com",
          payload: input,
        })
      ).statusCode,
    ).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("returns safe errors without including tokens or response bodies", async () => {
    mocks.test.mockRejectedValue(new Error("private-token from remote body"));
    const test = await app.inject({
      method: "POST",
      url: "/api/gitlab-instances/test",
      payload: input,
    });
    expect(test.json()).toMatchObject({ ok: false });
    expect(test.body).not.toContain("private-token");
    mocks.save.mockRejectedValue(new Error("private-token DB error"));
    const save = await app.inject({ method: "POST", url: "/api/gitlab-instances", payload: input });
    expect(save.statusCode).toBe(400);
    expect(save.body).not.toContain("private-token");
  });
});
