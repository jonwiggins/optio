import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { requireRole } from "../plugins/auth.js";

/**
 * Optio system routes — aggregate health and tool-related endpoints.
 */
export async function optioRoutes(app: FastifyInstance) {
  /**
   * GET /api/optio/system-status
   *
   * Returns an aggregate system health summary suitable for injection into
   * an agent's system prompt as ambient context.
   */
  app.get("/api/optio/system-status", { preHandler: [requireRole("viewer")] }, async (req) => {
    const workspaceId = req.user?.workspaceId || null;
    const wsFilter = workspaceId ? sql`AND workspace_id = ${workspaceId}` : sql``;

    // ── Task counts by state ──────────────────────────────────────────
    const tasksByState = await db.execute<{
      state: string;
      count: string;
    }>(sql`
      SELECT state, COUNT(*)::text AS count
      FROM tasks
      WHERE 1=1 ${wsFilter}
      GROUP BY state
    `);

    const stateMap: Record<string, number> = {};
    for (const row of tasksByState) {
      stateMap[row.state] = parseInt(row.count, 10) || 0;
    }

    // ── Failed today & completed today ────────────────────────────────
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

    // ── Queue depth (pending + queued + waiting_on_deps) ──────────────
    const queueDepth =
      (stateMap["pending"] ?? 0) + (stateMap["queued"] ?? 0) + (stateMap["waiting_on_deps"] ?? 0);

    // ── Pod health summary ────────────────────────────────────────────
    const podSummary = await db.execute<{
      total: string;
      ready: string;
      error: string;
      provisioning: string;
    }>(sql`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE state = 'ready')::text AS ready,
        COUNT(*) FILTER (WHERE state = 'error')::text AS error,
        COUNT(*) FILTER (WHERE state = 'provisioning')::text AS provisioning
      FROM repo_pods
      WHERE 1=1 ${wsFilter}
    `);

    const podStats = podSummary[0] ?? { total: "0", ready: "0", error: "0", provisioning: "0" };

    // ── Cost today ────────────────────────────────────────────────────
    const [costToday] = await db.execute<{ cost: string }>(sql`
      SELECT COALESCE(SUM(CAST(cost_usd AS NUMERIC)), 0)::text AS cost
      FROM tasks
      WHERE cost_usd IS NOT NULL
        AND created_at >= CURRENT_DATE
        ${wsFilter}
    `);

    // ── Active alerts ─────────────────────────────────────────────────
    // Recent OOM kills and crashes in the last hour
    const recentHealthEvents = await db.execute<{
      event_type: string;
      pod_name: string;
      message: string;
      created_at: string;
    }>(sql`
      SELECT event_type, pod_name, message, created_at::text
      FROM pod_health_events
      WHERE event_type IN ('crashed', 'oom_killed')
        AND created_at >= NOW() - INTERVAL '1 hour'
      ORDER BY created_at DESC
      LIMIT 10
    `);

    // Recent auth errors from failed tasks in the last hour
    const recentAuthErrors = await db.execute<{
      id: string;
      title: string;
      error_message: string;
    }>(sql`
      SELECT id, title, error_message
      FROM tasks
      WHERE state = 'failed'
        AND error_message ILIKE '%auth%'
        AND updated_at >= NOW() - INTERVAL '1 hour'
        ${wsFilter}
      LIMIT 5
    `);

    const alerts: Array<{ type: string; message: string; timestamp?: string }> = [];

    for (const event of recentHealthEvents) {
      alerts.push({
        type: event.event_type,
        message: `Pod ${event.pod_name}: ${event.message ?? event.event_type}`,
        timestamp: event.created_at,
      });
    }

    for (const task of recentAuthErrors) {
      alerts.push({
        type: "auth_error",
        message: `Task "${task.title}" (${task.id}): ${task.error_message}`,
      });
    }

    return {
      tasks: {
        running: stateMap["running"] ?? 0,
        provisioning: stateMap["provisioning"] ?? 0,
        queued: stateMap["queued"] ?? 0,
        pending: stateMap["pending"] ?? 0,
        waitingOnDeps: stateMap["waiting_on_deps"] ?? 0,
        needsAttention: stateMap["needs_attention"] ?? 0,
        prOpened: stateMap["pr_opened"] ?? 0,
        failedToday: parseInt(todayCounts?.failed_today ?? "0", 10),
        completedToday: parseInt(todayCounts?.completed_today ?? "0", 10),
      },
      pods: {
        total: parseInt(podStats.total, 10),
        ready: parseInt(podStats.ready, 10),
        error: parseInt(podStats.error, 10),
        provisioning: parseInt(podStats.provisioning, 10),
      },
      queueDepth,
      costToday: costToday?.cost ?? "0",
      alerts,
    };
  });
}
