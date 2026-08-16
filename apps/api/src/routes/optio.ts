import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { KubeConfig, CoreV1Api } from "@kubernetes/client-node";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import * as optioActionService from "../services/optio-action-service.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { requireRole } from "../plugins/auth.js";

const NAMESPACE = "optio";
const POD_ROLE_LABEL = "optio.pod-role=optio";

// Cache status to avoid hitting the K8s API on every poll.
let cachedStatus: { ready: boolean; podName: string | null } | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 10_000;

/** @internal Reset the cache — only for tests. */
export function _resetCache(): void {
  cachedStatus = null;
  cachedAt = 0;
}

function getK8sApi(): CoreV1Api {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(CoreV1Api);
}

async function getOptioPodStatus(): Promise<{
  ready: boolean;
  podName: string | null;
}> {
  const now = Date.now();
  if (cachedStatus && now - cachedAt < CACHE_TTL_MS) {
    return cachedStatus;
  }

  try {
    const k8s = getK8sApi();
    const res = await k8s.listNamespacedPod({
      namespace: NAMESPACE,
      labelSelector: POD_ROLE_LABEL,
    });

    const pods = res.items ?? [];
    if (pods.length === 0) {
      cachedStatus = { ready: false, podName: null };
      cachedAt = now;
      return cachedStatus;
    }

    const pod = pods[0];
    const podName = pod.metadata?.name ?? null;
    const phase = pod.status?.phase;
    const conditions = pod.status?.conditions ?? [];
    const readyCondition = conditions.find((c) => c.type === "Ready");
    const ready = phase === "Running" && readyCondition?.status === "True";

    cachedStatus = { ready, podName };
    cachedAt = now;
    return cachedStatus;
  } catch {
    cachedStatus = { ready: false, podName: null };
    cachedAt = now;
    return cachedStatus;
  }
}

/** Response shape for GET /api/optio/system-status */
export interface SystemStatusResponse {
  tasks: {
    running: number;
    queued: number;
    provisioning: number;
    failedToday: number;
    completedToday: number;
    needsAttention: number;
    prOpened: number;
  };
  pods: {
    total: number;
    healthy: number;
    unhealthy: number;
  };
  queueDepth: number;
  costToday: number;
  alerts: Array<{
    type: string;
    message: string;
    timestamp: string;
  }>;
}

const OptioPodStatusResponseSchema = z
  .object({
    ready: z.boolean(),
    podName: z.string().nullable(),
    enabled: z.boolean(),
  })
  .describe("Status of the Optio assistant pod in the cluster");

const SystemStatusResponseSchema = z
  .object({
    tasks: z.object({
      running: z.number().int(),
      queued: z.number().int(),
      provisioning: z.number().int(),
      failedToday: z.number().int(),
      completedToday: z.number().int(),
      needsAttention: z.number().int(),
      prOpened: z.number().int(),
    }),
    pods: z.object({
      total: z.number().int(),
      healthy: z.number().int(),
      unhealthy: z.number().int(),
    }),
    queueDepth: z.number().int(),
    costToday: z.number(),
    alerts: z.array(
      z.object({
        type: z.string(),
        message: z.string(),
        timestamp: z.string(),
      }),
    ),
  })
  .describe("Aggregated system health snapshot for the Optio overview dashboard");

