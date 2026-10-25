import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import formbody from "@fastify/formbody";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { authProviderConfigs, users } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { idpCert, idpEntityId, requestId, samlResponse } from "../test-utils/fake-saml.js";
import { authRoutes } from "./auth.js";
import { listEnabledProviders } from "../services/oauth/index.js";
import {
  listSignInProviders,
  saveSignInConfig,
  resolveProviderConfig,
} from "../services/sign-in-config-service.js";
import { getRedisClient } from "../services/event-bus.js";
import { createHash } from "node:crypto";

let app: FastifyInstance;
let operator: string;
beforeAll(async () => {
  vi.stubEnv("PUBLIC_API_URL", "https://optio.example.test");
  vi.stubEnv("OPTIO_LINK_ACCOUNTS_BY_EMAIL", "false");
  const [row] = await db
    .insert(users)
    .values({
      provider: "google",
      externalId: randomUUID(),
      email: "operator@example.test",
      displayName: "Operator",
      deploymentAdmin: true,
    })
    .returning();
  operator = row.id;
  app = await buildRouteTestApp(
    async (a) => {
      await a.register(formbody);
      await authRoutes(a);
    },
    { user: null },
  );
});
afterAll(async () => {
  await app.close();
  vi.unstubAllEnvs();
});

async function configureSaml(requiredGroups: string[] = []) {
  return saveSignInConfig(
    "saml",
    {
      displayName: "Example SAML",
      settings: { entryPoint: `${idpEntityId}/sso`, idpEntityId, idpCert, requiredGroups },
    },
    operator,
  );
}

async function startSaml() {
  const login = await app.inject({ method: "GET", url: "/api/auth/saml/login" });
  expect(login.statusCode, login.body).toBe(302);
  const url = new URL(login.headers.location!);
  return { state: url.searchParams.get("RelayState")!, id: requestId(url.toString()) };
}
const postSaml = (state: string, id: string) =>
  app.inject({
    method: "POST",
    url: "/api/auth/saml/callback",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ RelayState: state, SAMLResponse: samlResponse(id) }).toString(),
  });

describe("additional sign-in configuration and routes", () => {
  it("lists new options disabled until configured, encrypts OAuth secrets, and supports concurrent providers", async () => {
    const before = await listSignInProviders();
    for (const provider of ["bitbucket", "gitea", "saml"])
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
    const saml = await configureSaml();
    expect(saml.metadataUrl).toBe("https://optio.example.test/api/auth/saml/metadata");
    const enabled = await listEnabledProviders();
    expect(enabled.map((p) => p.name)).toEqual(
      expect.arrayContaining(["bitbucket", "gitea", "saml"]),
    );
  });
  it("signs in through the real POST callback and refuses reuse of its state", async () => {
    const { state, id } = await startSaml();
    const result = await postSaml(state, id);
    expect(result.statusCode, result.body).toBe(302);
    expect(result.headers.location).toMatch(/\/auth\/callback\?code=/);
    const [user] = await db.select().from(users).where(eq(users.externalId, "person-123"));
    expect(user).toMatchObject({
      provider: "saml",
      email: "alice@example.test",
      ssoGroups: expect.arrayContaining(["Developers", "Admins"]),
    });
    expect((await postSaml(state, id)).headers.location).toContain("error=invalid_state");
  });
  it("uses supplied SAML groups for required-group checks", async () => {
    await configureSaml(["OtherGroup"]);
    const { state, id } = await startSaml();
    expect((await postSaml(state, id)).headers.location).toContain("error=group_not_allowed");
    await configureSaml(["Developers"]);
  });
  it("supports the CLI browser flow for SAML and preserves its PKCE challenge", async () => {
    const state = "cli-test-state";
    const verifier = "a-cli-verifier-that-will-match-the-challenge";
    const start = await app.inject({
      method: "POST",
      url: "/api/auth/cli/start",
      payload: {
        provider: "saml",
        callback: "http://127.0.0.1:18271/cb",
        state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      },
    });
    expect(start.statusCode, start.body).toBe(200);
    const url = new URL(start.json().url);
    const callback = await postSaml(url.searchParams.get("RelayState")!, requestId(url.toString()));
    const loopback = new URL(callback.headers.location!);
    expect(loopback.origin).toBe("http://127.0.0.1:18271");
    expect(loopback.searchParams.get("state")).toBe(state);
    const token = await app.inject({
      method: "POST",
      url: "/api/auth/cli/token",
      payload: { code: loopback.searchParams.get("code"), code_verifier: verifier },
    });
    expect(token.statusCode, token.body).toBe(200);
    expect(token.json().token).toMatch(/^optio_/);
    expect(token.json().user.email).toBe("alice@example.test");
  });
  it("exports metadata and rejects a missing or unknown RelayState", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/saml/metadata" });
    expect(res.headers["content-type"]).toContain("application/samlmetadata+xml");
    expect(res.body).toContain('WantAssertionsSigned="true"');
    const callback = await app.inject({
      method: "POST",
      url: "/api/auth/saml/callback",
      payload: { SAMLResponse: "bogus", RelayState: "unknown" },
    });
    expect(callback.headers.location).toContain("error=invalid_state");
    expect(await getRedisClient().get("oauth_state:unknown")).toBeNull();
  });
});
