import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

const activityQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(90).default(7).describe("Lookback window in days"),
    type: z
      .enum(["action", "task_event", "auth_event", "infra_event"])
      .optional()
      .describe("Filter by event type"),
    userId: z.string().uuid().optional().describe("Filter by actor user ID"),
    resourceType: z
      .enum([
        "task",
        "repo",
        "workflow",
        "connection",
        "secret",
        "webhook",
        "session",
        "mcp_server",
        "settings",
      ])
      .optional()
      .describe("Filter by resource type"),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .describe("Query parameters for the unified activity feed");

const ActivityItemSchema = z.object({
  id: z.string(),
  type: z.enum(["action", "task_event", "auth_event", "infra_event"]),
  timestamp: z.string(),
  actor: z
    .object({
      id: z.string(),
      displayName: z.string(),
      avatarUrl: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable().optional(),
  summary: z.string(),
  details: z.record(z.unknown()).nullable().optional(),
});

const ActivityResponseSchema = z
  .object({
    items: z.array(ActivityItemSchema),
    total: z.number().int(),
    stats: z.object({
      actions: z.number().int(),
      taskEvents: z.number().int(),
      authEvents: z.number().int(),
      infraEvents: z.number().int(),
    }),
  })
  .describe("Unified activity feed response");

export async function activityRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/activity",
    {
      schema: {
        operationId: "getActivityFeed",
        summary: "Get unified workspace activity feed",
        description:
          "Merges user actions, task state transitions, auth events, and " +
          "infrastructure events into a single chronologically sorted feed. " +
          "Supports filtering by type, user, and resource type.",
        tags: ["System"],
        querystring: activityQuerySchema,
        response: {
          200: ActivityResponseSchema,
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const { days, type, userId, resourceType, limit, offset } = req.query;
      const since = new Date(Date.now() - days * 86_400_000).toISOString();

      try {
        // Build individual CTEs for each event source, applying filters
        const parts: string[] = [];
        const typeFilters = type ? [type] : ["action", "task_event", "auth_event", "infra_event"];

        if (typeFilters.includes("action")) {
          const actionWhere = [`oa.created_at >= '${since}'`];
          if (userId) actionWhere.push(`oa.user_id = '${userId}'`);
          if (resourceType) actionWhere.push(`split_part(oa.action, '.', 1) = '${resourceType}'`);
          parts.push(`
            SELECT
              oa.id::text,
              'action' AS type,
              oa.created_at AS timestamp,
              oa.user_id,
              u.display_name AS user_display_name,
              u.avatar_url AS user_avatar_url,
              oa.action,
              split_part(oa.action, '.', 1) AS resource_type,
              COALESCE((oa.params->>'id')::text, (oa.params->>'taskId')::text, (oa.params->>'repoId')::text) AS resource_id,
              oa.action || ' ' || CASE WHEN oa.success THEN 'succeeded' ELSE 'failed' END AS summary,
              oa.params AS details
            FROM optio_actions oa
            LEFT JOIN users u ON oa.user_id = u.id
            WHERE ${actionWhere.join(" AND ")}
          `);
        }

        if (typeFilters.includes("task_event")) {
          const teWhere = [`te.created_at >= '${since}'`];
          if (userId) teWhere.push(`te.user_id = '${userId}'`);
          if (resourceType && resourceType !== "task") {
            // task_events are always about tasks, skip if filtering for other types
          } else {
            parts.push(`
              SELECT
                te.id::text,
                'task_event' AS type,
                te.created_at AS timestamp,
                te.user_id,
                u.display_name AS user_display_name,
                u.avatar_url AS user_avatar_url,
                'task:' || COALESCE(te.from_state, 'new') || '→' || te.to_state AS action,
                'task' AS resource_type,
                te.task_id::text AS resource_id,
                'Task transitioned to ' || te.to_state || ' via ' || te.trigger AS summary,
                jsonb_build_object('fromState', te.from_state, 'toState', te.to_state, 'trigger', te.trigger) AS details
              FROM task_events te
              LEFT JOIN users u ON te.user_id = u.id
              WHERE ${teWhere.join(" AND ")}
            `);
          }
        }

        if (typeFilters.includes("auth_event") && !resourceType) {
          const aeWhere = [`ae.created_at >= '${since}'`];
          // auth_events have no userId, skip if filtering by user
          if (!userId) {
            parts.push(`
              SELECT
                ae.id::text,
                'auth_event' AS type,
                ae.created_at AS timestamp,
                NULL::uuid AS user_id,
                NULL AS user_display_name,
                NULL AS user_avatar_url,
                'auth:' || ae.token_type || '_failed' AS action,
                'auth' AS resource_type,
                NULL AS resource_id,
                ae.token_type || ' auth failed: ' || ae.error_message AS summary,
                jsonb_build_object('tokenType', ae.token_type, 'error', ae.error_message) AS details
              FROM auth_events ae
              WHERE ${aeWhere.join(" AND ")}
            `);
          }
        }

        if (typeFilters.includes("infra_event") && !resourceType) {
          const ieWhere = [`phe.created_at >= '${since}'`];
          if (!userId) {
            parts.push(`
              SELECT
                phe.id::text,
                'infra_event' AS type,
                phe.created_at AS timestamp,
                NULL::uuid AS user_id,
                NULL AS user_display_name,
                NULL AS user_avatar_url,
                'pod:' || phe.event_type AS action,
                'pod' AS resource_type,
                phe.repo_pod_id::text AS resource_id,
                'Pod ' || COALESCE(phe.pod_name, 'unknown') || ' ' || phe.event_type AS summary,
                jsonb_build_object('eventType', phe.event_type, 'podName', phe.pod_name, 'message', phe.message) AS details
              FROM pod_health_events phe
              WHERE ${ieWhere.join(" AND ")}
            `);
          }
        }

        if (parts.length === 0) {
          return reply.send({
            items: [],
            total: 0,
            stats: { actions: 0, taskEvents: 0, authEvents: 0, infraEvents: 0 },
          });
        }

        const unionQuery = parts.join(" UNION ALL ");

        // Get paginated results
        const [rows, countRows, statsRows] = await Promise.all([
          db.execute(
            sql.raw(`
            SELECT * FROM (${unionQuery}) AS activity
            ORDER BY timestamp DESC
            LIMIT ${limit} OFFSET ${offset}
          `),
          ),
          db.execute(
            sql.raw(`
            SELECT count(*)::int AS total FROM (${unionQuery}) AS activity
          `),
          ),
          db.execute(
            sql.raw(`
            SELECT type, count(*)::int AS cnt FROM (${unionQuery}) AS activity GROUP BY type
          `),
          ),
        ]);

        const total = (countRows[0] as any)?.total ?? 0;

        const stats = { actions: 0, taskEvents: 0, authEvents: 0, infraEvents: 0 };
        for (const row of statsRows as any[]) {
          if (row.type === "action") stats.actions = row.cnt;
          if (row.type === "task_event") stats.taskEvents = row.cnt;
          if (row.type === "auth_event") stats.authEvents = row.cnt;
          if (row.type === "infra_event") stats.infraEvents = row.cnt;
        }

        const items = (rows as any[]).map((row) => ({
          id: row.id,
          type: row.type as "action" | "task_event" | "auth_event" | "infra_event",
          timestamp: new Date(row.timestamp).toISOString(),
          actor: row.user_id
            ? {
                id: row.user_id,
                displayName: row.user_display_name ?? "Unknown",
                avatarUrl: row.user_avatar_url ?? null,
              }
            : null,
          action: row.action,
          resourceType: row.resource_type,
          resourceId: row.resource_id ?? null,
          summary: row.summary,
          details: row.details ?? null,
        }));

        reply.send({ items, total, stats });
      } catch (err) {
        rawApp.log.error(err, "Failed to fetch activity feed");
        return reply.status(500).send({ error: "Failed to fetch activity feed" });
      }
    },
  );
}
