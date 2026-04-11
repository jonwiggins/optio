/**
 * OpenAPI spec smoke test.
 *
 * Boots the full server and interrogates `app.swagger()` to verify structural
 * invariants we want to preserve across the phased migration.
 *
 * This file gets tighter in each phase: as routes migrate to the Zod type
 * provider, add specific assertions (expected routes carry summary,
 * operationId, tag, response schemas, etc.) to guard against regression.
 *
 * Invariants that hold TODAY (Phase 0 baseline):
 * - Spec is OpenAPI 3.0.3
 * - Info title/version present
 * - The 10 canonical tags are declared
 * - `components.securitySchemes.cookieAuth` and `bearerAuth` exist
 * - `components.schemas.ErrorResponse` exists
 * - The global default `security` requires one of the two schemes
 * - No `/ws/*` path leaks into the spec
 *
 * Invariants that TIGHTEN in later phases:
 * - Every path+method has a non-empty `summary`
 * - Every path+method has a unique `operationId`
 * - Every path+method has at least one `tag`
 * - No response is labelled "Default Response"
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";

// Avoid touching Redis during the build — rate-limit and BullMQ queues
// connect at module-load/register time otherwise.
process.env.OPTIO_SKIP_RATE_LIMIT_REDIS = "1";

type OpenApiSpec = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  tags?: Array<{ name: string; description?: string }>;
  servers?: Array<{ url: string }>;
  paths: Record<
    string,
    Record<
      string,
      {
        summary?: string;
        operationId?: string;
        tags?: string[];
        responses?: Record<string, { description?: string }>;
      }
    >
  >;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  security?: Array<Record<string, unknown>>;
};

let app: FastifyInstance;
let spec: OpenApiSpec;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  spec = (app as unknown as { swagger: () => OpenApiSpec }).swagger();
});

afterAll(async () => {
  await app.close();
});

describe("OpenAPI spec — Phase 0 baseline", () => {
  it("declares OpenAPI 3.0.3", () => {
    expect(spec.openapi).toBe("3.0.3");
  });

  it("has title and version", () => {
    expect(spec.info.title).toBe("Optio API");
    expect(spec.info.version).toBeTruthy();
  });

  it("declares the 10 canonical tags with descriptions", () => {
    const expectedTags = [
      "Tasks",
      "Workflows",
      "Sessions",
      "Reviews & PRs",
      "Repos & Integrations",
      "Cluster",
      "Workspaces",
      "Auth & Sessions",
      "Setup & Settings",
      "System",
    ];
    const actualTagNames = (spec.tags ?? []).map((t) => t.name);
    for (const name of expectedTags) {
      expect(actualTagNames, `missing tag ${name}`).toContain(name);
    }
    for (const tag of spec.tags ?? []) {
      expect(tag.description, `tag ${tag.name} missing description`).toBeTruthy();
    }
  });

  it("declares cookieAuth and bearerAuth security schemes", () => {
    expect(spec.components?.securitySchemes).toBeDefined();
    expect(spec.components?.securitySchemes?.cookieAuth).toBeDefined();
    expect(spec.components?.securitySchemes?.bearerAuth).toBeDefined();
  });

  it("sets the global default security to require one of the two schemes", () => {
    expect(spec.security).toBeDefined();
    expect(Array.isArray(spec.security)).toBe(true);
    // Two entries, each with one scheme, means "either one of these"
    expect(spec.security?.length).toBe(2);
  });

  it("exposes ErrorResponse as a named component schema", () => {
    expect(spec.components?.schemas).toBeDefined();
    expect(spec.components?.schemas?.ErrorResponse).toBeDefined();
  });

  it("has at least some paths registered", () => {
    const pathCount = Object.keys(spec.paths ?? {}).length;
    expect(pathCount).toBeGreaterThan(50);
  });

  it("does not leak /ws/* paths into the spec", () => {
    const wsPaths = Object.keys(spec.paths ?? {}).filter((p) => p.startsWith("/ws"));
    expect(wsPaths, `WebSocket paths should be hidden: ${wsPaths.join(", ")}`).toHaveLength(0);
  });

  it("does not include the swagger UI's own routes in the spec", () => {
    const docPaths = Object.keys(spec.paths ?? {}).filter((p) => p.startsWith("/docs"));
    expect(docPaths, `/docs paths should be hidden: ${docPaths.join(", ")}`).toHaveLength(0);
  });
});
