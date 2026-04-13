import { assertMinOpenSSL } from "./openssl-check.js";
import Fastify, { type FastifyError } from "fastify";
import { Redis } from "ioredis";
import cors from "@fastify/cors";
import { redisConnectionUrl, redisTlsOptions } from "./services/redis-config.js";
import formbody from "@fastify/formbody";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import {
  validatorCompiler,
  serializerCompiler,
  createJsonSchemaTransform,
  createJsonSchemaTransformObject,
  ResponseSerializationError,
} from "fastify-type-provider-zod";
import { namedSchemas } from "./schemas/registry.js";
import { healthRoutes } from "./routes/health.js";
import { taskRoutes } from "./routes/tasks.js";
import { secretRoutes } from "./routes/secrets.js";
import { ticketRoutes } from "./routes/tickets.js";
import { setupRoutes } from "./routes/setup.js";
import { authRoutes } from "./routes/auth.js";
import { resumeRoutes } from "./routes/resume.js";
import { promptTemplateRoutes } from "./routes/prompt-templates.js";
import { repoRoutes } from "./routes/repos.js";
import { clusterRoutes } from "./routes/cluster.js";
import { bulkRoutes } from "./routes/bulk.js";
import { issueRoutes } from "./routes/issues.js";
import { prReviewRoutes } from "./routes/pr-reviews.js";
import { subtaskRoutes } from "./routes/subtasks.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { sessionRoutes } from "./routes/sessions.js";

import { commentRoutes } from "./routes/comments.js";
import { messageRoutes } from "./routes/messages.js";
import { slackRoutes } from "./routes/slack.js";

import { workspaceRoutes } from "./routes/workspaces.js";
import { dependencyRoutes } from "./routes/dependencies.js";
import { workflowTriggerRoutes } from "./routes/workflow-triggers.js";
import { mcpServerRoutes } from "./routes/mcp-servers.js";
import { connectionRoutes } from "./routes/connections.js";
import { skillRoutes } from "./routes/skills.js";
import { workflowRoutes } from "./routes/workflows.js";
import { sharedDirectoryRoutes } from "./routes/shared-directories.js";
import { notificationRoutes } from "./routes/notifications.js";
import { optioRoutes } from "./routes/optio.js";
import { optioSettingsRoutes } from "./routes/optio-settings.js";
import { activityRoutes } from "./routes/activity.js";
import githubAppRoutes from "./routes/github-app.js";
import { githubTokenRoutes } from "./routes/github-token.js";
import { hookRoutes } from "./routes/hooks.js";
import { logStreamWs } from "./ws/log-stream.js";
import { eventsWs } from "./ws/events.js";
import { sessionTerminalWs } from "./ws/session-terminal.js";
import { sessionChatWs } from "./ws/session-chat.js";
import { optioChatWs } from "./ws/optio-chat.js";
import { workflowRunLogStreamWs } from "./ws/workflow-run-log-stream.js";
import authPlugin from "./plugins/auth.js";
import { httpMetricsPlugin } from "./plugins/http-metrics.js";

const loggerConfig =
  process.env.NODE_ENV !== "production"
    ? {
        level: process.env.LOG_LEVEL ?? "info",
        transport: { target: "pino-pretty", options: { colorize: true } },
      }
    : { level: process.env.LOG_LEVEL ?? "info" };

