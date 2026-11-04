import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { signInRoutes } from "./sign-in.js";

const mocks = vi.hoisted(() => ({
  authDisabled: false,
  admin: false,
  bootstrap: false,
  hasAdmin: true,
  usable: false,
  verifyToken: vi.fn(),
  save: vi.fn(),
  removeProvider: vi.fn(),
  providers: vi.fn(),
  admins: vi.fn(),
  addAdmin: vi.fn(),
  removeAdmin: vi.fn(),
  recordClaim: vi.fn(),
  normalize: vi.fn(),
  action: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
}));
vi.mock("../services/oauth/index.js", () => ({ isAuthDisabled: () => mocks.authDisabled }));
vi.mock("../services/sign-in-config-service.js", () => ({
  SignInConfigError: class extends Error {
    constructor(
      message: string,
      readonly status = 400,
      readonly candidates?: unknown[],
    ) {
      super(message);
    }
  },
  isDeploymentAdmin: async () => mocks.admin,
  isBootstrapMode: async () => mocks.bootstrap,
  hasDeploymentAdmin: async () => mocks.hasAdmin,
  setupTokenUsable: async () => mocks.usable,
  verifySetupToken: mocks.verifyToken,
  listSignInProviders: mocks.providers,
  listDeploymentAdmins: mocks.admins,
  saveSignInConfig: mocks.save,
  deleteSignInConfig: mocks.removeProvider,
  addDeploymentAdmin: mocks.addAdmin,
  removeDeploymentAdmin: mocks.removeAdmin,
  recordBootstrapClaim: mocks.recordClaim,
}));
vi.mock("../services/workspace-service.js", () => ({ normalizeAutoJoinDomains: mocks.normalize }));
vi.mock("../services/optio-action-service.js", () => ({ logAction: mocks.action }));
vi.mock("../db/client.js", () => ({ db: { update: mocks.update } }));
import { SignInConfigError } from "../services/sign-in-config-service.js";

const apps: Awaited<ReturnType<typeof buildRouteTestApp>>[] = [];
async function app(signedIn = true) {
  const instance = await buildRouteTestApp(signInRoutes, signedIn ? {} : { user: null });
  apps.push(instance);
  return instance;
}
const adminId = "11111111-1111-4111-8111-111111111111";
const tokenHeader = { "x-optio-setup-token": "setup-token" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authDisabled = false;
  mocks.admin = false;
  mocks.bootstrap = false;
  mocks.hasAdmin = true;
  mocks.usable = false;
  mocks.verifyToken.mockResolvedValue(false);
  mocks.providers.mockResolvedValue([{ provider: "google", configured: true }]);
  mocks.admins.mockResolvedValue([{ id: adminId, email: "admin@acme.test" }]);
  mocks.save.mockResolvedValue({ provider: "google", configured: true });
  mocks.addAdmin.mockResolvedValue({ id: adminId });
  mocks.normalize.mockReturnValue({ domains: ["acme.test"] });
  mocks.action.mockResolvedValue(undefined);
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: mocks.where });
  mocks.where.mockResolvedValue(undefined);
  vi.stubEnv("PUBLIC_URL", undefined);
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  vi.unstubAllEnvs();
});

describe("sign-in configuration visibility", () => {
  it("lets a signed-in workspace admin see provider status without listing deployment admins", async () => {
    const res = await (await app()).inject({ url: "/api/auth/sign-in" });
    expect(res.json()).toMatchObject({
      canEdit: false,
      canClaim: false,
      publicUrl: null,
      providers: [{ provider: "google" }],
    });
    expect(res.json()).not.toHaveProperty("deploymentAdmins");
    expect(mocks.admins).not.toHaveBeenCalled();
  });
  it("shows a claim option only to an authenticated person when no deployment admin exists", async () => {
    mocks.hasAdmin = false;
    mocks.bootstrap = true;
    expect((await (await app()).inject({ url: "/api/auth/sign-in" })).json()).toMatchObject({
      canClaim: true,
      canEdit: false,
    });
    expect((await (await app(false)).inject({ url: "/api/auth/sign-in" })).json()).toMatchObject({
      canClaim: false,
      canEdit: false,
    });
  });
  it("returns deployment administration details to an actual deployment admin", async () => {
    mocks.admin = true;
    vi.stubEnv("PUBLIC_URL", "https://optio.acme.test");
    const res = await (await app()).inject({ url: "/api/auth/sign-in" });
    expect(res.json()).toMatchObject({
      canEdit: true,
      canClaim: false,
      publicUrl: "https://optio.acme.test",
      deploymentAdmins: [{ id: adminId }],
    });
  });
  it("allows a usable setup token to edit without exposing the admin directory", async () => {
    mocks.usable = true;
    mocks.verifyToken.mockResolvedValue(true);
    const res = await (await app(false)).inject({ url: "/api/auth/sign-in", headers: tokenHeader });
    expect(res.json().canEdit).toBe(true);
    expect(res.json()).not.toHaveProperty("deploymentAdmins");
  });
});

