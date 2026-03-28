import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";

const costsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
  repoUrl: z.string().optional(),
});

export async function analyticsRoutes(app: FastifyInstance) {
  // Cost analytics — aggregated cost data for the dashboard
  app.get("/api/analytics/costs", async (req, reply) => {
    const query = costsQuerySchema.parse(req.query);
    const days = query.days;
    const repoUrl = query.repoUrl || null;

    const workspaceId = req.user?.workspaceId || null;

    const repoFilter = repoUrl ? sql`AND repo_url = ${repoUrl}` : sql``;
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
      FROM tasks
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
      FROM tasks
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
      FROM tasks
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
      FROM tasks
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
      FROM tasks
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
      FROM tasks
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
        FROM tasks
        WHERE cost_usd IS NOT NULL
          ${dateFilter}
          ${wsFilter}
        GROUP BY repo_url
        HAVING COUNT(*) >= 3
      )
      SELECT
        t.id,
        t.title,
        t.repo_url,
        t.task_type,
        t.state,
        t.cost_usd,
        COALESCE(t.model_used, 'unknown') AS model_used,
        ra.avg_cost::text AS repo_avg_cost,
        (CAST(t.cost_usd AS NUMERIC) / ra.avg_cost)::text AS cost_ratio,
        t.created_at::text
      FROM tasks t
      JOIN repo_avgs ra ON t.repo_url = ra.repo_url
      WHERE t.cost_usd IS NOT NULL
        AND CAST(t.cost_usd AS NUMERIC) >= ra.avg_cost * 3
        ${dateFilter}
        ${repoFilter}
        ${wsFilter}
      ORDER BY CAST(t.cost_usd AS NUMERIC) DESC
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
      FROM tasks
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
        FROM tasks
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
      FROM tasks
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
        createdAt: r.created_at,
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
        createdAt: r.created_at,
      })),
    });
  });
}
