import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import {
  CostAnalyticsSchema,
  PerformanceAnalyticsSchema,
  AgentAnalyticsSchema,
  FailureAnalyticsSchema,
  PrAnalyticsSchema,
} from "../schemas/workspace.js";
import {
  getPerformanceAnalytics,
  getAgentAnalytics,
  getFailureAnalytics,
  getPrAnalytics,
} from "../services/analytics-service.js";
import { pgIso } from "../utils/pg-timestamp.js";

// Every row that can carry AI spend, normalised to the `tasks` cost columns so
// the /costs queries below read one source:
//   - `tasks`: Repo Task runs (cluster and local — a local Task's terminal folds
//     its usage into the task row via syncLinkedRun)
//   - `workflow_runs`: Job runs (same folding for local Jobs)
//   - `local_terminals`: ad-hoc / blueprint local sessions that are not linked
//     to a task or run. Linked terminals are excluded so cost is never counted
//     twice. Their working directory stands in for repo_url.
const costRows = sql`(
  SELECT id, title, repo_url, task_type, state::text AS state, cost_usd, model_used,
    input_tokens, output_tokens, created_at, workspace_id
  FROM tasks
  UNION ALL
  SELECT r.id, w.name AS title, 'job:' || w.name AS repo_url, 'job' AS task_type,
    r.state, r.cost_usd, r.model_used, r.input_tokens, r.output_tokens,
    r.created_at, w.workspace_id
  FROM workflow_runs r
  JOIN workflows w ON w.id = r.workflow_id
  UNION ALL
  SELECT id, title, dir AS repo_url, 'local-session' AS task_type,
    CASE
      WHEN state = 'exited' AND exit_code = 0 THEN 'completed'
      WHEN state = 'exited' THEN 'failed'
      ELSE state::text
    END AS state,
    usage->>'costUsd' AS cost_usd,
    usage->>'model' AS model_used,
    (usage->>'inputTokens')::integer AS input_tokens,
    (usage->>'outputTokens')::integer AS output_tokens,
    created_at, workspace_id
  FROM local_terminals
  WHERE task_id IS NULL AND workflow_run_id IS NULL
    AND usage->>'costUsd' IS NOT NULL
) AS tasks`;

const costsQuerySchema = z
  .object({
    days: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .default(30)
      .describe("Lookback window in days (1–365, default 30)"),
    repoUrl: z.string().optional().describe("Optional repo URL filter"),
  })
  .describe("Query parameters for cost analytics");

const performanceQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(365).optional().default(30),
    repoUrl: z.string().optional(),
    agentType: z.string().optional(),
  })
  .describe("Query parameters for performance analytics");

const agentQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(365).optional().default(30),
    repoUrl: z.string().optional(),
  })
  .describe("Query parameters for agent analytics");

const failureQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(365).optional().default(30),
    repoUrl: z.string().optional(),
    agentType: z.string().optional(),
  })
  .describe("Query parameters for failure analytics");

const prQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(365).optional().default(30),
    repoUrl: z.string().optional(),
    agentType: z.string().optional(),
  })
  .describe("Query parameters for PR analytics");

