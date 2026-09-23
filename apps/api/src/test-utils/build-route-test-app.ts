/**
 * Shared Fastify test harness for route-level tests.
 *
 * Many route tests (`*.test.ts` files under `src/routes/`) historically
 * built a one-off Fastify instance with no validator compiler wired up,
 * relying on the route handlers to do their own `safeParse`/`.parse()`
 * calls. As routes migrate to the Zod type provider (see
 * `apps/api/src/server.ts`), those tests need an app that:
 *
 *   1. Uses the type-provider's validatorCompiler and serializerCompiler
 *      so Zod schemas attached via `schema: { body|querystring|params }`
 *      actually validate the request.
 *   2. Runs the same error handler as production so the `{ error, details }`
 *      envelope contract stays identical between tests and live traffic.
 *   3. Decorates `req.user` with a default test user so handlers don't
 *      have to deal with auth-disabled state.
 *
 * Usage:
 *
 *   import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
 *   import { taskRoutes } from "./tasks.js";
 *
 *   const app = await buildRouteTestApp(taskRoutes);
 *   // ... app.inject(...) as usual
 */
import Fastify from "fastify";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  validatorCompiler,
  serializerCompiler,
  ResponseSerializationError,
} from "fastify-type-provider-zod";

export const DEFAULT_TEST_USER = {
  id: "user-1",
  workspaceId: "ws-1",
  workspaceRole: "admin" as const,
};

type TestUser = {
  id: string;
  workspaceId: string | null;
  workspaceRole: "admin" | "member" | "viewer";
};

type RouteRegistrar = (app: FastifyInstance) => unknown | Promise<unknown>;

export interface BuildRouteTestAppOptions {
  /** Override the default test user (or pass `null` to simulate unauthenticated). */
  user?: TestUser | null;
  /** Enable request logging (default: false). */
  logger?: boolean;
}

/**
 * Mirror of the production error handler in `apps/api/src/server.ts`. Keep
 * these in sync — if you change one, change the other. A centralized
 * factory is the right long-term home for this handler; for now the
 * duplication is explicit and tested.
 */
function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, _req, reply: FastifyReply) => {
    const isDev = process.env.NODE_ENV !== "production";

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

    if (error instanceof ResponseSerializationError) {
      return reply.status(500).send({ error: "Internal server error" });
    }

    if (error.name === "ZodError") {
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
    reply.status(500).send({ error: "Internal server error" });
  });
}

export async function buildRouteTestApp(
  register: RouteRegistrar,
  options: BuildRouteTestAppOptions = {},
): Promise<FastifyInstance> {
  // Same router options as the production server (server.ts `buildServer`).
  const app = Fastify({
    logger: options.logger ?? false,
    routerOptions: { maxParamLength: 1024 },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  installErrorHandler(app);

  // Mirror the auth plugin's decorator so handlers can read req.user
  app.decorateRequest("user", undefined);
  const user = options.user === undefined ? DEFAULT_TEST_USER : options.user;
  app.addHook("preHandler", (req: FastifyRequest, _reply, done) => {
    (req as unknown as { user: TestUser | null }).user = user;
    done();
  });

  await register(app);
  await app.ready();
  return app;
}