describe("sign-in mutation authorization", () => {
  const operations = [
    { method: "PUT" as const, url: "/api/auth/sign-in/google", payload: { clientId: "id" } },
    { method: "DELETE" as const, url: "/api/auth/sign-in/google" },
    { method: "GET" as const, url: "/api/auth/deployment-admins" },
    {
      method: "POST" as const,
      url: "/api/auth/deployment-admins",
      payload: { email: "person@acme.test" },
    },
    { method: "DELETE" as const, url: `/api/auth/deployment-admins/${adminId}` },
  ];
  it.each(operations)("rejects workspace-admin access to $method $url", async (operation) => {
    expect((await (await app()).inject(operation)).statusCode).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.addAdmin).not.toHaveBeenCalled();
    expect(mocks.removeAdmin).not.toHaveBeenCalled();
    expect(mocks.removeProvider).not.toHaveBeenCalled();
  });
  it("requires the token during bootstrap and rejects an unusable or incorrect one", async () => {
    mocks.bootstrap = true;
    const server = await app(false);
    const operation = operations[0];
    const absent = await server.inject(operation);
    expect(absent.statusCode).toBe(403);
    expect(absent.json().error).toMatch(/setup token/);
    expect((await server.inject({ ...operation, headers: tokenHeader })).statusCode).toBe(403);
    expect(mocks.verifyToken).not.toHaveBeenCalled();
    mocks.usable = true;
    expect((await server.inject({ ...operation, headers: tokenHeader })).statusCode).toBe(403);
    expect(mocks.verifyToken).toHaveBeenCalledWith("setup-token");
  });
  it("records normalized bootstrap ownership after the token-authorized provider save succeeds", async () => {
    mocks.bootstrap = true;
    mocks.hasAdmin = false;
    mocks.usable = true;
    mocks.verifyToken.mockResolvedValue(true);
    const res = await (
      await app(false)
    ).inject({
      ...operations[0],
      headers: tokenHeader,
      payload: {
        clientId: "id",
        clientSecret: "secret",
        allowedDomains: ["ACME.test"],
        organizationName: "  Acme  ",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(
      "google",
      { clientId: "id", clientSecret: "secret", allowedDomains: ["ACME.test"] },
      null,
    );
    expect(mocks.recordClaim).toHaveBeenCalledWith({
      provider: "google",
      organizationName: "Acme",
      domains: ["acme.test"],
    });
  });
  it("records an unrestricted bootstrap when optional organization/domain input is absent", async () => {
    mocks.authDisabled = true;
    mocks.hasAdmin = false;
    expect((await (await app(false)).inject(operations[0])).statusCode).toBe(200);
    expect(mocks.recordClaim).toHaveBeenCalledWith({
      provider: "google",
      organizationName: null,
      domains: [],
    });
  });
  it("does not create a bootstrap claim for an established deployment", async () => {
    mocks.admin = true;
    expect((await (await app()).inject(operations[0])).statusCode).toBe(200);
    expect(mocks.recordClaim).not.toHaveBeenCalled();
  });
  it("propagates rejected provider configuration without claiming bootstrap ownership", async () => {
    mocks.admin = true;
    mocks.hasAdmin = false;
    mocks.save.mockRejectedValue(new SignInConfigError("Invalid domain", 400));
    const res = await (await app()).inject(operations[0]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid domain");
    expect(mocks.recordClaim).not.toHaveBeenCalled();
    expect(mocks.action).not.toHaveBeenCalled();
  });
  it("deletes a stored provider while retaining authenticated audit attribution", async () => {
    mocks.admin = true;
    mocks.action.mockRejectedValue(new Error("audit unavailable"));
    const res = await (await app()).inject(operations[1]);
    expect(res.statusCode).toBe(204);
    expect(mocks.removeProvider).toHaveBeenCalledWith("google");
    expect(mocks.action).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", action: "sign_in.provider_deleted" }),
    );
  });
  it("lists and adds deployment admins by verified identity through the service", async () => {
    mocks.admin = true;
    const server = await app();
    expect((await server.inject(operations[2])).json()).toEqual({
      admins: [{ id: adminId, email: "admin@acme.test" }],
    });
    expect((await server.inject(operations[3])).statusCode).toBe(201);
    expect(mocks.addAdmin).toHaveBeenCalledWith({ email: "person@acme.test" });
    mocks.addAdmin.mockRejectedValue(new SignInConfigError("No verified identity", 404));
    expect((await server.inject(operations[3])).statusCode).toBe(404);
  });
  it("refuses an email several accounts share, with the accounts to choose from, and grants by id", async () => {
    mocks.admin = true;
    const server = await app();
    const candidates = [
      {
        id: adminId,
        displayName: "Alice",
        provider: "github",
        createdAt: "2026-10-01T00:00:00.000Z",
        lastLoginAt: "2026-10-31T00:00:00.000Z",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        displayName: "Alice",
        provider: "gitea",
        createdAt: "2026-09-01T00:00:00.000Z",
        lastLoginAt: "2026-10-30T00:00:00.000Z",
      },
    ];
    mocks.addAdmin.mockRejectedValueOnce(
      new (SignInConfigError as any)("2 accounts have the verified email", 409, candidates),
    );
    const ambiguous = await server.inject(operations[3]);
    expect(ambiguous.statusCode).toBe(409);
    expect(ambiguous.json()).toEqual({
      error: "2 accounts have the verified email",
      details: "ambiguous_email",
      candidates,
    });
    const byId = await server.inject({
      method: "POST",
      url: "/api/auth/deployment-admins",
      payload: { userId: adminId },
    });
    expect(byId.statusCode).toBe(201);
    expect(mocks.addAdmin).toHaveBeenLastCalledWith({ userId: adminId });
    const both = await server.inject({
      method: "POST",
      url: "/api/auth/deployment-admins",
      payload: { userId: adminId, email: "person@acme.test" },
    });
    expect(both.statusCode).toBe(400);
  });
  it("preserves last-admin protection and reports unexpected service failures", async () => {
    mocks.admin = true;
    const server = await app();
    mocks.removeAdmin.mockRejectedValueOnce(new SignInConfigError("Last administrator", 400));
    expect((await server.inject(operations[4])).statusCode).toBe(400);
    mocks.removeAdmin.mockRejectedValueOnce(new Error("database unavailable"));
    expect((await server.inject(operations[4])).statusCode).toBe(500);
    expect((await server.inject(operations[4])).statusCode).toBe(204);
    expect(mocks.removeAdmin).toHaveBeenCalledWith(adminId, "user-1");
  });
  it("logs who is added to and removed from the admin group, and only when it happens", async () => {
    mocks.admin = true;
    const server = await app();
    await server.inject(operations[3]);
    expect(mocks.action).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "sign_in.deployment_admin_added", userId: "user-1" }),
    );
    mocks.action.mockClear();
    mocks.removeAdmin.mockRejectedValueOnce(new SignInConfigError("Last administrator", 400));
    await server.inject(operations[4]);
    expect(mocks.action).not.toHaveBeenCalled();
    expect((await server.inject(operations[4])).statusCode).toBe(204);
    expect(mocks.action).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sign_in.deployment_admin_removed",
        userId: "user-1",
        result: { id: adminId },
      }),
    );
  });
});

