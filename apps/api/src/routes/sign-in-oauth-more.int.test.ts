import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { authRoutes } from "./auth.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { authProviderConfigs } from "../db/schema.js";
import { listEnabledProviders } from "../services/oauth/index.js";
import {
  listSignInProviders,
  saveSignInConfig,
  resolveProviderConfig,
} from "../services/sign-in-config-service.js";
const operator = null;
afterEach(() => vi.unstubAllEnvs());
describe("additional OAuth provider configuration", () => {
  it("refuses browser login for a stored but disabled Gitea provider", async () => {
    await saveSignInConfig(
      "gitea",
      {
        clientId: "disabled-client",
        clientSecret: "dummy",
        settings: { baseUrl: "https://git.example.test" },
        enabled: false,
      },
      operator,
    );
    const app = await buildRouteTestApp(authRoutes);
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/gitea/login?browserChallenge=" + "a".repeat(43),
      });
      expect(res.statusCode, res.body).toBe(404);
      expect(res.headers.location).toBeUndefined();
    } finally {
      await app.close();
      await db.delete(authProviderConfigs).where(eq(authProviderConfigs.provider, "gitea"));
    }
  });
  it("lists new options disabled until configured, encrypts OAuth secrets, and supports concurrent providers", async () => {
    const before = await listSignInProviders();
    for (const provider of ["bitbucket", "gitea"])
      expect(before.find((p) => p.provider === provider)?.enabled).toBe(false);
    for (const provider of ["bitbucket", "gitea"] as const) {
      await saveSignInConfig(
        provider,
        {
          clientId: `${provider}-client`,
          clientSecret: "test-secret",
          settings: provider === "gitea" ? { baseUrl: "https://git.example.test" } : {},
        },
        operator,
      );
      const [stored] = await db
        .select()
        .from(authProviderConfigs)
        .where(eq(authProviderConfigs.provider, provider));
      expect(stored.encryptedClientSecret).not.toBe("test-secret");
      expect((await resolveProviderConfig(provider))?.clientSecret).toBe("test-secret");
      expect(JSON.stringify(await listSignInProviders())).not.toContain("test-secret");
    }
    const enabled = await listEnabledProviders();
    expect(enabled.map((p) => p.name)).toEqual(expect.arrayContaining(["bitbucket", "gitea"]));
  });
});
