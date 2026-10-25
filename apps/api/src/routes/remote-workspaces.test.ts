import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const svc = vi.hoisted(() => ({
  listConnections: vi.fn(),
  createConnection: vi.fn(),
  updateConnection: vi.fn(),
  deleteConnection: vi.fn(),
  testConnection: vi.fn(),
  getVisibleConnection: vi.fn(),
  mayChangeConnection: vi.fn(),
  clientFor: vi.fn(),
  releaseWorkspacePairings: vi.fn(),
  hostRows: [] as unknown[],
}));

vi.mock("../services/remote-workspace-service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/remote-workspace-service.js")>();
  return {
    RemoteWorkspaceError: actual.RemoteWorkspaceError,
    listConnections: (...a: unknown[]) => svc.listConnections(...a),
    createConnection: (...a: unknown[]) => svc.createConnection(...a),
    updateConnection: (...a: unknown[]) => svc.updateConnection(...a),
    deleteConnection: (...a: unknown[]) => svc.deleteConnection(...a),
    testConnection: (...a: unknown[]) => svc.testConnection(...a),
    getVisibleConnection: (...a: unknown[]) => svc.getVisibleConnection(...a),
    mayChangeConnection: (...a: unknown[]) => svc.mayChangeConnection(...a),
    clientFor: (...a: unknown[]) => svc.clientFor(...a),
    releaseWorkspacePairings: (...a: unknown[]) => svc.releaseWorkspacePairings(...a),
  };
});

vi.mock("../db/client.js", () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => Promise.resolve(svc.hostRows);
  return { db: { select: () => chain } };
});

import { RemoteWorkspaceError } from "../services/remote-workspace-service.js";
import { CoderProviderClient } from "../services/remote-workspaces/coder.js";
import { remoteWorkspaceRoutes } from "./remote-workspaces.js";

const CONN_ID = "00000000-0000-0000-0000-0000000000c1";
const view = {
  id: CONN_ID,
  provider: "coder",
  workspaceId: "ws-1",
  ownerUserId: null,
  ownerTeamId: null,
  ownerName: null,
  ownerTeamName: null,
  name: "Corp Coder",
  url: "https://coder.example.com",
  hasToken: true,
  tokenHint: "1234",
  caPem: null,
  insecureSkipVerify: false,
  organizationId: null,
  templateId: "tpl-1",
  templateVersionId: "tv-1",
  templateName: "Kubernetes",
  defaultParameters: {},
  ttlMs: null,
  deleteWhenDone: false,
  lastTestedAt: null,
  lastError: null,
  enabled: true,
  canEdit: true,
  createdAt: "2026-10-23T10:00:00.000Z",
  updatedAt: "2026-10-23T10:00:00.000Z",
};

const client = {
  organizations: vi.fn(),
  templates: vi.fn(),
  richParameters: vi.fn(),
  workspaces: vi.fn(),
  build: vi.fn(),
};

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  svc.hostRows = [];
  svc.getVisibleConnection.mockResolvedValue({ id: CONN_ID, organizationId: null });
  // The Coder provider's client over a stand-in for its REST calls.
  svc.clientFor.mockImplementation(() => {
    const c = new CoderProviderClient({ url: "https://coder.example.com", token: "t" });
    Object.assign(c.api, client);
    return c;
  });
  svc.mayChangeConnection.mockReturnValue(true);
  app = await buildRouteTestApp(remoteWorkspaceRoutes, {
    user: { id: "u-1", workspaceId: "ws-1", workspaceRole: "member" },
  });
});

