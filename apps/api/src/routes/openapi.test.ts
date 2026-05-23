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

type OpenApiResponse = {
  description?: string;
  content?: {
    "application/json"?: { schema?: unknown };
  };
};

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
        responses?: Record<string, OpenApiResponse>;
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

/**
 * Routes migrated by each phase of the rollout. The union of all entries
 * must always be fully documented — summary, operationId, tag, and at
 * least one response with a non-"Default Response" description.
 *
 * When a new phase lands, add its routes here and the assertion below
 * guards against regressions.
 */
interface MigratedRoute {
  method: string;
  path: string;
  /**
   * True for routes that are intentionally under-schematized in the spec
   * (currently only the multi-content-type log-export endpoint). They must
   * still carry summary/operationId/tag, but are allowed to have zero
   * explicit response schemas.
   */
  lenient?: boolean;
}

const MIGRATED_ROUTES: MigratedRoute[] = [
  // Phase 1 — tasks.ts (14 routes)
  { method: "get", path: "/api/tasks" },
  { method: "get", path: "/api/tasks/stats" },
  { method: "get", path: "/api/tasks/search" },
  { method: "get", path: "/api/tasks/{id}" },
  { method: "post", path: "/api/tasks" },
  { method: "post", path: "/api/tasks/{id}/cancel" },
  { method: "post", path: "/api/tasks/{id}/retry" },
  { method: "post", path: "/api/tasks/{id}/force-redo" },
  { method: "get", path: "/api/tasks/{id}/logs" },
  // Multi-content-type endpoint: body varies by ?format=. Response shapes
  // are documented in the description, not as Zod schemas.
  { method: "get", path: "/api/tasks/{id}/logs/export", lenient: true },
  { method: "get", path: "/api/tasks/{id}/events" },
  { method: "post", path: "/api/tasks/{id}/review" },
  { method: "post", path: "/api/tasks/{id}/run-now" },
  { method: "post", path: "/api/tasks/reorder" },

  // Phase 2 — task ecosystem (19 routes)
  // subtasks.ts (3)
  { method: "get", path: "/api/tasks/{id}/subtasks" },
  { method: "post", path: "/api/tasks/{id}/subtasks" },
  { method: "get", path: "/api/tasks/{id}/subtasks/status" },
  // dependencies.ts (4)
  { method: "get", path: "/api/tasks/{id}/dependencies" },
  { method: "get", path: "/api/tasks/{id}/dependents" },
  { method: "post", path: "/api/tasks/{id}/dependencies" },
  { method: "delete", path: "/api/tasks/{id}/dependencies/{depTaskId}" },
  // bulk.ts (2)
  { method: "post", path: "/api/tasks/bulk/retry-failed" },
  { method: "post", path: "/api/tasks/bulk/cancel-active" },
  // comments.ts (5)
  { method: "get", path: "/api/tasks/{id}/comments" },
  { method: "post", path: "/api/tasks/{id}/comments" },
  { method: "patch", path: "/api/tasks/{taskId}/comments/{commentId}" },
  { method: "delete", path: "/api/tasks/{taskId}/comments/{commentId}" },
  { method: "get", path: "/api/tasks/{id}/activity" },
  // messages.ts (2)
  { method: "post", path: "/api/tasks/{id}/message" },
  { method: "get", path: "/api/tasks/{id}/messages" },
  // resume.ts (2)
  { method: "post", path: "/api/tasks/{id}/resume" },
  { method: "post", path: "/api/tasks/{id}/force-restart" },

  // Phase 3 — workflows & scheduling (24 routes)
  // workflows.ts (12)
  { method: "get", path: "/api/jobs" },
  { method: "post", path: "/api/jobs" },
  { method: "get", path: "/api/jobs/{id}" },
  { method: "patch", path: "/api/jobs/{id}" },
  { method: "post", path: "/api/jobs/{id}/clone" },
  { method: "delete", path: "/api/jobs/{id}" },
  { method: "post", path: "/api/jobs/{id}/runs" },
  { method: "get", path: "/api/jobs/{id}/runs" },
  { method: "get", path: "/api/workflow-runs/{id}" },
  { method: "post", path: "/api/workflow-runs/{id}/retry" },
  { method: "post", path: "/api/workflow-runs/{id}/cancel" },
  { method: "get", path: "/api/workflow-runs/{id}/logs" },
  // workflow-triggers.ts (4)
  { method: "get", path: "/api/jobs/{id}/triggers" },
  { method: "post", path: "/api/jobs/{id}/triggers" },
  { method: "patch", path: "/api/jobs/{id}/triggers/{triggerId}" },
  { method: "delete", path: "/api/jobs/{id}/triggers/{triggerId}" },
  // Phase 4 — sessions, PR reviews, issues (17 routes)
  // sessions.ts (7)
  { method: "get", path: "/api/sessions" },
  { method: "get", path: "/api/sessions/active-count" },
  { method: "get", path: "/api/sessions/{id}" },
  { method: "post", path: "/api/sessions" },
  { method: "post", path: "/api/sessions/{id}/end" },
  { method: "get", path: "/api/sessions/{id}/prs" },
  { method: "post", path: "/api/sessions/{id}/prs" },
  // pr-reviews.ts
  { method: "get", path: "/api/pull-requests" },
  { method: "post", path: "/api/pr-reviews" },
  { method: "get", path: "/api/pr-reviews/{id}" },
  { method: "patch", path: "/api/pr-reviews/{id}" },
  { method: "post", path: "/api/pr-reviews/{id}/submit" },
  { method: "post", path: "/api/pr-reviews/{id}/re-review" },
  { method: "post", path: "/api/pull-requests/merge" },
  { method: "get", path: "/api/pull-requests/status" },
  // issues.ts (2)
  { method: "get", path: "/api/issues" },
  { method: "post", path: "/api/issues/assign" },

  // Phase 5 — repos & integrations (47 routes)
  // repos.ts (6)
  { method: "get", path: "/api/repos" },
  { method: "get", path: "/api/repos/{id}" },
  { method: "post", path: "/api/repos" },
  { method: "patch", path: "/api/repos/{id}" },
  { method: "delete", path: "/api/repos/{id}" },
  { method: "post", path: "/api/repos/{id}/detect" },
  // webhooks.ts (7)
  { method: "get", path: "/api/webhooks" },
  { method: "get", path: "/api/webhooks/{id}" },
  { method: "post", path: "/api/webhooks" },
  { method: "patch", path: "/api/webhooks/{id}" },
  { method: "delete", path: "/api/webhooks/{id}" },
  { method: "post", path: "/api/webhooks/{id}/test" },
  { method: "get", path: "/api/webhooks/{id}/deliveries" },
  // mcp-servers.ts (7)
  { method: "get", path: "/api/mcp-servers" },
  { method: "get", path: "/api/mcp-servers/{id}" },
  { method: "post", path: "/api/mcp-servers" },
  { method: "patch", path: "/api/mcp-servers/{id}" },
  { method: "delete", path: "/api/mcp-servers/{id}" },
  { method: "get", path: "/api/repos/{id}/mcp-servers" },
  { method: "post", path: "/api/repos/{id}/mcp-servers" },
  // skills.ts (5)
  { method: "get", path: "/api/skills" },
  { method: "get", path: "/api/skills/{id}" },
  { method: "post", path: "/api/skills" },
  { method: "patch", path: "/api/skills/{id}" },
  { method: "delete", path: "/api/skills/{id}" },
  // prompt-templates.ts (5)
  { method: "get", path: "/api/prompt-templates/effective" },
  { method: "get", path: "/api/prompt-templates/builtin-default" },
  { method: "get", path: "/api/prompt-templates/review-default" },
  { method: "get", path: "/api/prompt-templates" },
  { method: "post", path: "/api/prompt-templates" },
  // shared-directories.ts (7)
  { method: "get", path: "/api/repos/{id}/shared-directories" },
  { method: "post", path: "/api/repos/{id}/shared-directories" },
  { method: "patch", path: "/api/repos/{id}/shared-directories/{dirId}" },
  { method: "delete", path: "/api/repos/{id}/shared-directories/{dirId}" },
  { method: "post", path: "/api/repos/{id}/shared-directories/{dirId}/clear" },
  { method: "post", path: "/api/repos/{id}/shared-directories/{dirId}/usage" },
  { method: "post", path: "/api/repos/{id}/pods/recycle" },
  // tickets.ts (4 — GitHub webhook is hidden from spec)
  { method: "get", path: "/api/tickets/providers" },
  { method: "post", path: "/api/tickets/sync" },
  { method: "post", path: "/api/tickets/providers" },
  { method: "delete", path: "/api/tickets/providers/{id}" },
  // slack.ts (2 — actions webhook is hidden from spec)
  { method: "post", path: "/api/slack/test" },
  { method: "get", path: "/api/slack/status" },

  // Phase 6 — workspaces, notifications, analytics (18 routes)
  // workspaces.ts (10)
  { method: "get", path: "/api/workspaces" },
  { method: "get", path: "/api/workspaces/{id}" },
  { method: "post", path: "/api/workspaces" },
  { method: "patch", path: "/api/workspaces/{id}" },
  { method: "delete", path: "/api/workspaces/{id}" },
  { method: "post", path: "/api/workspaces/{id}/switch" },
  { method: "get", path: "/api/workspaces/{id}/members" },
  { method: "post", path: "/api/workspaces/{id}/members" },
  { method: "patch", path: "/api/workspaces/{id}/members/{userId}" },
  { method: "delete", path: "/api/workspaces/{id}/members/{userId}" },
  // notifications.ts (7)
  { method: "get", path: "/api/notifications/vapid-public-key" },
  { method: "post", path: "/api/notifications/subscribe" },
  { method: "delete", path: "/api/notifications/subscribe" },
  { method: "get", path: "/api/notifications/subscriptions" },
  { method: "get", path: "/api/notifications/preferences" },
  { method: "put", path: "/api/notifications/preferences" },
  { method: "post", path: "/api/notifications/test" },
  // analytics.ts (1)
  { method: "get", path: "/api/analytics/costs" },

  // Phase 7 — setup, secrets, optio, cluster (28 routes)
  // setup.ts (12)
  { method: "get", path: "/api/setup/status" },
  { method: "post", path: "/api/setup/validate/github-token" },
  { method: "post", path: "/api/setup/validate/gitlab-token" },
  { method: "post", path: "/api/setup/validate/aws-credentials" },
  { method: "post", path: "/api/setup/validate/anthropic-key" },
  { method: "post", path: "/api/setup/validate/copilot-token" },
  { method: "post", path: "/api/setup/validate/openai-key" },
  { method: "post", path: "/api/setup/validate/gemini-key" },
  { method: "post", path: "/api/setup/repos" },
  { method: "post", path: "/api/setup/repos/gitlab" },
  { method: "post", path: "/api/setup/repos/codecommit" },
  { method: "post", path: "/api/setup/validate/repo" },
  // secrets.ts (3)
  { method: "get", path: "/api/secrets" },
  { method: "post", path: "/api/secrets" },
  { method: "delete", path: "/api/secrets/{name}" },
  // optio.ts (3)
  { method: "get", path: "/api/optio/status" },
  { method: "get", path: "/api/optio/system-status" },
  { method: "get", path: "/api/optio/actions" },
  // optio-settings.ts (2)
  { method: "get", path: "/api/optio/settings" },
  { method: "put", path: "/api/optio/settings" },
  // cluster.ts (7)
  { method: "get", path: "/api/cluster/overview" },
  { method: "get", path: "/api/cluster/pods" },
  { method: "get", path: "/api/cluster/pods/{id}" },
  { method: "get", path: "/api/cluster/health-events" },
  { method: "post", path: "/api/cluster/pods/{id}/restart" },
  { method: "get", path: "/api/cluster/version" },
  { method: "post", path: "/api/cluster/update" },

  // Phase 8 — auth & GitHub (15 visible routes; 4 hidden)
  // auth.ts (11 visible of 13 — claude-token is text/plain + hidden, login/callback are 302 + hidden)
  { method: "get", path: "/api/auth/status" },
  { method: "get", path: "/api/auth/usage" },
  { method: "post", path: "/api/auth/refresh" },
  { method: "get", path: "/api/auth/providers" },
  { method: "post", path: "/api/auth/exchange-code" },
  { method: "get", path: "/api/auth/me" },
  { method: "get", path: "/api/auth/ws-token" },
  { method: "post", path: "/api/auth/cli/start" },
  { method: "post", path: "/api/auth/cli/token" },
  { method: "post", path: "/api/auth/api-keys" },
  { method: "get", path: "/api/auth/api-keys" },
  { method: "delete", path: "/api/auth/api-keys/{id}" },
  { method: "post", path: "/api/auth/logout" },
  // github-app.ts (1 visible — internal git-credentials is hidden)
  { method: "get", path: "/api/github-app/status" },
  // github-token.ts (2)
  { method: "get", path: "/api/github-token/status" },
  { method: "post", path: "/api/github-token/rotate" },

  // Phase 9 — stragglers and hardening
  // health.ts (1)
  { method: "get", path: "/api/health" },
  // hooks.ts (1)
  { method: "post", path: "/api/hooks/{webhookPath}" },
];