const listActionsQuerySchema = z
  .object({
    userId: z.string().uuid().optional(),
    action: z.string().optional(),
    success: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
    after: z
      .string()
      .datetime()
      .transform((v) => new Date(v))
      .optional(),
    before: z
      .string()
      .datetime()
      .transform((v) => new Date(v))
      .optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .describe("Query parameters for the Optio action audit log");

const OptioActionsResponseSchema = z
  .object({
    actions: z.array(z.unknown()),
    total: z.number().int(),
  })
  .describe("Optio action audit log page");

export async function optioRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/optio/status",
    {
      schema: {
        operationId: "getOptioPodStatus",
        summary: "Get the Optio assistant pod status",
        description:
          "Return whether the optional Optio assistant pod is running and " +
          "ready. If `OPTIO_POD_ENABLED` is false, returns `enabled: false` " +
          "and skips the K8s check.",
        tags: ["Setup & Settings"],
        response: { 200: OptioPodStatusResponseSchema },
      },
    },
    async (_req, reply) => {
      const enabled = process.env.OPTIO_POD_ENABLED === "true";
      if (!enabled) {
        return reply.send({ ready: false, podName: null, enabled: false });
      }

      const status = await getOptioPodStatus();
      return reply.send({ ...status, enabled: true });
    },
  );

  app.get("/api/optio/system-status", {
    schema: {
      operationId: "getSystemStatus",
      summary: "Get aggregated system status",
      description:
        "Return a snapshot of the cluster and task pipeline: task counts " +
        "by state, pod health, queue depth, today's cost, and recent " +
        "alerts. Powers the Optio overview dashboard.",
      tags: ["Setup & Settings"],
      response: {
        200: SystemStatusResponseSchema,
        500: ErrorResponseSchema,
      },
    },
    handler: async (req, reply) => {
      const workspaceId = req.user?.workspaceId || null;
      const wsFilter = workspaceId ? sql`AND workspace_id = ${workspaceId}` : sql``;

      try {
        // Task counts by state
        const taskCounts = await db.execute<{
          state: string;
          count: string;
        }>(sql`
        SELECT state, COUNT(*)::text AS count
        FROM tasks
        WHERE 1=1 ${wsFilter}
          AND state IN ('running', 'queued', 'provisioning', 'needs_attention', 'pr_opened')
        GROUP BY state
      `);

        const taskCountMap: Record<string, number> = {};
        for (const row of taskCounts) {
          taskCountMap[row.state] = parseInt(row.count, 10);
        }

        // Failed and completed today
        const [todayCounts] = await db.execute<{
          failed_today: string;
          completed_today: string;
        }>(sql`
        SELECT
          COUNT(*) FILTER (WHERE state = 'failed' AND updated_at >= CURRENT_DATE)::text AS failed_today,
          COUNT(*) FILTER (WHERE state = 'completed' AND updated_at >= CURRENT_DATE)::text AS completed_today
        FROM tasks
        WHERE 1=1 ${wsFilter}
      `);

        // Pod health from repo_pods table
        const podRows = await db.execute<{
          state: string;
          count: string;
        }>(sql`
        SELECT state, COUNT(*)::text AS count
        FROM repo_pods
        WHERE 1=1
          ${workspaceId ? sql`AND workspace_id = ${workspaceId}` : sql``}
        GROUP BY state
      `);

        let totalPods = 0;
        let healthyPods = 0;
        let unhealthyPods = 0;
        for (const row of podRows) {
          const n = parseInt(row.count, 10);
          totalPods += n;
          if (row.state === "ready") {
            healthyPods += n;
          } else if (row.state === "error") {
            unhealthyPods += n;
          }
        }

        // Queue depth: tasks in queued + provisioning state
        const queueDepth = (taskCountMap["queued"] ?? 0) + (taskCountMap["provisioning"] ?? 0);

        // Cost today
        const [costRow] = await db.execute<{ cost_today: string }>(sql`
        SELECT COALESCE(SUM(CAST(cost_usd AS NUMERIC)), 0)::text AS cost_today
        FROM tasks
        WHERE cost_usd IS NOT NULL
          AND created_at >= CURRENT_DATE
          ${wsFilter}
      `);

        // Recent alerts: OOM kills and crashes in the last 24 hours
        const alertRows = await db.execute<{
          event_type: string;
          message: string;
          created_at: string;
          pod_name: string;
        }>(sql`
        SELECT event_type, message, created_at::text, pod_name
        FROM pod_health_events
        WHERE created_at >= NOW() - INTERVAL '24 hours'
          AND event_type IN ('crashed', 'oom_killed')
        ORDER BY created_at DESC
        LIMIT 10
      `);

        const alerts = alertRows.map((row) => ({
          type: row.event_type,
          message: row.message || `Pod ${row.pod_name} ${row.event_type.replace("_", " ")}`,
          timestamp: row.created_at,
        }));

        const response: SystemStatusResponse = {
          tasks: {
            running: taskCountMap["running"] ?? 0,
            queued: taskCountMap["queued"] ?? 0,
            provisioning: taskCountMap["provisioning"] ?? 0,
            failedToday: parseInt(todayCounts?.failed_today ?? "0", 10),
            completedToday: parseInt(todayCounts?.completed_today ?? "0", 10),
            needsAttention: taskCountMap["needs_attention"] ?? 0,
            prOpened: taskCountMap["pr_opened"] ?? 0,
          },
          pods: {
            total: totalPods,
            healthy: healthyPods,
            unhealthy: unhealthyPods,
          },
          queueDepth,
          costToday: parseFloat(costRow?.cost_today ?? "0"),
          alerts,
        };

        return reply.send(response);
      } catch (err) {
        app.log.error(err, "Failed to fetch system status");
        return reply.status(500).send({ error: "Failed to fetch system status" });
      }
    },
  });

  // ── Optio Action Audit Trail ──────────────────────────────────────────────

  app.get(
    "/api/optio/actions",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "listOptioActions",
        summary: "List Optio action audit log entries",
        description:
          "Return the audit log of assistant actions, with filters on " +
          "user, action type, success, and timestamp range. Used by the " +
          "Optio settings UI to surface what the assistant has done.",
        tags: ["Setup & Settings"],
        querystring: listActionsQuerySchema,
        response: {
          200: OptioActionsResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const { actions, total } = await optioActionService.listActions(req.query);
        return reply.send({ actions, total });
      } catch (err) {
        app.log.error(err, "Failed to fetch optio actions");
        return reply.status(500).send({ error: "Failed to fetch optio actions" });
      }
    },
  );
}
