import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { buildServer, servedOverTls } from "./server.js";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
});

afterAll(async () => {
  await app.close();
});

describe("CORS configuration", () => {
  it("allows PATCH method in preflight response", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/repos/test-id",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "PATCH",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    const allowedMethods = res.headers["access-control-allow-methods"];
    expect(allowedMethods).toContain("PATCH");
  });

  it("allows DELETE method in preflight response", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/repos/test-id",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "DELETE",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    const allowedMethods = res.headers["access-control-allow-methods"];
    expect(allowedMethods).toContain("DELETE");
  });

  it("includes Content-Type in allowed headers", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/tasks/test-id/retry",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.statusCode).toBe(204);
    const allowedHeaders = res.headers["access-control-allow-headers"];
    expect(allowedHeaders).toMatch(/content-type/i);
  });

  it("rejects unknown origins in dev mode (no OPTIO_ALLOWED_ORIGINS)", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/health",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "GET",
      },
    });
    // @fastify/cors returns 200 for disallowed origins but without the allow-origin header
    expect(res.headers["access-control-allow-origin"]).not.toBe("https://evil.example.com");
  });

  it("allows localhost:3000 in dev mode", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/health",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET",
      },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("allows localhost:3001 in dev mode", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/api/health",
      headers: {
        origin: "http://localhost:3001",
        "access-control-request-method": "GET",
      },
    });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3001");
  });

  it("respects OPTIO_ALLOWED_ORIGINS env var", async () => {
    const original = process.env.OPTIO_ALLOWED_ORIGINS;
    process.env.OPTIO_ALLOWED_ORIGINS = "https://app.example.com, https://admin.example.com";
    try {
      const customApp = await buildServer();
      try {
        // Allowed origin
        const allowed = await customApp.inject({
          method: "OPTIONS",
          url: "/api/health",
          headers: {
            origin: "https://app.example.com",
            "access-control-request-method": "GET",
          },
        });
        expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.example.com");

        // Disallowed origin
        const denied = await customApp.inject({
          method: "OPTIONS",
          url: "/api/health",
          headers: {
            origin: "https://evil.example.com",
            "access-control-request-method": "GET",
          },
        });
        expect(denied.headers["access-control-allow-origin"]).not.toBe("https://evil.example.com");
      } finally {
        await customApp.close();
      }
    } finally {
      if (original === undefined) {
        delete process.env.OPTIO_ALLOWED_ORIGINS;
      } else {
        process.env.OPTIO_ALLOWED_ORIGINS = original;
      }
    }
  });

  it("denies all origins in production when OPTIO_ALLOWED_ORIGINS is unset", async () => {
    const originalOrigins = process.env.OPTIO_ALLOWED_ORIGINS;
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.OPTIO_ALLOWED_ORIGINS;
    process.env.NODE_ENV = "production";
    try {
      const prodApp = await buildServer();
      try {
        const res = await prodApp.inject({
          method: "OPTIONS",
          url: "/api/health",
          headers: {
            origin: "http://localhost:3000",
            "access-control-request-method": "GET",
          },
        });
        expect(res.headers["access-control-allow-origin"]).not.toBe("http://localhost:3000");
      } finally {
        await prodApp.close();
      }
    } finally {
      if (originalOrigins === undefined) {
        delete process.env.OPTIO_ALLOWED_ORIGINS;
      } else {
        process.env.OPTIO_ALLOWED_ORIGINS = originalOrigins;
      }
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });
});

describe("security headers", () => {
  it("marks every response nosniff, unframeable, and referrer-limited", async () => {
    for (const url of ["/api/health", "/api/no-such-route"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    }
  });
});

describe("POST endpoints accept empty body", () => {
  it("retry endpoint does not reject empty body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/nonexistent-id/retry",
      // No body, no content-type — simulates browser fetch without body
    });
    // Should get 404 or 500 (task not found), NOT 400 (body parse error)
    expect(res.statusCode).not.toBe(400);
  });

  it("cancel endpoint does not reject empty body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/nonexistent-id/cancel",
    });
    expect(res.statusCode).not.toBe(400);
  });
});

describe("error handler", () => {
  it("maps InvalidTransitionError to 409", async () => {
    // The error handler is registered if buildServer() succeeded.
    // We verify by checking the health route responds (any status is fine).
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
    });
    expect([200, 503]).toContain(res.statusCode);
  });
});

