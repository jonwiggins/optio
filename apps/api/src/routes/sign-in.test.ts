import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

/**
 * /api/auth/sign-in and /api/auth/deployment-admins: who may change how
 * everyone signs in (a deployment admin, or the setup token while it is
 * usable), and what each route hands the sign-in config service.
 */

const svc = vi.hoisted(() => {
  class SignInConfigError extends Error {
    constructor(
      message: string,
      readonly status: 400 | 403 | 404 | 409 = 400,
    ) {
      super(message);
      this.name = "SignInConfigError";
    }
  }
  return {
    SignInConfigError,
    addDeploymentAdminByEmail: vi.fn(),
    deleteSignInConfig: vi.fn(),
    hasDeploymentAdmin: vi.fn(),
    isBootstrapMode: vi.fn(),
    isDeploymentAdmin: vi.fn(),
    listDeploymentAdmins: vi.fn(),
    listSignInProviders: vi.fn(),
    markOrganizationWorkspace: vi.fn(),
    organizationWorkspaceId: vi.fn(async (): Promise<string | null> => null),
    recordBootstrapClaim: vi.fn(),
    removeDeploymentAdmin: vi.fn(),
    saveSignInConfig: vi.fn(),
    setupTokenUsable: vi.fn(),
    testSignInProvider: vi.fn(),
    verifySetupToken: vi.fn(),
  };
});
vi.mock("../services/sign-in-config-service.js", () => svc);

