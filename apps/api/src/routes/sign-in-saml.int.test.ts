import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import formbody from "@fastify/formbody";
import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { idpCert, idpEntityId, requestId, samlResponse } from "../test-utils/fake-saml.js";
import { authRoutes } from "./auth.js";
import { listEnabledProviders } from "../services/oauth/index.js";
import {
  deleteSignInConfig,
  listSignInProviders,
  saveSignInConfig,
  resolveProviderConfig,
} from "../services/sign-in-config-service.js";
import { getRedisClient } from "../services/event-bus.js";
import { createHash } from "node:crypto";

let app: FastifyInstance;
let operator: string;
const browserVerifier = "v".repeat(43);
const browserChallenge = createHash("sha256").update(browserVerifier).digest("base64url");
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
  await configureSaml();
});
afterAll(async () => {
  await app.close();
  vi.unstubAllEnvs();
});

async function configureSaml() {
  return saveSignInConfig(
    "saml",
    {
      displayName: "Example SAML",
      settings: { entryPoint: `${idpEntityId}/sso`, idpEntityId, idpCert },
    },
    operator,
  );
}

async function startSaml() {
  const login = await app.inject({
    method: "GET",
    url: `/api/auth/saml/login?browserChallenge=${browserChallenge}`,
  });
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
  it("returns 404 for an unconfigured SAML login", async () => {
    await deleteSignInConfig("saml");
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/auth/saml/login?browserChallenge=${browserChallenge}`,
      });
      expect(response.statusCode, response.body).toBe(404);
    } finally {
      await configureSaml();
    }
  });
  it("signs in through the real POST callback and refuses reuse of its state", async () => {
    const { state, id } = await startSaml();
    const result = await postSaml(state, id);
    expect(result.statusCode, result.body).toBe(302);
    expect(result.headers.location).toMatch(/\/auth\/callback\?code=/);
    const [user] = await db.select().from(users).where(eq(users.externalId, "person-123"));
    // The deployment hasn't declared the IdP's addresses authoritative
    // (trustEmail), so the account's email isn't verified: it grants nothing
    // by email (deployment admins, joining by domain, linking).
    expect(user).toMatchObject({
      provider: "saml",
      email: "alice@example.test",
      emailVerified: false,
    });
    const code = new URL(result.headers.location!).searchParams.get("code");
    const exchange = {
      method: "POST" as const,
      url: "/api/auth/exchange-code",
      payload: { code, browserVerifier },
    };
    expect((await app.inject(exchange)).statusCode).toBe(200);
    expect((await app.inject(exchange)).statusCode).toBe(400);
    expect((await postSaml(state, id)).headers.location).toContain("error=invalid_state");
  });
  it("counts the IdP's address as verified once trustEmail says it's authoritative", async () => {
    await saveSignInConfig(
      "saml",
      {
        displayName: "Example SAML",
        settings: { entryPoint: `${idpEntityId}/sso`, idpEntityId, idpCert, trustEmail: true },
      },
      operator,
    );
    try {
      const { state, id } = await startSaml();
      expect((await postSaml(state, id)).statusCode).toBe(302);
      const [user] = await db.select().from(users).where(eq(users.externalId, "person-123"));
      expect(user.emailVerified).toBe(true);
    } finally {
      await configureSaml();
    }
  });
  it("still answers its own allowed domains with an address it doesn't trust", async () => {
    await saveSignInConfig(
      "saml",
      {
        displayName: "Example SAML",
        settings: { entryPoint: `${idpEntityId}/sso`, idpEntityId, idpCert },
        allowedDomains: ["example.test"],
      },
      operator,
    );
    try {
      const { state, id } = await startSaml();
      const result = await postSaml(state, id);
      expect(result.headers.location).toMatch(/\/auth\/callback\?code=/);
    } finally {
      await configureSaml();
    }
  });
  it("refuses a stolen SAML browser code and consumes it atomically", async () => {
    const { state, id } = await startSaml();
    const result = await postSaml(state, id);
    const code = new URL(result.headers.location!).searchParams.get("code");
    const stolen = await app.inject({
      method: "POST",
      url: "/api/auth/exchange-code",
      payload: { code, browserVerifier: "x".repeat(43) },
    });
    expect(stolen.statusCode).toBe(400);
    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/exchange-code",
      payload: { code, browserVerifier },
    });
    expect(replay.statusCode).toBe(400);
  });
  it("revokes a valid SAML sign-in whose stored state has no browser binding", async () => {
    const { state, id } = await startSaml();
    const redis = getRedisClient();
    await redis.setex(`oauth_state:${state}`, 600, JSON.stringify({ provider: "saml" }));
    const before = await db.select().from(sessions);
    const result = await postSaml(state, id);
    expect(result.headers.location).toContain("error=invalid_state");
    expect(await redis.get(`oauth_state:${state}`)).toBeNull();
    expect(await db.select().from(sessions)).toHaveLength(before.length);
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
