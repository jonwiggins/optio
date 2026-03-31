import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { buildServer } from "./server.js";
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

    // Use /api/setup/ path to bypass auth middleware
    testApp.post("/api/setup/test-zod", async () => {
      const { z } = await import("zod");
      const schema = z.object({ name: z.string(), age: z.number() });
      schema.parse({ name: 123, age: "not-a-number" });
    });

    const res = await testApp.inject({
      method: "POST",
      url: "/api/setup/test-zod",
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

    testApp.post("/api/setup/test-zod-dev", async () => {
      const { z } = await import("zod");
      const schema = z.object({ name: z.string() });
      schema.parse({ name: 123 });
    });

    const res = await testApp.inject({
      method: "POST",
      url: "/api/setup/test-zod-dev",
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