describe("OpenAPI spec — migrated routes are fully documented", () => {
  for (const { method, path, lenient } of MIGRATED_ROUTES) {
    it(`${method.toUpperCase()} ${path} has summary, operationId, and tag`, () => {
      const op = spec.paths?.[path]?.[method];
      expect(op, `${method.toUpperCase()} ${path} not in spec`).toBeDefined();
      expect(op?.summary, `${method.toUpperCase()} ${path} missing summary`).toBeTruthy();
      expect(op?.operationId, `${method.toUpperCase()} ${path} missing operationId`).toBeTruthy();
      expect(op?.tags?.length ?? 0, `${method.toUpperCase()} ${path} missing tags`).toBeGreaterThan(
        0,
      );

      if (!lenient) {
        // Must have at least one response with a schema — either an
        // explicit non-fallback `description` or a populated
        // `content.application/json.schema`. Lenient routes opt out —
        // see the `lenient` flag in MIGRATED_ROUTES.
        expect(op?.responses, `${method.toUpperCase()} ${path} missing responses`).toBeDefined();
        const responses = op?.responses ?? {};
        const explicit = Object.values(responses).filter((r) => {
          const hasNonFallbackDescription = r.description && r.description !== "Default Response";
          const hasSchema = !!r.content?.["application/json"]?.schema;
          return hasNonFallbackDescription || hasSchema;
        });
        expect(
          explicit.length,
          `${method.toUpperCase()} ${path} has no schematized responses`,
        ).toBeGreaterThan(0);
      }
    });
  }

  it("migrated routes count matches the sum of completed phases", () => {
    // Removed 14 routes (8 schedule + 6 task-template) that were redundant
    // with agent workflows. 183 - 14 = 169. Then added 2 CodeCommit setup
    // routes (validate/aws-credentials and repos/codecommit) → 171.
    expect(MIGRATED_ROUTES).toHaveLength(171);
  });

  it("components.schemas contains the Task domain types", () => {
    const schemas = spec.components?.schemas ?? {};
    for (const name of ["Task", "EnrichedTask", "TaskEvent", "LogEntry", "TaskStats"]) {
      expect(schemas[name], `components.schemas.${name} missing`).toBeDefined();
    }
  });
});

describe("OpenAPI spec — every visible operation is fully documented", () => {
  // The hardening check — runs across the whole spec, not just a fixed
  // allowlist. Guards against regressions: a new route added anywhere
  // in the API must carry summary + operationId + tag or this test fails.
  it("every visible operation has summary, operationId, and at least one tag", () => {
    const paths = spec.paths ?? {};
    const missing: string[] = [];
    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!op.summary) missing.push(`${method.toUpperCase()} ${path} — missing summary`);
        if (!op.operationId) missing.push(`${method.toUpperCase()} ${path} — missing operationId`);
        if (!op.tags || op.tags.length === 0)
          missing.push(`${method.toUpperCase()} ${path} — missing tags`);
      }
    }
    expect(missing, `routes missing required metadata:\n${missing.join("\n")}`).toEqual([]);
  });

  it("operationIds are globally unique", () => {
    const paths = spec.paths ?? {};
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const id = op.operationId;
        if (!id) continue;
        const existing = seen.get(id);
        if (existing) {
          duplicates.push(`${id}: ${existing} and ${method.toUpperCase()} ${path}`);
        } else {
          seen.set(id, `${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(duplicates, `duplicate operationIds:\n${duplicates.join("\n")}`).toEqual([]);
  });
});
