import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { requireRole } from "../plugins/auth.js";
import { ACTION_PARAM_ALLOWLIST } from "../services/optio-action-service.js";

/** Keep only allowlisted, non-secret keys from an action's stored params. */
function whitelistActionDetails(details: unknown): Record<string, unknown> | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    if (ACTION_PARAM_ALLOWLIST.has(k)) clean[k] = v;
  }
  return clean;
}

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
      // Action details can reveal resource ids and operation history; viewers
      // are read-only observers and must not see the audit trail.
      preHandler: [requireRole("member")],
      schema: {
        operationId: "getActivityFeed",
        summary: "Get unified workspace activity feed",
        description:
          "Merges user actions, task state transitions, auth events, and " +
          "infrastructure events into a single chronologically sorted feed. " +
          "Scoped to the caller's workspace. Auth/infrastructure events (which " +
          "have no tenant column) and legacy null-workspace actions are only " +
          "shown to admins. Supports filtering by type, user, and resource type.",
        tags: ["System"],
        querystring: activityQuerySchema,
        response: {
          200: ActivityResponseSchema,
          403: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const { days, type, userId, resourceType, limit, offset } = req.query;
      const since = new Date(Date.now() - days * 86_400_000).toISOString();

      // Workspace scoping. Auth-disabled dev mode leaves req.user undefined —
      // treat that as an operator with a full, unscoped view (local dev only).
      const wsId = req.user?.workspaceId ?? null;
      const isOperator = !req.user;
      const isAdmin = isOperator || req.user?.workspaceRole === "admin";

      // Restrict a tenant-scoped source (`col`) to the caller's workspace.
      // Admins additionally see legacy/operator rows with a null workspace;
      // members see strictly their own workspace. Operators (auth disabled)
      // get no filter at all.
      const scopeTo = (col: SQL): SQL | null => {
        if (isOperator) return null;
        return isAdmin ? sql`(${col} = ${wsId} OR ${col} IS NULL)` : sql`${col} = ${wsId}`;
      };

      try {
        // Build individual sub-selects for each event source, applying filters.
        const parts: SQL[] = [];
        const typeFilters = type ? [type] : ["action", "task_event", "auth_event", "infra_event"];

        if (typeFilters.includes("action")) {
          const conds: SQL[] = [sql`oa.created_at >= ${since}`];
          const wsCond = scopeTo(sql`oa.workspace_id`);
          if (wsCond) conds.push(wsCond);
          if (userId) conds.push(sql`oa.user_id = ${userId}`);
          if (resourceType) conds.push(sql`split_part(oa.action, '.', 1) = ${resourceType}`);
          parts.push(sql`
            SELECT
              oa.id::text AS id,
              'action' AS type,
              oa.created_at AS timestamp,
              oa.user_id AS user_id,
              u.display_name AS user_display_name,
              u.avatar_url AS user_avatar_url,
              oa.action AS action,
              split_part(oa.action, '.', 1) AS resource_type,
              COALESCE(oa.params->>'id', oa.params->>'taskId', oa.params->>'repoId') AS resource_id,
              oa.action || ' ' || CASE WHEN oa.success THEN 'succeeded' ELSE 'failed' END AS summary,
              oa.params AS details
            FROM optio_actions oa
            LEFT JOIN users u ON oa.user_id = u.id
            WHERE ${sql.join(conds, sql` AND `)}
          `);
        }

        // task_events are always about tasks; skip when filtering other types.
        if (typeFilters.includes("task_event") && (!resourceType || resourceType === "task")) {
          const conds: SQL[] = [sql`te.created_at >= ${since}`];
          const wsCond = scopeTo(sql`t.workspace_id`);
          if (wsCond) conds.push(wsCond);
          if (userId) conds.push(sql`te.user_id = ${userId}`);
          parts.push(sql`
            SELECT
              te.id::text AS id,
              'task_event' AS type,
              te.created_at AS timestamp,
              te.user_id AS user_id,
              u.display_name AS user_display_name,
              u.avatar_url AS user_avatar_url,
              'task:' || COALESCE(te.from_state, 'new') || '→' || te.to_state AS action,
              'task' AS resource_type,
              te.task_id::text AS resource_id,
              'Task transitioned to ' || te.to_state || ' via ' || te.trigger AS summary,
              jsonb_build_object('fromState', te.from_state, 'toState', te.to_state, 'trigger', te.trigger) AS details
            FROM task_events te
            JOIN tasks t ON te.task_id = t.id
            LEFT JOIN users u ON te.user_id = u.id
            WHERE ${sql.join(conds, sql` AND `)}
          `);
        }

        // auth_events and pod_health_events have no tenant column — they are
        // deployment-global. Only admins (and dev operators) may see them.
        if (typeFilters.includes("auth_event") && !resourceType && !userId && isAdmin) {
          parts.push(sql`
            SELECT
              ae.id::text AS id,
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
            WHERE ae.created_at >= ${since}
          `);
        }

        if (typeFilters.includes("infra_event") && !resourceType && !userId && isAdmin) {
          parts.push(sql`
            SELECT
              phe.id::text AS id,
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
            WHERE phe.created_at >= ${since}
          `);
        }

        if (parts.length === 0) {
          return reply.send({
            items: [],
            total: 0,
            stats: { actions: 0, taskEvents: 0, authEvents: 0, infraEvents: 0 },
          });
        }

        const unionQuery = sql.join(parts, sql` UNION ALL `);

        // Get paginated results
        const [rows, countRows, statsRows] = await Promise.all([
          db.execute(sql`
            SELECT * FROM (${unionQuery}) AS activity
            ORDER BY timestamp DESC
            LIMIT ${limit} OFFSET ${offset}
          `),
          db.execute(sql`
            SELECT count(*)::int AS total FROM (${unionQuery}) AS activity
          `),
          db.execute(sql`
            SELECT type, count(*)::int AS cnt FROM (${unionQuery}) AS activity GROUP BY type
          `),
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
          // Action rows carry user-supplied params — reduce to the non-secret
          // allowlist so legacy rows (written before write-time filtering)
          // can't leak their full jsonb. Other sources build fixed, safe
          // detail objects and pass through unchanged.
          details:
            row.type === "action" ? whitelistActionDetails(row.details) : (row.details ?? null),
        }));

        reply.send({ items, total, stats });
      } catch (err) {
        rawApp.log.error(err, "Failed to fetch activity feed");
        return reply.status(500).send({ error: "Failed to fetch activity feed" });
      }
    },
  );
}
