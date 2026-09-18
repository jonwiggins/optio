import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";

/**
 * One feed of recent agent work across every kind of run — repo tasks,
 * job (workflow) runs, and persistent-agent turns — newest first. The
 * overview's "Recent" panel is built on this instead of tasks alone.
 */

const RecentRunSchema = z.object({
  id: z.string(),
  kind: z.enum(["task", "job-run", "agent-turn"]),
  /** Task title, workflow name, or agent name. */
  title: z.string(),
  /** Lifecycle state in the source table's vocabulary. */
  state: z.string(),
  /** Repo (tasks), workflow id (job runs), agent id (turns) — for the link. */
  parentId: z.string().nullable(),
  /** Route the row should open. */
  href: z.string(),
  /** Where it ran: repo path for tasks; null otherwise. */
  where: z.string().nullable(),
  /** Short extra line: agent turn summary / error message. */
  detail: z.string().nullable(),
  agentType: z.string().nullable(),
  costUsd: z.string().nullable(),
  /** The "last touched" instant the feed sorts on. */
  at: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});

export type RecentRun = z.infer<typeof RecentRunSchema>;

export async function recentRunsRoutes(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/runs/recent",
    {
      schema: {
        operationId: "listRecentRuns",
        summary: "Recent agent runs across tasks, jobs, and persistent agents",
        description:
          "Newest-first union of repo tasks, job (workflow) runs, and persistent-agent turns, " +
          "scoped to the caller's workspace. Powers the overview's Recent panel.",
        tags: ["Analytics"],
        querystring: z.object({
          limit: z.coerce.number().int().min(1).max(50).default(12),
        }),
        response: {
          200: z.object({ runs: z.array(RecentRunSchema) }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const { limit } = req.query;
      const wsId = req.user?.workspaceId ?? null;
      const isOperator = !req.user;
      const isAdmin = isOperator || req.user?.workspaceRole === "admin";
      // Same scoping rule as the activity feed: operators (auth disabled) see
      // all; admins also see legacy null-workspace rows; members only theirs.
      const scopeTo = (col: SQL): SQL => {
        if (isOperator) return sql`TRUE`;
        return isAdmin ? sql`(${col} = ${wsId} OR ${col} IS NULL)` : sql`${col} = ${wsId}`;
      };

      try {
        const query = sql`
          SELECT * FROM (
            SELECT
              t.id::text AS id,
              'task' AS kind,
              t.title AS title,
              t.state::text AS state,
              t.repo_url AS parent_id,
              t.repo_url AS "where",
              t.error_message AS detail,
              t.agent_type AS agent_type,
              t.cost_usd AS cost_usd,
              t.updated_at AS at,
              t.started_at AS started_at,
              t.completed_at AS ended_at
            FROM tasks t
            WHERE ${scopeTo(sql`t.workspace_id`)}
              AND t.parent_task_id IS NULL
            ORDER BY t.updated_at DESC
            LIMIT ${limit}
          ) tasks_part
          UNION ALL
          SELECT * FROM (
            SELECT
              r.id::text AS id,
              'job-run' AS kind,
              w.name AS title,
              r.state AS state,
              w.id::text AS parent_id,
              NULL AS "where",
              r.error_message AS detail,
              w.agent_runtime AS agent_type,
              r.cost_usd AS cost_usd,
              r.updated_at AS at,
              r.started_at AS started_at,
              r.finished_at AS ended_at
            FROM workflow_runs r
            JOIN workflows w ON w.id = r.workflow_id
            WHERE ${scopeTo(sql`w.workspace_id`)}
            ORDER BY r.updated_at DESC
            LIMIT ${limit}
          ) runs_part
          UNION ALL
          SELECT * FROM (
            SELECT
              tr.id::text AS id,
              'agent-turn' AS kind,
              a.name AS title,
              CASE
                WHEN tr.finished_at IS NULL THEN 'running'
                WHEN tr.error_message IS NOT NULL THEN 'failed'
                ELSE 'completed'
              END AS state,
              a.id::text AS parent_id,
              NULL AS "where",
              COALESCE(tr.summary, tr.error_message) AS detail,
              a.agent_runtime AS agent_type,
              tr.cost_usd AS cost_usd,
              COALESCE(tr.finished_at, tr.started_at, tr.created_at) AS at,
              tr.started_at AS started_at,
              tr.finished_at AS ended_at
            FROM persistent_agent_turns tr
            JOIN persistent_agents a ON a.id = tr.agent_id
            WHERE ${scopeTo(sql`a.workspace_id`)}
            ORDER BY COALESCE(tr.finished_at, tr.started_at, tr.created_at) DESC
            LIMIT ${limit}
          ) turns_part
          ORDER BY at DESC
          LIMIT ${limit}
        `;
        const result = await db.execute(query);
        const rows = (result as unknown as { rows?: any[] }).rows ?? (result as unknown as any[]);
        // Raw SQL hands timestamps back as Postgres text ("2026-06-15 04:35:33+00"),
        // which Safari's Date won't parse — normalize to ISO.
        const iso = (v: unknown) => {
          if (v instanceof Date) return v.toISOString();
          if (typeof v !== "string") return null;
          const t = Date.parse(v.replace(" ", "T").replace(/\+00$/, "Z"));
          return isNaN(t) ? null : new Date(t).toISOString();
        };
        const runs: RecentRun[] = rows.map((r: any) => {
          const kind = r.kind as RecentRun["kind"];
          const href =
            kind === "task"
              ? `/tasks/${r.id}`
              : kind === "job-run"
                ? `/jobs/${r.parent_id}/runs/${r.id}`
                : `/agents/${r.parent_id}`;
          return {
            id: r.id,
            kind,
            title: r.title ?? "",
            state: r.state ?? "",
            parentId: r.parent_id ?? null,
            href,
            where:
              kind === "task" && typeof r.where === "string"
                ? r.where.replace(/^https?:\/\/[^/]+\//, "")
                : null,
            detail: typeof r.detail === "string" && r.detail ? r.detail.slice(0, 200) : null,
            agentType: r.agent_type ?? null,
            costUsd: r.cost_usd ?? null,
            at: iso(r.at) ?? new Date().toISOString(),
            startedAt: iso(r.started_at),
            endedAt: iso(r.ended_at),
          };
        });
        return reply.send({ runs });
      } catch (err) {
        req.log.error({ err }, "recent runs query failed");
        return reply.status(500).send({ error: "Failed to load recent runs" });
      }
    },
  );
}
