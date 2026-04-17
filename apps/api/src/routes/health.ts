import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import { checkRuntimeHealth } from "../services/container-service.js";
import { sql } from "drizzle-orm";
import { parseIntEnv } from "@optio/shared";
import { isOtelEnabled } from "../telemetry.js";

// Cache runtime health to avoid slow k8s API calls on every health check.
// The UI polls this frequently — a 30s TTL is sufficient.
let cachedRuntimeHealth: boolean | null = null;
let cachedRuntimeHealthAt = 0;
const RUNTIME_HEALTH_TTL_MS = 30_000;

/** Reset cached runtime health (exported for tests). */
export function _resetHealthCache() {
  cachedRuntimeHealth = null;
  cachedRuntimeHealthAt = 0;
}

const HealthResponseSchema = z
  .object({
    healthy: z.boolean(),
    checks: z.record(z.boolean()),
    maxConcurrent: z.number().int(),
    otelEnabled: z.boolean(),
  })
  .describe("API health probe result");

export async function healthRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/health",
    {
      schema: {
        operationId: "getHealth",
        summary: "API liveness / readiness probe",
        description:
          "Check the API's health: database connectivity, container runtime " +
          "health (cached 30s), and configuration (max concurrent tasks, " +
          "OTel state). Only the database check is gated — container runtime " +
          "being down is a degraded state but doesn't fail the probe. This " +
          "endpoint is public (no authentication).",
        tags: ["System"],
        security: [],
        response: {
          200: HealthResponseSchema,
          503: HealthResponseSchema,
        },
      },
    },
    async (_req, reply) => {
      const checks: Record<string, boolean> = {};

      try {
        await db.execute(sql`SELECT 1`);
        checks.database = true;
      } catch {
        checks.database = false;
      }

      if (
        cachedRuntimeHealth !== null &&
        Date.now() - cachedRuntimeHealthAt < RUNTIME_HEALTH_TTL_MS
      ) {
        checks.containerRuntime = cachedRuntimeHealth;
      } else {
        try {
          checks.containerRuntime = await checkRuntimeHealth();
        } catch {
          checks.containerRuntime = false;
        }
        cachedRuntimeHealth = checks.containerRuntime;
        cachedRuntimeHealthAt = Date.now();
      }

      // Only database is critical for API health. Container runtime being
      // unavailable (e.g. no ClusterRole, K8s API unreachable) is a degraded
      // state but should not cause liveness/readiness probes to fail.
      const healthy = checks.database;
      const maxConcurrent = parseIntEnv("OPTIO_MAX_CONCURRENT", 5);
      reply
        .status(healthy ? 200 : 503)
        .send({ healthy, checks, maxConcurrent, otelEnabled: isOtelEnabled() });
    },
  );
}
