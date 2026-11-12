import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

const svc = vi.hoisted(() => ({
  list: vi.fn(),
  save: vi.fn(),
  setDefault: vi.fn(),
  remove: vi.fn(),
  shared: vi.fn(),
}));
vi.mock("../services/workspace-gitlab-service.js", async (importActual) => ({
  ...(await importActual<typeof import("../services/workspace-gitlab-service.js")>()),
  listWorkspaceGitLabServers: svc.list,
  saveWorkspaceGitLabServer: svc.save,
  setDefaultWorkspaceGitLabServer: svc.setDefault,
  removeWorkspaceGitLabServer: svc.remove,
  mayUseDeploymentGitLab: svc.shared,
}));
vi.mock("../services/optio-action-service.js", () => ({
  logAction: vi.fn().mockResolvedValue(undefined),
}));

import { workspaceGitLabRoutes } from "./workspace-gitlab.js";
import { WorkspaceGitLabError } from "../services/workspace-gitlab-service.js";

const ID = "6b1f6a4e-3f0a-4a8e-9a43-0d6c7a0d9e11";
const SERVER = {
  id: ID,
  host: "git.corp.test",
  accountUsername: "team-bot",
  accountName: "Team Bot",
  isDefault: true,
  hasToken: true,
  createdAt: new Date("2026-11-01T00:00:00Z"),
  updatedAt: new Date("2026-11-01T00:00:00Z"),
};

let app: FastifyInstance;
async function as(role: "admin" | "member" | "viewer", workspaceId: string | null = "ws-1") {
  app = await buildRouteTestApp(workspaceGitLabRoutes, {
    user: { id: "user-1", workspaceId, workspaceRole: role },
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GITLAB_HOSTS", "git.corp.test");
  svc.list.mockResolvedValue([SERVER]);
  svc.save.mockResolvedValue(SERVER);
  svc.shared.mockResolvedValue(false);
});

describe("GET /api/workspace/gitlab", () => {
  it("lists the caller's workspace's servers, never a token, to any member", async () => {
    const res = await (await as("viewer")).inject({ method: "GET", url: "/api/workspace/gitlab" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(svc.list).toHaveBeenCalledWith("ws-1");
    expect(body.servers).toHaveLength(1);
    expect(body.servers[0]).not.toHaveProperty("token");
    expect(JSON.stringify(body)).not.toMatch(/glpat/);
    expect(body.allowedHosts).toEqual(["gitlab.com", "git.corp.test"]);
    expect(body.deploymentFallback).toBe(false);
  });

  it("needs a workspace", async () => {
    const res = await (
      await as("admin", null)
    ).inject({
      method: "GET",
      url: "/api/workspace/gitlab",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/workspace/gitlab/servers", () => {
  it("stores a server for the caller's workspace (admin)", async () => {
    const res = await (
      await as("admin")
    ).inject({
      method: "POST",
      url: "/api/workspace/gitlab/servers",
      payload: { host: "git.corp.test", token: "glpat-team" },
    });
    expect(res.statusCode).toBe(201);
    expect(svc.save).toHaveBeenCalledWith(
      "ws-1",
      { host: "git.corp.test", token: "glpat-team" },
      { userId: "user-1" },
    );
    expect(res.body).not.toMatch(/glpat-team/);
  });

  it("is refused to members and viewers", async () => {
    for (const role of ["member", "viewer"] as const) {
      const res = await (
        await as(role)
      ).inject({
        method: "POST",
        url: "/api/workspace/gitlab/servers",
        payload: { host: "git.corp.test", token: "glpat-team" },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(svc.save).not.toHaveBeenCalled();
  });

  it("returns the service's refusal (an unlisted host, a token that doesn't sign in)", async () => {
    svc.save.mockRejectedValue(new WorkspaceGitLabError("evil.test isn't a GitLab server"));
    const res = await (
      await as("admin")
    ).inject({
      method: "POST",
      url: "/api/workspace/gitlab/servers",
      payload: { host: "evil.test", token: "glpat-team" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/isn't a GitLab server/);
  });
});

describe("PATCH /api/workspace/gitlab/servers/:id", () => {
  it("replaces a token on the server's own host", async () => {
    const res = await (
      await as("admin")
    ).inject({
      method: "PATCH",
      url: `/api/workspace/gitlab/servers/${ID}`,
      payload: { token: "glpat-new" },
    });
    expect(res.statusCode).toBe(200);
    expect(svc.save).toHaveBeenCalledWith(
      "ws-1",
      { host: "git.corp.test", token: "glpat-new", isDefault: undefined },
      { userId: "user-1" },
    );
  });

  it("makes a server the default", async () => {
    const res = await (
      await as("admin")
    ).inject({
      method: "PATCH",
      url: `/api/workspace/gitlab/servers/${ID}`,
      payload: { isDefault: true },
    });
    expect(res.statusCode).toBe(200);
    expect(svc.setDefault).toHaveBeenCalledWith("ws-1", ID);
    expect(svc.save).not.toHaveBeenCalled();
  });

  it("404s for a server outside the caller's workspace", async () => {
    svc.list.mockResolvedValue([]);
    const res = await (
      await as("admin")
    ).inject({
      method: "PATCH",
      url: `/api/workspace/gitlab/servers/${ID}`,
      payload: { isDefault: true },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/workspace/gitlab/servers/:id", () => {
  it("removes a server of the caller's workspace (admin only)", async () => {
    expect(
      (
        await (
          await as("member")
        ).inject({
          method: "DELETE",
          url: `/api/workspace/gitlab/servers/${ID}`,
        })
      ).statusCode,
    ).toBe(403);
    const res = await (
      await as("admin")
    ).inject({
      method: "DELETE",
      url: `/api/workspace/gitlab/servers/${ID}`,
    });
    expect(res.statusCode).toBe(204);
    expect(svc.remove).toHaveBeenCalledWith("ws-1", ID);
  });

  it("passes the service's 404 through", async () => {
    svc.remove.mockRejectedValue(new WorkspaceGitLabError("GitLab server not found", 404));
    const res = await (
      await as("admin")
    ).inject({
      method: "DELETE",
      url: `/api/workspace/gitlab/servers/${ID}`,
    });
    expect(res.statusCode).toBe(404);
  });
});