describe("claiming the first deployment administrator", () => {
  it("allows explicit auth-disabled development without writing a grant", async () => {
    mocks.authDisabled = true;
    expect(
      (
        await (
          await app(false)
        ).inject({ method: "POST", url: "/api/auth/deployment-admins/claim" })
      ).statusCode,
    ).toBe(200);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("requires a signed-in person and refuses to replace an existing administrator", async () => {
    const operation = {
      method: "POST" as const,
      url: "/api/auth/deployment-admins/claim",
      headers: tokenHeader,
    };
    expect((await (await app(false)).inject(operation)).statusCode).toBe(401);
    expect((await (await app()).inject(operation)).statusCode).toBe(403);
    expect(mocks.verifyToken).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("requires the correct setup token before granting the caller's role", async () => {
    mocks.hasAdmin = false;
    const server = await app();
    const operation = { method: "POST" as const, url: "/api/auth/deployment-admins/claim" };
    expect((await server.inject(operation)).statusCode).toBe(403);
    expect((await server.inject({ ...operation, headers: tokenHeader })).statusCode).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.verifyToken.mockResolvedValue(true);
    expect((await server.inject({ ...operation, headers: tokenHeader })).json()).toEqual({
      ok: true,
    });
    expect(mocks.set).toHaveBeenCalledWith({ deploymentAdmin: true });
    expect(mocks.action).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", action: "sign_in.deployment_admin_claimed" }),
    );
  });
});