describe("Coder connections", () => {
  it("lists what the caller sees, without tokens", async () => {
    svc.listConnections.mockResolvedValue([{ ...view, encryptedToken: "x", token: "secret" }]);
    const res = await app.inject({ method: "GET", url: "/api/coder/connections" });
    expect(res.statusCode).toBe(200);
    expect(res.json().connections).toHaveLength(1);
    expect(res.body).not.toContain("secret");
    expect(res.json().connections[0]).not.toHaveProperty("encryptedToken");
  });

  it("adds one for its owner", async () => {
    svc.createConnection.mockResolvedValue(view);
    const res = await app.inject({
      method: "POST",
      url: "/api/coder/connections",
      payload: { name: "Mine", url: "https://coder.example.com", token: "t0ken", owner: "me" },
    });
    expect(res.statusCode).toBe(201);
    expect(svc.createConnection.mock.calls[0][0]).toMatchObject({ owner: "me", token: "t0ken" });
    expect(svc.createConnection.mock.calls[0][1]).toMatchObject({ userId: "u-1", isAdmin: false });
  });

  it("refuses a URL that isn't one", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/coder/connections",
      payload: { name: "Bad", url: "not a url", token: "t" },
    });
    expect(res.statusCode).toBe(400);
    expect(svc.createConnection).not.toHaveBeenCalled();
  });

  it("answers the service's refusals with their status", async () => {
    svc.createConnection.mockRejectedValue(
      new RemoteWorkspaceError("Only an admin can change the organization's Coder connection", 403),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/coder/connections",
      payload: { name: "Org", url: "https://coder.example.com", token: "t" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/Only an admin/);
  });

  it("changes, tests and removes one", async () => {
    svc.updateConnection.mockResolvedValue({ ...view, name: "Renamed" });
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/coder/connections/${CONN_ID}`,
      payload: { name: "Renamed", deleteWhenDone: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().connection.name).toBe("Renamed");

    svc.testConnection.mockResolvedValue({ ok: false, error: "Coder answered 401" });
    const test = await app.inject({
      method: "POST",
      url: `/api/coder/connections/${CONN_ID}/test`,
    });
    expect(test.statusCode).toBe(200);
    expect(test.json()).toEqual({ ok: false, error: "Coder answered 401" });

    svc.deleteConnection.mockResolvedValue(undefined);
    const del = await app.inject({ method: "DELETE", url: `/api/coder/connections/${CONN_ID}` });
    expect(del.statusCode).toBe(204);
  });
});

describe("the pickers", () => {
  it("lists the default organization's templates", async () => {
    client.organizations.mockResolvedValue([
      { id: "org-2", name: "other" },
      { id: "org-1", name: "corp", is_default: true },
    ]);
    client.templates.mockResolvedValue([
      { id: "tpl-1", name: "k8s", display_name: "Kubernetes", active_version_id: "tv-1" },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/api/coder/connections/${CONN_ID}/templates`,
    });
    expect(res.statusCode).toBe(200);
    expect(client.templates).toHaveBeenCalledWith("org-1");
    expect(res.json()).toEqual({
      organizationId: "org-1",
      templates: [
        {
          id: "tpl-1",
          name: "k8s",
          displayName: "Kubernetes",
          description: null,
          organizationId: "org-1",
          activeVersionId: "tv-1",
        },
      ],
    });
  });

  it("marks the parameters Optio fills", async () => {
    client.richParameters.mockResolvedValue([
      { name: "optio_token", type: "string", mutable: true },
      { name: "cpu", type: "number", mutable: false, default_value: "2", required: true },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/api/coder/connections/${CONN_ID}/templates/tv-1/parameters`,
    });
    expect(res.statusCode).toBe(200);
    const [token, cpu] = res.json().parameters;
    expect(token).toMatchObject({ name: "optio_token", setByOptio: true });
    expect(cpu).toMatchObject({
      name: "cpu",
      setByOptio: false,
      defaultValue: "2",
      required: true,
    });
  });

  it("lists the token user's workspaces", async () => {
    client.workspaces.mockResolvedValue([
      {
        id: "w-1",
        name: "dev",
        owner_name: "svc",
        template_name: "k8s",
        latest_build: { status: "stopped", transition: "stop", template_version_id: "tv-1" },
      },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/api/coder/connections/${CONN_ID}/workspaces`,
    });
    expect(res.json().workspaces).toEqual([
      {
        id: "w-1",
        name: "dev",
        ownerName: "svc",
        templateId: null,
        templateName: "k8s",
        status: "stopped",
        transition: "stop",
      },
    ]);
  });

  it("is a 404 for a connection the caller doesn't see, and a 502 when Coder fails", async () => {
    svc.getVisibleConnection.mockResolvedValueOnce(null);
    const hidden = await app.inject({
      method: "GET",
      url: `/api/coder/connections/${CONN_ID}/workspaces`,
    });
    expect(hidden.statusCode).toBe(404);

    client.workspaces.mockRejectedValue(new RemoteWorkspaceError("Couldn't reach Coder", 502));
    const down = await app.inject({
      method: "GET",
      url: `/api/coder/connections/${CONN_ID}/workspaces`,
    });
    expect(down.statusCode).toBe(502);
  });
});