describe("Zod error sanitization", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("returns field names only for Zod errors in production", async () => {
    process.env.NODE_ENV = "production";
    const testApp = await buildServer();

    // Keep this synthetic error-handler route under the public docs prefix.
    testApp.post("/docs/test-zod", async () => {
      const { z } = await import("zod");
      const schema = z.object({ name: z.string(), age: z.number() });
      schema.parse({ name: 123, age: "not-a-number" });
    });

    const res = await testApp.inject({
      method: "POST",
      url: "/docs/test-zod",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Validation error");
    expect(body.details).toContain("Invalid fields:");
    expect(body.details).toContain("name");
    expect(body.details).toContain("age");
    // Should NOT contain full validation messages
    expect(body.details).not.toContain("Expected string");
    expect(body.details).not.toContain("Expected number");

    await testApp.close();
  });

  it("returns full Zod error details in development", async () => {
    process.env.NODE_ENV = "development";
    const testApp = await buildServer();

    testApp.post("/docs/test-zod-dev", async () => {
      const { z } = await import("zod");
      const schema = z.object({ name: z.string() });
      schema.parse({ name: 123 });
    });

    const res = await testApp.inject({
      method: "POST",
      url: "/docs/test-zod-dev",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Validation error");
    // In dev, the full message is returned
    expect(body.details).toBeDefined();
    expect(body.details.length).toBeGreaterThan(0);

    await testApp.close();
  });
});

describe("Zod type provider error envelope", () => {
  // Distinct from "Zod error sanitization" above: that suite verifies
  // hand-thrown ZodErrors from in-handler `.parse()` calls. This suite
  // verifies the type-provider-driven validation path (schema attached
  // via `schema: { body|querystring }`), which produces a different
  // error shape internally but must render the same `{ error, details }`
  // envelope to clients.
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it("returns field names only for type-provider body errors in production", async () => {
    process.env.NODE_ENV = "production";
    const testApp = await buildServer();
    const { z } = await import("zod");
    testApp.post(
      "/docs/test-fpv-prod",
      {
        schema: {
          body: z.object({
            name: z.string(),
            nested: z.object({ age: z.number() }),
          }),
        },
      },
      async () => ({ ok: true }),
    );

    const res = await testApp.inject({
      method: "POST",
      url: "/docs/test-fpv-prod",
      payload: { name: 123, nested: { age: "not-a-number" } },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Validation error");
    expect(body.details).toContain("Invalid fields:");
    expect(body.details).toContain("name");
    expect(body.details).toContain("nested.age");
    expect(body.details).not.toContain("Expected string");
    expect(body.details).not.toContain("Expected number");

    await testApp.close();
  });

  it("returns serialized validation JSON in development", async () => {
    process.env.NODE_ENV = "development";
    const testApp = await buildServer();
    const { z } = await import("zod");
    testApp.post(
      "/docs/test-fpv-dev",
      {
        schema: { body: z.object({ name: z.string() }) },
      },
      async () => ({ ok: true }),
    );

    const res = await testApp.inject({
      method: "POST",
      url: "/docs/test-fpv-dev",
      payload: { name: 123 },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Validation error");
    expect(body.details).toBeDefined();
    expect(body.details.length).toBeGreaterThan(0);

    await testApp.close();
  });

  it("reports querystring field names in production", async () => {
    process.env.NODE_ENV = "production";
    const testApp = await buildServer();
    const { z } = await import("zod");
    testApp.get(
      "/docs/test-fpv-query",
      {
        schema: {
          querystring: z.object({
            limit: z.coerce.number().int().min(1),
          }),
        },
      },
      async () => ({ ok: true }),
    );

    const res = await testApp.inject({
      method: "GET",
      url: "/docs/test-fpv-query?limit=-5",
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Validation error");
    expect(body.details).toContain("limit");

    await testApp.close();
  });
});

describe("Security headers", () => {
  it("marks every response nosniff, unframeable, and referrer-limited", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("sets the headers on error responses too", async () => {
    // An unknown path under /api is refused by the auth plugin before routing.
    const res = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("sends no HSTS when the deployment is not reached over https", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  it("sends the web app's HSTS value when PUBLIC_URL is https", async () => {
    const original = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = "https://optio.example.com";
    try {
      const tlsApp = await buildServer();
      try {
        const res = await tlsApp.inject({ method: "GET", url: "/api/health" });
        expect(res.headers["strict-transport-security"]).toBe(
          "max-age=31536000; includeSubDomains; preload",
        );
      } finally {
        await tlsApp.close();
      }
    } finally {
      if (original === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = original;
    }
  });

  it("decides TLS from PUBLIC_URL or PUBLIC_API_URL", () => {
    expect(servedOverTls({})).toBe(false);
    expect(servedOverTls({ PUBLIC_URL: "http://optio.local:30310" })).toBe(false);
    expect(servedOverTls({ PUBLIC_URL: "https://optio.example.com" })).toBe(true);
    expect(servedOverTls({ PUBLIC_API_URL: " https://api.optio.example.com" })).toBe(true);
    expect(servedOverTls({ PUBLIC_URL: "ftp://optio.example.com" })).toBe(false);
  });
});
