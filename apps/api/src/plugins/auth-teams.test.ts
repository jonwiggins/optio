import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";

/**
 * The request's user while teams are off is upstream's shape (no team
 * fields, no work visibility), and gains the person's teams only while teams
 * are on (team-service.ts `actorTeamFields`). `/api/auth/me` returns it as is.
 */

vi.mock("../services/oauth/index.js", () => ({
  isAuthDisabled: () => false,
  getEnabledProviders: () => [],
  getOAuthProvider: () => undefined,
}));
const mockValidateSession = vi.fn();
vi.mock("../services/session-service.js", () => ({
  validateSession: (...args: unknown[]) => mockValidateSession(...args),
}));
vi.mock("../services/api-key-service.js", () => ({ validateApiKey: vi.fn() }));
vi.mock("../services/workspace-service.js", () => ({
  getUserRole: async () => "member",
  ensureUserHasWorkspace: vi.fn(),
}));
vi.mock("../services/secret-service.js", () => ({ listSecrets: vi.fn() }));
vi.mock("../services/sign-in-config-service.js", () => ({
  isBootstrapMode: vi.fn(),
  isDeploymentAdmin: vi.fn(),
  hasDeploymentAdmin: vi.fn(),
  isFoundingWorkspaceAdmin: vi.fn(),
}));
const teamFields = vi.fn();
vi.mock("../services/team-service.js", () => ({
  actorTeamFields: (...args: unknown[]) => teamFields(...args),
}));
const visibility = vi.fn();
vi.mock("../services/work-visibility.js", () => ({
  getWorkVisibility: (...args: unknown[]) => visibility(...args),
}));

import authPlugin from "./auth.js";
import { actorOf } from "../services/ownership.js";

const session = {
  id: "user-1",
  provider: "github",
  email: "test@example.com",
  displayName: "Test",
  avatarUrl: null,
  workspaceId: "ws-1",
  workspaceRole: null,
};

async function seen() {
  const app = Fastify({ logger: false });
  await app.register(authPlugin);
  app.get("/api/whoami", async (req) => ({ user: req.user, actor: actorOf(req) }));
  await app.ready();
  const res = await app.inject({
    method: "GET",
    url: "/api/whoami",
    headers: { authorization: "Bearer session-token" },
  });
  await app.close();
  return res.json();
}

describe("the request's user and actor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateSession.mockResolvedValue({ ...session });
    visibility.mockResolvedValue("teams");
  });

  it("are upstream's shape while teams are off, whatever the workspace's visibility", async () => {
    teamFields.mockResolvedValue({});
    const { user, actor } = await seen();
    expect(Object.keys(user).sort()).toEqual(Object.keys(session).sort());
    expect(actor).toEqual({ userId: "user-1", workspaceId: "ws-1", isAdmin: false });
    expect(visibility).not.toHaveBeenCalled();
  });

  it("carry the person's teams, and the teams visibility, while teams are on", async () => {
    teamFields.mockResolvedValue({ teamIds: ["t-1", "t-2"], adminTeamIds: ["t-1"] });
    const { user, actor } = await seen();
    expect(user).toMatchObject({
      teamIds: ["t-1", "t-2"],
      adminTeamIds: ["t-1"],
      workVisibility: "teams",
    });
    expect(actor).toEqual({
      userId: "user-1",
      workspaceId: "ws-1",
      isAdmin: false,
      teamIds: ["t-1", "t-2"],
      adminTeamIds: ["t-1"],
      workVisibility: "teams",
    });
  });

  it("leave the visibility off the user in the organization mode", async () => {
    teamFields.mockResolvedValue({ teamIds: [], adminTeamIds: [] });
    visibility.mockResolvedValue("organization");
    const { user } = await seen();
    expect(user).not.toHaveProperty("workVisibility");
  });
});