describe("stopping a workspace", () => {
  it("lets the connection's editors stop any of its workspaces", async () => {
    client.build.mockResolvedValue({ status: "pending" });
    const res = await app.inject({
      method: "POST",
      url: `/api/coder/connections/${CONN_ID}/workspaces/w-1/stop`,
    });
    expect(res.statusCode).toBe(200);
    expect(client.build).toHaveBeenCalledWith("w-1", "stop");
    // Its pairing tokens are revoked with it.
    expect(svc.releaseWorkspacePairings).toHaveBeenCalledWith(CONN_ID, "w-1");
  });

  it("lets anyone else stop only one Optio started for them", async () => {
    svc.mayChangeConnection.mockReturnValue(false);
    const refused = await app.inject({
      method: "POST",
      url: `/api/coder/connections/${CONN_ID}/workspaces/w-1/stop`,
    });
    expect(refused.statusCode).toBe(403);
    expect(client.build).not.toHaveBeenCalled();
    expect(svc.releaseWorkspacePairings).not.toHaveBeenCalled();

    svc.hostRows = [{ id: "host-1" }];
    client.build.mockResolvedValue({ status: "pending" });
    const mine = await app.inject({
      method: "POST",
      url: `/api/coder/connections/${CONN_ID}/workspaces/w-1/stop`,
    });
    expect(mine.statusCode).toBe(200);
  });
});

describe("the generic routes", () => {
  it("list the providers", async () => {
    const res = await app.inject({ method: "GET", url: "/api/remote-workspaces/providers" });
    expect(res.statusCode).toBe(200);
    expect(res.json().providers.map((p: { id: string }) => p.id)).toEqual([
      "coder",
      "codespaces",
      "daytona",
      "e2b",
    ]);
  });

  it("list one provider's connections; the older Coder route lists Coder's", async () => {
    svc.listConnections.mockResolvedValue([]);
    await app.inject({ method: "GET", url: "/api/remote-workspaces/connections?provider=e2b" });
    expect(svc.listConnections.mock.calls[0][1]).toEqual({ provider: "e2b" });
    await app.inject({ method: "GET", url: "/api/remote-workspaces/connections" });
    expect(svc.listConnections.mock.calls[1][1]).toEqual({ provider: undefined });
    await app.inject({ method: "GET", url: "/api/coder/connections" });
    expect(svc.listConnections.mock.calls[2][1]).toEqual({ provider: "coder" });
  });

  it("add a connection of the provider named; a blank URL is the provider's own API", async () => {
    svc.createConnection.mockResolvedValue({ ...view, provider: "daytona", url: "" });
    const res = await app.inject({
      method: "POST",
      url: "/api/remote-workspaces/connections",
      payload: { provider: "daytona", name: "Sandboxes", url: "", token: "dtn_1", owner: "me" },
    });
    expect(res.statusCode).toBe(201);
    expect(svc.createConnection.mock.calls[0][0]).toMatchObject({
      provider: "daytona",
      url: "",
      token: "dtn_1",
    });
  });

  it("refuse a provider that has no API of its own without a URL, and one they don't know", async () => {
    const blank = await app.inject({
      method: "POST",
      url: "/api/remote-workspaces/connections",
      payload: { provider: "coder", name: "Coder", token: "t" },
    });
    expect(blank.statusCode).toBe(400);
    expect(blank.json().error).toMatch(/needs its URL/);
    const unknown = await app.inject({
      method: "POST",
      url: "/api/remote-workspaces/connections",
      payload: { provider: "other", name: "X", url: "https://x.example.com", token: "t" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(svc.createConnection).not.toHaveBeenCalled();
  });

  it("make a connection added through the older Coder route a Coder one", async () => {
    svc.createConnection.mockResolvedValue(view);
    await app.inject({
      method: "POST",
      url: "/api/coder/connections",
      payload: { name: "Coder", url: "https://coder.example.com", token: "t" },
    });
    expect(svc.createConnection.mock.calls[0][0]).toMatchObject({ provider: "coder" });
  });
});