export async function buildServer() {
  assertMinOpenSSL(process.versions.openssl);

  const app = Fastify({ logger: loggerConfig });

  // Wire the Zod type provider's validator + serializer compilers.
  // - validatorCompiler: validates req.body / req.query / req.params / req.headers
  //   against the Zod schemas attached via `schema: { body, querystring, params }`.
  //   Validation failures surface as a Fastify FST_ERR_VALIDATION error whose
  //   `.validation` array contains entries with `.params.issue` (ZodIssue) —
  //   the error handler below detects this shape and renders the standard
  //   `{ error, details }` envelope.
  // - serializerCompiler: validates response bodies against `schema.response[code]`
  //   and throws `ResponseSerializationError` on mismatch. Useful as a dev-time
  //   safety net; production behavior is unchanged because it only fires when a
  //   route declares a response schema AND the response doesn't match.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Plugins
  const allowedOrigins = process.env.OPTIO_ALLOWED_ORIGINS
    ? process.env.OPTIO_ALLOWED_ORIGINS.split(",").map((o) => o.trim())
    : process.env.NODE_ENV === "production"
      ? [] // deny all cross-origin requests in production by default
      : ["http://localhost:3000", "http://localhost:3001"];
  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  // Rate limit is backed by Redis in normal operation. The
  // `OPTIO_SKIP_RATE_LIMIT_REDIS` flag lets the OpenAPI dump script build
  // the server without a Redis connection — it registers the plugin
  // in-memory, which is fine because nothing actually serves traffic
  // during the dump.
  if (process.env.OPTIO_SKIP_RATE_LIMIT_REDIS === "1") {
    await app.register(rateLimit, {
      max: 100,
      timeWindow: "1 minute",
      allowList: ["127.0.0.1", "::1"],
    });
  } else {
    await app.register(rateLimit, {
      max: 100,
      timeWindow: "1 minute",
      allowList: ["127.0.0.1", "::1"],
      redis: new Redis(redisConnectionUrl, { tls: redisTlsOptions }),
    });
  }
  await app.register(formbody);
  await app.register(websocket, {
    options: {
      // WebSocket auth tokens are sent via Sec-WebSocket-Protocol header to avoid
      // leaking tokens in URLs. The client sends ["optio-ws-v1", "optio-auth-<TOKEN>"]
      // and we select "optio-ws-v1" so the raw token is never echoed back.
      handleProtocols: (protocols: Set<string>) => {
        if (protocols.has("optio-ws-v1")) return "optio-ws-v1";
        // No recognized protocol — select the first one offered (ws default behavior)
        return protocols.values().next().value ?? false;
      },
    },
  });

  // Auth plugin (validates session cookie on protected routes)
  await app.register(authPlugin);

  // HTTP metrics plugin (request count, latency by route/method/status)
  await app.register(httpMetricsPlugin);

  // OpenAPI spec generation. Must be registered before routes so it can
  // collect their definitions as they register.
  //
  // `transform` converts Zod route schemas (attached via `schema: { body, ... }`)
  // into JSON Schema. `transformObject` walks the finished spec and replaces
  // structurally-identical shapes with `$ref`s into `components.schemas`,
  // using the named schema registry as the source of truth for ref names.
  //
  // Routes are migrated to the type provider incrementally; any route that
  // hasn't been migrated still renders without body/response details (the
  // transform short-circuits on routes with no Zod schemas).
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Optio API",
        description:
          "Workflow orchestration API for AI coding agents. Tasks submitted " +
          "here spin up isolated Kubernetes pods running Claude Code, OpenAI " +
          "Codex, or GitHub Copilot against a configured repository.\n\n" +
          "All routes use Zod schemas via `fastify-type-provider-zod`, so " +
          "every request body, query string, path parameter, and response " +
          "body is validated at runtime and reflected in this spec. Every " +
          "route carries a `summary`, `operationId`, a `tag` that groups it " +
          "in Swagger UI, and at least one schematized response.\n\n" +
          "This document is the contract used by the web UI, the CLI, and " +
          "any client generated via `openapi-typescript`. See " +
          "`apps/api/openapi.generated.json` in the repo for the latest " +
          "build-time snapshot.",
        version: process.env.OPTIO_VERSION ?? "dev",
      },
      servers: [{ url: "/", description: "Current host" }],
      tags: [
        {
          name: "Tasks",
          description:
            "Core task lifecycle: create, list, retrieve, retry, cancel, subtasks, dependencies, bulk operations, comments, and messages.",
        },
        { name: "Workflows", description: "Workflow templates, runs, and triggers." },
        {
          name: "Sessions",
          description:
            "Interactive sessions: persistent workspaces with a terminal and agent chat.",
        },
        { name: "Reviews & PRs", description: "Code review agent, PR review drafts, issue sync." },
        {
          name: "Repos & Integrations",
          description:
            "Repositories, webhooks, MCP servers, skills, prompt templates, shared directories, ticket providers, Slack.",
        },
        { name: "Cluster", description: "Pods, pod health, runtime cluster operations." },
        { name: "Workspaces", description: "Workspaces, memberships, notifications." },
        {
          name: "Auth & Sessions",
          description: "Login, token exchange, GitHub App install, personal access tokens.",
        },
        {
          name: "Setup & Settings",
          description: "Initial setup, global settings, secrets, Optio assistant.",
        },
        { name: "System", description: "Health, internal hooks." },
      ],
      components: {
        securitySchemes: {
          cookieAuth: {
            type: "apiKey",
            in: "cookie",
            name: "optio_session",
            description:
              "HttpOnly session cookie set by the OAuth login flow. Value is " +
              "an opaque session ID validated against the sessions table.",
          },
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "Opaque token",
            description:
              "Authorization: Bearer <token>. Personal Access Tokens are " +
              "prefixed `optio_pat_` and validated against the api_keys " +
              "table; regular session tokens use the same table as cookieAuth " +
              "and are the right choice for CLI / server-to-server access.",
          },
        },
      },
      // Default: every route requires one of the two schemes above.
      // Public routes override per-route with `security: []`.
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    },
    // Hide any route matching these URL patterns — WebSocket upgrades,
    // internal hooks that clients never call, and the swagger UI itself.
    transform: createJsonSchemaTransform({
      skipList: [
        "/docs",
        "/docs/json",
        "/docs/yaml",
        "/docs/static/*",
        "/docs/uiConfig",
        "/docs/initOAuth",
      ],
    }),
    transformObject: createJsonSchemaTransformObject({ schemas: namedSchemas }),
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
    staticCSP: true,
  });

  // REST routes
  await app.register(healthRoutes);
  await app.register(taskRoutes);
  await app.register(secretRoutes);
  await app.register(ticketRoutes);
  await app.register(setupRoutes);
  await app.register(authRoutes);
  await app.register(resumeRoutes);
  await app.register(promptTemplateRoutes);
  await app.register(repoRoutes);
  await app.register(clusterRoutes);
  await app.register(bulkRoutes);
  await app.register(issueRoutes);
  await app.register(prReviewRoutes);
  await app.register(subtaskRoutes);
  await app.register(analyticsRoutes);
  await app.register(webhookRoutes);
  await app.register(sessionRoutes);
  await app.register(commentRoutes);
  await app.register(messageRoutes);
  await app.register(slackRoutes);
  await app.register(workspaceRoutes);
  await app.register(dependencyRoutes);
  await app.register(workflowTriggerRoutes);
  await app.register(mcpServerRoutes);
  await app.register(connectionRoutes);
  await app.register(skillRoutes);
  await app.register(workflowRoutes);
  await app.register(sharedDirectoryRoutes);
  await app.register(notificationRoutes);
  await app.register(optioRoutes);
  await app.register(optioSettingsRoutes);
  await app.register(activityRoutes);
  await app.register(githubAppRoutes);
  await app.register(githubTokenRoutes);
  await app.register(hookRoutes);

  // WebSocket routes
  await app.register(logStreamWs);
  await app.register(eventsWs);
  await app.register(sessionTerminalWs);
  await app.register(sessionChatWs);
  await app.register(optioChatWs);
  await app.register(workflowRunLogStreamWs);

  // Global error handler.
  //
  // Validation errors arrive as type-provider FastifyErrors (FST_ERR_VALIDATION)
  // whose `.validation` array contains entries with `.params.issue` (a ZodIssue).
  //
  // The legacy `ZodError` branch (kept during phases 0–8 of the OpenAPI
  // migration for routes that called `schema.parse(req.body)` inside the
  // handler) was removed in phase 9. Every route now declares its Zod
  // schemas on the route definition, and the type provider handles
  // validation before the handler runs. `server.test.ts`'s "Zod error
  // sanitization" suite still exercises the legacy path because it
  // explicitly mounts a test route that throws `ZodError` from the handler
  // body — a synthetic scenario kept to prove the hand-thrown fallback
  // still works if user code ever throws one.
  //
  // The client-visible `{ error, details }` envelope is:
  //   - dev: `details` is the full JSON of the validation array
  //   - prod: `details` is `"Invalid fields: a, b.c"` — field paths only,
  //     never leaks Zod messages like "Expected string"
  // Contract is locked by tests in `server.test.ts`.
  app.setErrorHandler((error: FastifyError | Error, _req, reply) => {
    const isDev = process.env.NODE_ENV !== "production";

    // Type-provider validation error (FST_ERR_VALIDATION)
    type FpvIssue = { path: (string | number)[] };
    type FpvValidationEntry = {
      instancePath?: string;
      params?: { issue?: FpvIssue; zodError?: unknown };
    };
    const fpvValidation = (error as unknown as { validation?: unknown }).validation as
      | FpvValidationEntry[]
      | undefined;
    const isFpvZodValidation =
      Array.isArray(fpvValidation) && fpvValidation.length > 0 && !!fpvValidation[0]?.params?.issue;

    if (isFpvZodValidation) {
      app.log.error({ err: error }, "Zod schema validation error");
      if (isDev) {
        return reply.status(400).send({
          error: "Validation error",
          details: JSON.stringify(fpvValidation),
        });
      }
      const fields = fpvValidation
        .map((v) => v.params?.issue?.path?.join(".") ?? "")
        .filter(Boolean);
      const details = fields.length
        ? `Invalid fields: ${fields.join(", ")}`
        : "Invalid request body";
      return reply.status(400).send({ error: "Validation error", details });
    }

    // Response-side serializer mismatch (dev-time safety net)
    if (error instanceof ResponseSerializationError) {
      app.log.error({ err: error }, "Response serialization error");
      return reply.status(500).send({ error: "Internal server error" });
    }

    // Fallback for hand-thrown ZodError from user code (e.g. service-layer
    // validation that bypasses the type provider). Not reached by any route
    // handler today — kept so future in-handler `.parse()` calls still
    // produce a sane 400 envelope.
    if (error.name === "ZodError") {
      app.log.error(error, "Hand-thrown Zod validation error");
      if (isDev) {
        return reply.status(400).send({ error: "Validation error", details: error.message });
      }
      const zodError = error as unknown as { issues: Array<{ path: (string | number)[] }> };
      const fields = zodError.issues.map((i) => i.path.join(".")).filter(Boolean);
      const details = fields.length
        ? `Invalid fields: ${fields.join(", ")}`
        : "Invalid request body";
      return reply.status(400).send({ error: "Validation error", details });
    }

    if (error.name === "InvalidTransitionError") {
      return reply.status(409).send({ error: error.message });
    }
    app.log.error(error);
    reply.status(500).send({ error: "Internal server error" });
  });

  return app;
}
