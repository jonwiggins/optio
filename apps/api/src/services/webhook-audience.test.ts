import { beforeEach, describe, expect, it, vi } from "vitest";

const roles = new Map<string, string>(); // `${ws}:${user}` → role
const teamsOf = new Map<string, string[]>(); // user → team ids
const deploymentAdmins = new Set<string>();
let visibility: "organization" | "teams" = "teams";
let authDisabled = false;

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [{ id: "ops", email: "ops@example.com" }],
      }),
    }),
  },
}));
vi.mock("../db/schema.js", () => ({ users: { id: "id", email: "email" } }));
vi.mock("./workspace-service.js", () => ({
  getUserRole: async (ws: string, user: string) => roles.get(`${ws}:${user}`) ?? null,
}));
vi.mock("./team-service.js", () => ({
  teamMembershipsOf: async (user: string) =>
    (teamsOf.get(user) ?? []).map((teamId) => ({ teamId, role: "member" })),
}));
vi.mock("./sign-in-config-service.js", () => ({
  isDeploymentAdmin: async (u: { id: string }) => deploymentAdmins.has(u.id),
}));
vi.mock("./oauth/index.js", () => ({ isAuthDisabled: () => authDisabled }));
vi.mock("./work-visibility.js", async (orig) => ({
  ...(await orig<typeof import("./work-visibility.js")>()),
  getWorkVisibility: async () => visibility,
}));

const { filterWebhookAudience, webhookRefusal } = await import("./webhook-audience.js");

const hook = (id: string, workspaceId: string | null, createdBy: string | null) => ({
  id,
  workspaceId,
  createdBy,
});
const scope = (over: Partial<Record<string, string | null>> = {}) => ({
  workspaceId: "ws-a",
  ownerUserId: null,
  ownerTeamId: null,
  createdBy: "bob",
  ...over,
});

describe("filterWebhookAudience", () => {
  beforeEach(() => {
    roles.clear();
    teamsOf.clear();
    deploymentAdmins.clear();
    visibility = "teams";
    authDisabled = false;
    roles.set("ws-a:alice", "admin");
    roles.set("ws-a:carol", "member");
    roles.set("ws-a:bob", "member");
    roles.set("ws-b:bea", "admin");
    teamsOf.set("bob", ["platform"]);
  });

  const hooks = [
    hook("alice", "ws-a", "alice"),
    hook("carol", "ws-a", "carol"),
    hook("bob", "ws-a", "bob"),
    hook("bea", "ws-b", "bea"),
  ];
  const audience = async (s?: ReturnType<typeof scope>) =>
    (await filterWebhookAudience(hooks, s)).map((h) => h.id);

  it("keeps an event in its workspace", async () => {
    expect(await audience(scope())).not.toContain("bea");
    expect(await audience(scope({ workspaceId: "ws-b" }))).toEqual(["bea"]);
  });

  it("teams: a team's work reaches its members' and admins' hooks", async () => {
    expect(
      await audience(scope({ ownerUserId: "bob", ownerTeamId: "platform", createdBy: "bob" })),
    ).toEqual(["alice", "bob"]);
  });

  it("teams: organization work reaches its creator's and admins' hooks", async () => {
    expect(await audience(scope({ createdBy: "bob" }))).toEqual(["alice", "bob"]);
  });

  it("organization: organization work reaches every member's hook, private work its owner's", async () => {
    visibility = "organization";
    expect(await audience(scope())).toEqual(["alice", "carol", "bob"]);
    expect(await audience(scope({ ownerUserId: "carol", createdBy: "carol" }))).toEqual([
      "alice",
      "carol",
    ]);
  });

  it("drops a hook whose creator left, or that has no creator", async () => {
    roles.delete("ws-a:carol");
    const got = (
      await filterWebhookAudience(
        [...hooks, hook("orphan", "ws-a", null)],
        scope({ createdBy: "carol" }),
      )
    ).map((h) => h.id);
    expect(got).toEqual(["alice"]);
  });

  it("a hook with no workspace: only a deployment admin's, for any workspace", async () => {
    deploymentAdmins.add("ops");
    const legacy = [hook("ops", null, "ops"), hook("someone", null, "someone")];
    expect(
      (await filterWebhookAudience(legacy, scope({ workspaceId: "ws-b" }))).map((h) => h.id),
    ).toEqual(["ops"]);
  });

  it("an event with no scope reaches only deployment-wide hooks", async () => {
    deploymentAdmins.add("ops");
    expect(
      (await filterWebhookAudience([...hooks, hook("ops", null, "ops")], undefined)).map(
        (h) => h.id,
      ),
    ).toEqual(["ops"]);
  });

  it("auth disabled: every hook of the workspace", async () => {
    authDisabled = true;
    expect(await audience(scope({ ownerUserId: "bob", createdBy: "bob" }))).toEqual([
      "alice",
      "carol",
      "bob",
    ]);
  });
});

describe("webhookRefusal", () => {
  beforeEach(() => {
    deploymentAdmins.clear();
    authDisabled = false;
  });

  it("lets the creator and a workspace admin through", async () => {
    const h = hook("h", "ws-a", "carol");
    expect(await webhookRefusal(h, { id: "carol", workspaceRole: "member" })).toBeNull();
    expect(await webhookRefusal(h, { id: "alice", workspaceRole: "admin" })).toBeNull();
    expect(await webhookRefusal(h, { id: "bob", workspaceRole: "member" })).toEqual({
      status: 403,
      error: "Only the webhook's creator or a workspace admin can change it or see its deliveries",
    });
    expect(await webhookRefusal(h, null)).not.toBeNull();
  });

  it("leaves a hook with no workspace to deployment admins", async () => {
    deploymentAdmins.add("ops");
    const h = hook("h", null, "ops");
    expect(await webhookRefusal(h, { id: "ops", workspaceRole: "member" })).toBeNull();
    expect((await webhookRefusal(h, { id: "alice", workspaceRole: "admin" }))?.error).toMatch(
      /deployment admin/,
    );
  });
});