vi.mock("../services/oauth/index.js", () => ({ isAuthDisabled: () => false }));
vi.mock("../services/optio-action-service.js", () => ({
  logAction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/sign-in-groups.js", () => ({ searchSignInGroups: vi.fn() }));
vi.mock("../services/workspace-service.js", () => ({
  normalizeAutoJoinDomains: (domains: string[]) => ({
    domains: domains.map((d) => d.trim().toLowerCase()),
  }),
}));

const dbUpdate = vi.hoisted(() => {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  return { update: vi.fn(() => ({ set })), set, where };
});
// The workspaces a select finds (the organization workspace routes).
const dbSelect = vi.hoisted(() => ({ rows: [] as Array<{ id: string; name: string }> }));
vi.mock("../db/client.js", () => ({
  db: {
    update: dbUpdate.update,
    select: () => ({ from: () => ({ where: async () => dbSelect.rows }) }),
  },
}));

import { signInRoutes } from "./sign-in.js";

const TOKEN = "setup-token-123";
const ADMIN_ID = "33333333-3333-4333-8333-333333333333";
const oidcBody = {
  clientId: "optio",
  clientSecret: "s3cret",
  allowedDomains: [" Acme.COM "],
  settings: { issuerUrl: "https://sso.acme.example/realms/optio" },
};

describe("sign-in routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    // A running deployment: providers configured, a deployment admin, token spent.
    svc.isBootstrapMode.mockResolvedValue(false);
    svc.hasDeploymentAdmin.mockResolvedValue(true);
    svc.setupTokenUsable.mockResolvedValue(false);
    svc.verifySetupToken.mockImplementation(async (t: string) => t === TOKEN);
    svc.isDeploymentAdmin.mockResolvedValue(true);
    svc.listSignInProviders.mockResolvedValue([{ provider: "oidc", enabled: true }]);
    svc.listDeploymentAdmins.mockResolvedValue([{ id: ADMIN_ID, email: "root@acme.com" }]);
    app = await buildRouteTestApp(signInRoutes);
  });

  describe("GET /api/auth/sign-in", () => {
    it("shows a deployment admin everything, the admins too", async () => {
      const res = await app.inject({ method: "GET", url: "/api/auth/sign-in" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        bootstrap: false,
        canEdit: true,
        canClaim: false,
        providers: [{ provider: "oidc" }],
        deploymentAdmins: [{ id: ADMIN_ID }],
      });
    });

    it("shows anyone else the providers, but not the admins, and no way to edit", async () => {
      svc.isDeploymentAdmin.mockResolvedValue(false);
      const res = await app.inject({ method: "GET", url: "/api/auth/sign-in" });
      const body = res.json();
      expect(body).toMatchObject({ canEdit: false, canClaim: false });
      expect(body.deploymentAdmins).toBeUndefined();
    });

    it("lets a signed-in person claim the role while the deployment has no admin", async () => {
      svc.isDeploymentAdmin.mockResolvedValue(false);
      svc.hasDeploymentAdmin.mockResolvedValue(false);
      svc.setupTokenUsable.mockResolvedValue(true);
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/sign-in",
        headers: { "x-optio-setup-token": TOKEN },
      });
      expect(res.json()).toMatchObject({ canEdit: true, canClaim: true });
    });
  });

  describe("PUT /api/auth/sign-in/:provider", () => {
    it("saves as a deployment admin, without a bootstrap claim once there is an admin", async () => {
      svc.saveSignInConfig.mockResolvedValue({ provider: "oidc", enabled: true });
      const res = await app.inject({
        method: "PUT",
        url: "/api/auth/sign-in/oidc",
        payload: { ...oidcBody, organizationName: "Acme" },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({
        provider: { provider: "oidc", enabled: true },
        bootstrap: false,
      });
      const [provider, input, actor] = svc.saveSignInConfig.mock.calls[0];
      expect(provider).toBe("oidc");
      expect(input).toMatchObject({ clientId: "optio", clientSecret: "s3cret" });
      expect(input).not.toHaveProperty("organizationName");
      expect(actor).toBe("user-1");
      expect(svc.recordBootstrapClaim).not.toHaveBeenCalled();
    });

    it("bootstraps with the setup token: records what the first sign-in completes", async () => {
      svc.isDeploymentAdmin.mockResolvedValue(false);
      svc.hasDeploymentAdmin.mockResolvedValue(false);
      svc.isBootstrapMode.mockResolvedValue(true);
      svc.setupTokenUsable.mockResolvedValue(true);
      svc.saveSignInConfig.mockResolvedValue({ provider: "oidc" });
      const anonymous = await buildRouteTestApp(signInRoutes, { user: null });
      const res = await anonymous.inject({
        method: "PUT",
        url: "/api/auth/sign-in/oidc",
        headers: { "x-optio-setup-token": TOKEN },
        payload: { ...oidcBody, organizationName: "  Acme Corp " },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(svc.saveSignInConfig.mock.calls[0][2]).toBeNull();
      expect(svc.recordBootstrapClaim).toHaveBeenCalledWith({
        provider: "oidc",
        organizationName: "Acme Corp",
        domains: ["acme.com"],
      });
    });

    it("refuses anyone else: the token while bootstrapping, the admins afterwards", async () => {
      svc.isDeploymentAdmin.mockResolvedValue(false);
      const res = await app.inject({
        method: "PUT",
        url: "/api/auth/sign-in/oidc",
        payload: oidcBody,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("Only a deployment admin can change how people sign in");

      // A token that is right but spent opens nothing.
      const spent = await app.inject({
        method: "PUT",
        url: "/api/auth/sign-in/oidc",
        headers: { "x-optio-setup-token": TOKEN },
        payload: oidcBody,
      });
      expect(spent.statusCode).toBe(403);

      svc.isBootstrapMode.mockResolvedValue(true);
      svc.setupTokenUsable.mockResolvedValue(true);
      const wrong = await app.inject({
        method: "PUT",
        url: "/api/auth/sign-in/oidc",
        headers: { "x-optio-setup-token": "guess" },
        payload: oidcBody,
      });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json().error).toMatch(/setup token is required/);
      expect(svc.saveSignInConfig).not.toHaveBeenCalled();
    });

    it("answers the service's refusals with their status", async () => {
      svc.saveSignInConfig.mockRejectedValueOnce(
        new svc.SignInConfigError("A client secret is required"),
      );
      const res = await app.inject({
        method: "PUT",
        url: "/api/auth/sign-in/oidc",
        payload: oidcBody,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "A client secret is required" });

      svc.saveSignInConfig.mockRejectedValueOnce(
        new svc.SignInConfigError("Unknown sign-in provider: nope", 404),
      );
      const unknown = await app.inject({
        method: "PUT",
        url: "/api/auth/sign-in/nope",
        payload: oidcBody,
      });
      expect(unknown.statusCode).toBe(404);
    });
  });

  describe("POST /api/auth/sign-in/:provider/test and DELETE", () => {
    it("tests unsaved settings and returns what the service found", async () => {
      svc.testSignInProvider.mockResolvedValue({ ok: false, error: "issuer unreachable" });
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/oidc/test",
        payload: { settings: oidcBody.settings },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ ok: false, error: "issuer unreachable" });
      expect(svc.testSignInProvider).toHaveBeenCalledWith(
        "oidc",
        expect.objectContaining({ settings: oidcBody.settings }),
      );
      expect(svc.saveSignInConfig).not.toHaveBeenCalled();
    });

    it("forgets a stored provider (204), for deployment admins only", async () => {
      const res = await app.inject({ method: "DELETE", url: "/api/auth/sign-in/ldap" });
      expect(res.statusCode).toBe(204);
      expect(svc.deleteSignInConfig).toHaveBeenCalledWith("ldap");

      svc.isDeploymentAdmin.mockResolvedValue(false);
      const refused = await app.inject({ method: "DELETE", url: "/api/auth/sign-in/ldap" });
      expect(refused.statusCode).toBe(403);
      expect(svc.deleteSignInConfig).toHaveBeenCalledTimes(1);
    });
  });

  describe("deployment admins", () => {
    it("lists, adds by email and removes, never the last one", async () => {
      const list = await app.inject({ method: "GET", url: "/api/auth/deployment-admins" });
      expect(list.json()).toEqual({ admins: [{ id: ADMIN_ID, email: "root@acme.com" }] });

      svc.addDeploymentAdminByEmail.mockResolvedValue({ id: "u-2", email: "ann@acme.com" });
      const added = await app.inject({
        method: "POST",
        url: "/api/auth/deployment-admins",
        payload: { email: "ann@acme.com" },
      });
      expect(added.statusCode).toBe(201);
      expect(added.json()).toEqual({ admin: { id: "u-2", email: "ann@acme.com" } });

      svc.addDeploymentAdminByEmail.mockRejectedValue(
        new svc.SignInConfigError("No one with the email x@acme.com has signed in yet", 404),
      );
      const unknown = await app.inject({
        method: "POST",
        url: "/api/auth/deployment-admins",
        payload: { email: "x@acme.com" },
      });
      expect(unknown.statusCode).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/auth/deployment-admins",
            payload: { email: "not-an-email" },
          })
        ).statusCode,
      ).toBe(400);

      const removed = await app.inject({
        method: "DELETE",
        url: `/api/auth/deployment-admins/${ADMIN_ID}`,
      });
      expect(removed.statusCode).toBe(204);
      expect(svc.removeDeploymentAdmin).toHaveBeenCalledWith(ADMIN_ID, "user-1");

      svc.removeDeploymentAdmin.mockRejectedValue(
        new svc.SignInConfigError("The last deployment admin can't be removed", 400),
      );
      const last = await app.inject({
        method: "DELETE",
        url: `/api/auth/deployment-admins/${ADMIN_ID}`,
      });
      expect(last.statusCode).toBe(400);
      expect(last.json().error).toBe("The last deployment admin can't be removed");
    });

    it("refuses a member who isn't a deployment admin", async () => {
      svc.isDeploymentAdmin.mockResolvedValue(false);
      for (const [method, url] of [
        ["GET", "/api/auth/deployment-admins"],
        ["DELETE", `/api/auth/deployment-admins/${ADMIN_ID}`],
      ] as const) {
        expect((await app.inject({ method, url })).statusCode).toBe(403);
      }
      expect(svc.removeDeploymentAdmin).not.toHaveBeenCalled();
    });

    it("claims the role with the setup token only while nobody holds it", async () => {
      const claim = (headers: Record<string, string> = {}, a = app) =>
        a.inject({ method: "POST", url: "/api/auth/deployment-admins/claim", headers });

      expect((await claim({ "x-optio-setup-token": TOKEN })).statusCode).toBe(403);

      svc.hasDeploymentAdmin.mockResolvedValue(false);
      expect((await claim({ "x-optio-setup-token": "guess" })).statusCode).toBe(403);
      const anonymous = await buildRouteTestApp(signInRoutes, { user: null });
      expect((await claim({ "x-optio-setup-token": TOKEN }, anonymous)).statusCode).toBe(401);
      expect(dbUpdate.update).not.toHaveBeenCalled();

      const ok = await claim({ "x-optio-setup-token": TOKEN });
      expect(ok.statusCode).toBe(200);
      expect(dbUpdate.set).toHaveBeenCalledWith({ deploymentAdmin: true });
    });
  });

  describe("the organization workspace", () => {
    const WS = "44444444-4444-4444-8444-444444444444";

    it("a deployment admin marks one; GET says which", async () => {
      dbSelect.rows = [{ id: WS, name: "Acme" }];
      const res = await app.inject({ method: "PUT", url: `/api/workspaces/${WS}/organization` });
      expect(res.statusCode).toBe(200);
      expect(svc.markOrganizationWorkspace).toHaveBeenCalledWith(WS);

      svc.organizationWorkspaceId.mockResolvedValueOnce(WS);
      const view = await app.inject({ method: "GET", url: "/api/auth/sign-in" });
      expect(view.json().organizationWorkspace).toEqual({ id: WS, name: "Acme" });
    });

    it("refuses anyone else, and an unknown workspace", async () => {
      dbSelect.rows = [];
      expect(
        (await app.inject({ method: "PUT", url: `/api/workspaces/${WS}/organization` })).statusCode,
      ).toBe(404);
      svc.isDeploymentAdmin.mockResolvedValue(false);
      dbSelect.rows = [{ id: WS, name: "Acme" }];
      expect(
        (await app.inject({ method: "PUT", url: `/api/workspaces/${WS}/organization` })).statusCode,
      ).toBe(403);
      expect(svc.markOrganizationWorkspace).not.toHaveBeenCalled();
    });
  });
});