export async function analyticsRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/analytics/costs",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "getCostAnalytics",
        summary: "Get aggregated cost analytics",
        description:
          "Return cost summary, trend, forecast, anomalies, top tasks, and " +
          "model breakdowns for the current workspace. Supports a `days` " +
          "lookback parameter and optional `repoUrl` filter. Requires " +
          "`member` role. This endpoint powers the /costs dashboard.",
        tags: ["Workspaces"],
        querystring: costsQuerySchema,
        response: {
          200: CostAnalyticsSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const days = req.query.days;
      const repoUrl = req.query.repoUrl || null;

      const workspaceId = req.user?.workspaceId || null;

      // Qualified: every query reads ${costRows} (aliased `tasks`), and the
      // anomalies query joins repo_avgs, which has a repo_url of its own.
      const repoFilter = repoUrl ? sql`AND tasks.repo_url = ${repoUrl}` : sql``;
      const wsFilter = workspaceId ? sql`AND workspace_id = ${workspaceId}` : sql``;

      const dateFilter = sql`AND created_at >= NOW() - INTERVAL '1 day' * ${days}`;

      // Total cost and task count
      const [totals] = await db.execute<{
        total_cost: string;
        task_count: string;
        tasks_with_cost: string;
      }>(sql`
      SELECT
        COALESCE(SUM(CAST(cost_usd AS NUMERIC)), 0) AS total_cost,
        COUNT(*) AS task_count,
        COUNT(cost_usd) AS tasks_with_cost
      FROM ${costRows}
      WHERE cost_usd IS NOT NULL
        ${dateFilter}
        ${repoFilter}
        ${wsFilter}
    `);

      // Previous period for trend comparison
      const [prevTotals] = await db.execute<{
        total_cost: string;
      }>(sql`
      SELECT
        COALESCE(SUM(CAST(cost_usd AS NUMERIC)), 0) AS total_cost
      FROM ${costRows}
      WHERE cost_usd IS NOT NULL
        AND created_at >= NOW() - INTERVAL '1 day' * ${days * 2}
        AND created_at < NOW() - INTERVAL '1 day' * ${days}
        ${repoFilter}
        ${wsFilter}
    `);

      // Daily cost over time
      const dailyCosts = await db.execute<{
        date: string;
        cost: string;
        task_count: string;
      }>(sql`
      SELECT
        DATE(created_at) AS date,
        COALESCE(SUM(CAST(cost_usd AS NUMERIC)), 0) AS cost,
        COUNT(*) AS task_count
      FROM ${costRows}
      WHERE cost_usd IS NOT NULL
        ${dateFilter}
        ${repoFilter}
        ${wsFilter}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);

      // Cost by repo
      const costByRepo = await db.execute<{
        repo_url: string;
        total_cost: string;
        task_count: string;
      }>(sql`
      SELECT
        repo_url,
        COALESCE(SUM(CAST(cost_usd AS NUMERIC)), 0) AS total_cost,
        COUNT(*) AS task_count
      FROM ${costRows}
      WHERE cost_usd IS NOT NULL
        ${dateFilter}
        ${repoFilter}
        ${wsFilter}
      GROUP BY repo_url
      ORDER BY total_cost DESC
    `);

      // Cost by task type
      const costByType = await db.execute<{
        task_type: string;
        total_cost: string;
        task_count: string;
      }>(sql`
      SELECT
        task_type,
        COALESCE(SUM(CAST(cost_usd AS NUMERIC)), 0) AS total_cost,
        COUNT(*) AS task_count
      FROM ${costRows}
      WHERE cost_usd IS NOT NULL
        ${dateFilter}
        ${repoFilter}
        ${wsFilter}
      GROUP BY task_type
      ORDER BY total_cost DESC
    `);

      // Cost by model — includes success rate
      const costByModel = await db.execute<{
        model: string;
        total_cost: string;
        task_count: string;
        success_count: string;
        avg_cost: string;
        total_input_tokens: string;
        total_output_tokens: string;
      }>(sql`
      SELECT
        COALESCE(model_used, 'unknown') AS model,
        COALESCE(SUM(CAST(cost_usd AS NUMERIC)), 0) AS total_cost,
        COUNT(*) AS task_count,
        COUNT(*) FILTER (WHERE state IN ('completed', 'pr_opened')) AS success_count,
        COALESCE(AVG(CAST(cost_usd AS NUMERIC)), 0) AS avg_cost,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens
      FROM ${costRows}
      WHERE cost_usd IS NOT NULL
        ${dateFilter}
        ${repoFilter}
        ${wsFilter}
      GROUP BY COALESCE(model_used, 'unknown')
      ORDER BY total_cost DESC
    `);

      // Cost anomalies — tasks costing 3x+ the repo average
      const anomalies = await db.execute<{
        id: string;
        title: string;
        repo_url: string;
        task_type: string;
        state: string;
        cost_usd: string;
        model_used: string;
        repo_avg_cost: string;
        cost_ratio: string;
        created_at: string;
      }>(sql`
      WITH repo_avgs AS (
        SELECT
          repo_url,
          AVG(CAST(cost_usd AS NUMERIC)) AS avg_cost
        FROM ${costRows}
        WHERE cost_usd IS NOT NULL
          ${dateFilter}
          ${wsFilter}
        GROUP BY repo_url
        HAVING COUNT(*) >= 3
      )
      SELECT
        tasks.id,
        tasks.title,
        tasks.repo_url,
        tasks.task_type,
        tasks.state,
        tasks.cost_usd,
        COALESCE(tasks.model_used, 'unknown') AS model_used,
        ra.avg_cost::text AS repo_avg_cost,
        (CAST(tasks.cost_usd AS NUMERIC) / ra.avg_cost)::text AS cost_ratio,
        tasks.created_at::text
      FROM ${costRows}
      JOIN repo_avgs ra ON tasks.repo_url = ra.repo_url
      WHERE tasks.cost_usd IS NOT NULL
        AND CAST(tasks.cost_usd AS NUMERIC) >= ra.avg_cost * 3
        ${dateFilter}
        ${repoFilter}
        ${wsFilter}
      ORDER BY CAST(tasks.cost_usd AS NUMERIC) DESC
      LIMIT 20
    `);

      // Monthly forecast — based on daily average in the period
      const totalCost = parseFloat(totals.total_cost) || 0;
      const tasksWithCost = parseInt(totals.tasks_with_cost) || 0;

      // Calculate daily average spend for forecasting
      const uniqueDays = dailyCosts.length;
      const dailyAvgCost = uniqueDays > 0 ? totalCost / uniqueDays : 0;
      // Days remaining in the current month
      const now = new Date();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const dayOfMonth = now.getDate();
      const daysRemaining = daysInMonth - dayOfMonth;

      // Cost so far this month
      const [monthTotals] = await db.execute<{
        month_cost: string;
        month_tasks: string;
      }>(sql`
      SELECT
        COALESCE(SUM(CAST(cost_usd AS NUMERIC)), 0) AS month_cost,
        COUNT(*) AS month_tasks
      FROM ${costRows}
      WHERE cost_usd IS NOT NULL
        AND created_at >= DATE_TRUNC('month', NOW())
        ${repoFilter}
        ${wsFilter}
    `);
      const monthCostSoFar = parseFloat(monthTotals.month_cost) || 0;
      const forecastedMonthTotal = monthCostSoFar + dailyAvgCost * daysRemaining;

      // Model suggestions — tasks that succeeded with expensive models
      const modelSuggestions = await db.execute<{
        repo_url: string;
        model_used: string;
        task_count: string;
        avg_cost: string;
        cheaper_model_avg: string;
      }>(sql`
      WITH model_stats AS (
        SELECT
          repo_url,
          model_used,
          COUNT(*) AS task_count,
          AVG(CAST(cost_usd AS NUMERIC)) AS avg_cost,
          COUNT(*) FILTER (WHERE state IN ('completed', 'pr_opened')) AS success_count
        FROM ${costRows}
        WHERE cost_usd IS NOT NULL
          AND model_used IS NOT NULL
          ${dateFilter}
          ${repoFilter}
          ${wsFilter}
        GROUP BY repo_url, model_used
        HAVING COUNT(*) >= 2
      )
      SELECT
        ms.repo_url,
        ms.model_used,
        ms.task_count::text,
        ms.avg_cost::text,
        COALESCE(cheaper.avg_cost, 0)::text AS cheaper_model_avg
      FROM model_stats ms
      LEFT JOIN model_stats cheaper ON ms.repo_url = cheaper.repo_url
        AND cheaper.model_used LIKE '%sonnet%'
        AND cheaper.success_count > 0
      WHERE ms.model_used LIKE '%opus%'
        AND ms.success_count > 0
        AND (cheaper.avg_cost IS NULL OR cheaper.avg_cost < ms.avg_cost)
      ORDER BY ms.avg_cost DESC
      LIMIT 10
    `);

      // Top most expensive tasks — with token breakdown
      const topTasks = await db.execute<{
        id: string;
        title: string;
        repo_url: string;
        task_type: string;
        state: string;
        cost_usd: string;
        input_tokens: string;
        output_tokens: string;
        model_used: string;
        created_at: string;
      }>(sql`
      SELECT id, title, repo_url, task_type, state, cost_usd,
        COALESCE(input_tokens, 0)::text AS input_tokens,
        COALESCE(output_tokens, 0)::text AS output_tokens,
        COALESCE(model_used, 'unknown') AS model_used,
        created_at
      FROM ${costRows}
      WHERE cost_usd IS NOT NULL
        ${dateFilter}
        ${repoFilter}
        ${wsFilter}
      ORDER BY CAST(cost_usd AS NUMERIC) DESC
      LIMIT 10
    `);

      const prevCost = parseFloat(prevTotals.total_cost) || 0;
      const taskCount = parseInt(totals.task_count) || 0;
      const avgCost = tasksWithCost > 0 ? totalCost / tasksWithCost : 0;
      const costTrend = prevCost > 0 ? ((totalCost - prevCost) / prevCost) * 100 : 0;

      reply.send({
        summary: {
          totalCost: totalCost.toFixed(4),
          taskCount,
          tasksWithCost,
          avgCost: avgCost.toFixed(4),
          costTrend: costTrend.toFixed(1),
          prevPeriodCost: prevCost.toFixed(4),
          days,
        },
        forecast: {
          dailyAvgCost: dailyAvgCost.toFixed(4),
          monthCostSoFar: monthCostSoFar.toFixed(4),
          forecastedMonthTotal: forecastedMonthTotal.toFixed(4),
          daysRemaining,
        },
        dailyCosts: dailyCosts.map((r) => ({
          date: r.date,
          cost: parseFloat(r.cost) || 0,
          taskCount: parseInt(r.task_count) || 0,
        })),
        costByRepo: costByRepo.map((r) => ({
          repoUrl: r.repo_url,
          totalCost: parseFloat(r.total_cost) || 0,
          taskCount: parseInt(r.task_count) || 0,
        })),
        costByType: costByType.map((r) => ({
          taskType: r.task_type,
          totalCost: parseFloat(r.total_cost) || 0,
          taskCount: parseInt(r.task_count) || 0,
        })),
        costByModel: costByModel.map((r) => {
          const count = parseInt(r.task_count) || 0;
          const successCount = parseInt(r.success_count) || 0;
          return {
            model: r.model,
            totalCost: parseFloat(r.total_cost) || 0,
            taskCount: count,
            successRate: count > 0 ? Math.round((successCount / count) * 100) : 0,
            avgCost: parseFloat(r.avg_cost) || 0,
            totalInputTokens: parseInt(r.total_input_tokens) || 0,
            totalOutputTokens: parseInt(r.total_output_tokens) || 0,
          };
        }),
        anomalies: anomalies.map((r) => ({
          id: r.id,
          title: r.title,
          repoUrl: r.repo_url,
          taskType: r.task_type,
          state: r.state,
          costUsd: r.cost_usd,
          modelUsed: r.model_used,
          repoAvgCost: parseFloat(r.repo_avg_cost) || 0,
          costRatio: parseFloat(r.cost_ratio) || 0,
          createdAt: pgIso(r.created_at),
        })),
        modelSuggestions: modelSuggestions.map((r) => ({
          repoUrl: r.repo_url,
          currentModel: r.model_used,
          taskCount: parseInt(r.task_count) || 0,
          avgCost: parseFloat(r.avg_cost) || 0,
          cheaperModelAvgCost: parseFloat(r.cheaper_model_avg) || 0,
        })),
        topTasks: topTasks.map((r) => ({
          id: r.id,
          title: r.title,
          repoUrl: r.repo_url,
          taskType: r.task_type,
          state: r.state,
          costUsd: r.cost_usd,
          inputTokens: parseInt(r.input_tokens) || 0,
          outputTokens: parseInt(r.output_tokens) || 0,
          modelUsed: r.model_used,
          createdAt: pgIso(r.created_at),
        })),
      });
    },
  );

  // ── Performance Analytics ────────────────────────────────────────────────

  app.get(
    "/api/analytics/performance",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "getPerformanceAnalytics",
        summary: "Get task performance analytics",
        description:
          "Return task duration metrics (avg/p50/p95), success rate with trend, " +
          "and tasks-per-day time series. Filterable by days, repoUrl, agentType.",
        tags: ["Analytics"],
        querystring: performanceQuerySchema,
        response: {
          200: PerformanceAnalyticsSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await getPerformanceAnalytics({
        days: req.query.days,
        repoUrl: req.query.repoUrl || null,
        agentType: req.query.agentType || null,
        workspaceId: req.user?.workspaceId || null,
      });
      reply.send(result);
    },
  );

  // ── Agent Comparison Analytics ───────────────────────────────────────────

  app.get(
    "/api/analytics/agents",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "getAgentAnalytics",
        summary: "Get per-agent-type comparison analytics",
        description:
          "Return task count, success rate, avg duration, avg cost, avg retries, " +
          "and model breakdown for each agent type.",
        tags: ["Analytics"],
        querystring: agentQuerySchema,
        response: {
          200: AgentAnalyticsSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await getAgentAnalytics({
        days: req.query.days,
        repoUrl: req.query.repoUrl || null,
        workspaceId: req.user?.workspaceId || null,
      });
      reply.send(result);
    },
  );

  // ── Failure Analytics ────────────────────────────────────────────────────

  app.get(
    "/api/analytics/failures",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "getFailureAnalytics",
        summary: "Get failure pattern analysis",
        description:
          "Return top error messages, failure rates by repo/agent/model, " +
          "retry success rate, and stall frequency.",
        tags: ["Analytics"],
        querystring: failureQuerySchema,
        response: {
          200: FailureAnalyticsSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await getFailureAnalytics({
        days: req.query.days,
        repoUrl: req.query.repoUrl || null,
        agentType: req.query.agentType || null,
        workspaceId: req.user?.workspaceId || null,
      });
      reply.send(result);
    },
  );

  // ── PR Lifecycle Analytics ───────────────────────────────────────────────

  app.get(
    "/api/analytics/prs",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "getPrAnalytics",
        summary: "Get PR lifecycle metrics",
        description:
          "Return PR open→merge time, CI pass rate, review approval rate, " +
          "auto-merge success rate, and PR lifecycle funnel.",
        tags: ["Analytics"],
        querystring: prQuerySchema,
        response: {
          200: PrAnalyticsSchema,
          400: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const result = await getPrAnalytics({
        days: req.query.days,
        repoUrl: req.query.repoUrl || null,
        agentType: req.query.agentType || null,
        workspaceId: req.user?.workspaceId || null,
      });
      reply.send(result);
    },
  );
}
