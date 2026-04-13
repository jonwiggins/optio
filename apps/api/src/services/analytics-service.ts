import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export interface AnalyticsFilters {
  days: number;
  repoUrl?: string | null;
  agentType?: string | null;
  workspaceId?: string | null;
}

function buildFilters(filters: AnalyticsFilters) {
  const dateFilter = sql`AND created_at >= NOW() - INTERVAL '1 day' * ${filters.days}`;
  const repoFilter = filters.repoUrl ? sql`AND repo_url = ${filters.repoUrl}` : sql``;
  const agentFilter = filters.agentType ? sql`AND agent_type = ${filters.agentType}` : sql``;
  const wsFilter = filters.workspaceId ? sql`AND workspace_id = ${filters.workspaceId}` : sql``;
  return { dateFilter, repoFilter, agentFilter, wsFilter };
}

function prevDateFilter(days: number) {
  return sql`AND created_at >= NOW() - INTERVAL '1 day' * ${days * 2}
             AND created_at < NOW() - INTERVAL '1 day' * ${days}`;
}

// ── Performance Analytics ────────────────────────────────────────────────────

export async function getPerformanceAnalytics(filters: AnalyticsFilters) {
  const { dateFilter, repoFilter, agentFilter, wsFilter } = buildFilters(filters);

  // Duration metrics (only completed tasks with both timestamps)
  const [durations] = await db.execute<{
    avg_wall_clock: string;
    p50_wall_clock: string;
    p95_wall_clock: string;
    avg_execution: string;
    p50_execution: string;
    p95_execution: string;
    avg_queue_wait: string;
    task_count: string;
  }>(sql`
    SELECT
      COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - created_at))), 0) AS avg_wall_clock,
      COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at))), 0) AS p50_wall_clock,
      COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at))), 0) AS p95_wall_clock,
      COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - started_at))), 0) AS avg_execution,
      COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at))), 0) AS p50_execution,
      COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at))), 0) AS p95_execution,
      COALESCE(AVG(EXTRACT(EPOCH FROM (started_at - created_at))), 0) AS avg_queue_wait,
      COUNT(*) AS task_count
    FROM tasks
    WHERE state IN ('completed', 'pr_opened')
      AND completed_at IS NOT NULL
      AND started_at IS NOT NULL
      ${dateFilter}
      ${repoFilter}
      ${agentFilter}
      ${wsFilter}
  `);

  // Success rate
  const [rates] = await db.execute<{
    total: string;
    succeeded: string;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE state NOT IN ('cancelled')) AS total,
      COUNT(*) FILTER (WHERE state IN ('completed', 'pr_opened')) AS succeeded
    FROM tasks
    WHERE 1=1
      ${dateFilter}
      ${repoFilter}
      ${agentFilter}
      ${wsFilter}
  `);

  // Previous period success rate for trend
  const prevFilter = prevDateFilter(filters.days);
  const [prevRates] = await db.execute<{
    total: string;
    succeeded: string;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE state NOT IN ('cancelled')) AS total,
      COUNT(*) FILTER (WHERE state IN ('completed', 'pr_opened')) AS succeeded
    FROM tasks
    WHERE 1=1
      ${prevFilter}
      ${repoFilter}
      ${agentFilter}
      ${wsFilter}
  `);

  // Tasks per day
  const tasksPerDay = await db.execute<{
    date: string;
    total: string;
    succeeded: string;
    failed: string;
  }>(sql`
    SELECT
      DATE(created_at) AS date,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE state IN ('completed', 'pr_opened')) AS succeeded,
      COUNT(*) FILTER (WHERE state = 'failed') AS failed
    FROM tasks
    WHERE 1=1
      ${dateFilter}
      ${repoFilter}
      ${agentFilter}
      ${wsFilter}
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `);

  const total = parseInt(rates.total) || 0;
  const succeeded = parseInt(rates.succeeded) || 0;
  const successRate = total > 0 ? Math.round((succeeded / total) * 100) : 0;

  const prevTotal = parseInt(prevRates.total) || 0;
  const prevSucceeded = parseInt(prevRates.succeeded) || 0;
  const prevSuccessRate = prevTotal > 0 ? Math.round((prevSucceeded / prevTotal) * 100) : 0;
  const successRateTrend = prevSuccessRate > 0 ? successRate - prevSuccessRate : 0;

  return {
    durations: {
      avgWallClock: Math.round(parseFloat(durations.avg_wall_clock) || 0),
      p50WallClock: Math.round(parseFloat(durations.p50_wall_clock) || 0),
      p95WallClock: Math.round(parseFloat(durations.p95_wall_clock) || 0),
      avgExecution: Math.round(parseFloat(durations.avg_execution) || 0),
      p50Execution: Math.round(parseFloat(durations.p50_execution) || 0),
      p95Execution: Math.round(parseFloat(durations.p95_execution) || 0),
      avgQueueWait: Math.round(parseFloat(durations.avg_queue_wait) || 0),
      taskCount: parseInt(durations.task_count) || 0,
    },
    successRate,
    successRateTrend,
    tasksPerDay: tasksPerDay.map((r) => ({
      date: r.date,
      total: parseInt(r.total) || 0,
      succeeded: parseInt(r.succeeded) || 0,
      failed: parseInt(r.failed) || 0,
    })),
  };
}

// ── Agent Comparison Analytics ───────────────────────────────────────────────

export async function getAgentAnalytics(filters: Omit<AnalyticsFilters, "agentType">) {
  const { dateFilter, repoFilter, wsFilter } = buildFilters({ ...filters, agentType: null });

  const agents = await db.execute<{
    agent_type: string;
    task_count: string;
    succeeded: string;
    avg_duration: string;
    avg_cost: string;
    avg_retries: string;
  }>(sql`
    SELECT
      agent_type,
      COUNT(*) AS task_count,
      COUNT(*) FILTER (WHERE state IN ('completed', 'pr_opened')) AS succeeded,
      COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL), 0) AS avg_duration,
      COALESCE(AVG(CAST(cost_usd AS NUMERIC)) FILTER (WHERE cost_usd IS NOT NULL), 0) AS avg_cost,
      COALESCE(AVG(retry_count), 0) AS avg_retries
    FROM tasks
    WHERE 1=1
      ${dateFilter}
      ${repoFilter}
      ${wsFilter}
    GROUP BY agent_type
    ORDER BY task_count DESC
  `);

  // Model breakdown per agent type
  const modelBreakdown = await db.execute<{
    agent_type: string;
    model: string;
    task_count: string;
    avg_cost: string;
  }>(sql`
    SELECT
      agent_type,
      COALESCE(model_used, 'unknown') AS model,
      COUNT(*) AS task_count,
      COALESCE(AVG(CAST(cost_usd AS NUMERIC)) FILTER (WHERE cost_usd IS NOT NULL), 0) AS avg_cost
    FROM tasks
    WHERE 1=1
      ${dateFilter}
      ${repoFilter}
      ${wsFilter}
    GROUP BY agent_type, COALESCE(model_used, 'unknown')
    ORDER BY agent_type, task_count DESC
  `);

  // Group model breakdown by agent type
  const modelsByAgent = new Map<
    string,
    Array<{ model: string; taskCount: number; avgCost: string }>
  >();
  for (const row of modelBreakdown) {
    const list = modelsByAgent.get(row.agent_type) ?? [];
    list.push({
      model: row.model,
      taskCount: parseInt(row.task_count) || 0,
      avgCost: (parseFloat(row.avg_cost) || 0).toFixed(4),
    });
    modelsByAgent.set(row.agent_type, list);
  }

  return {
    agents: agents.map((r) => {
      const count = parseInt(r.task_count) || 0;
      const succeeded = parseInt(r.succeeded) || 0;
      return {
        agentType: r.agent_type,
        taskCount: count,
        successRate: count > 0 ? Math.round((succeeded / count) * 100) : 0,
        avgDuration: Math.round(parseFloat(r.avg_duration) || 0),
        avgCost: (parseFloat(r.avg_cost) || 0).toFixed(4),
        avgRetries: parseFloat(parseFloat(r.avg_retries).toFixed(2)),
        models: modelsByAgent.get(r.agent_type) ?? [],
      };
    }),
  };
}

// ── Failure Analytics ────────────────────────────────────────────────────────

export async function getFailureAnalytics(filters: AnalyticsFilters) {
  const { dateFilter, repoFilter, agentFilter, wsFilter } = buildFilters(filters);

  // Top error categories (using error_message patterns)
  const errorMessages = await db.execute<{
    error_message: string;
    count: string;
  }>(sql`
    SELECT
      COALESCE(error_message, 'Unknown error') AS error_message,
      COUNT(*) AS count
    FROM tasks
    WHERE state = 'failed'
      AND error_message IS NOT NULL
      ${dateFilter}
      ${repoFilter}
      ${agentFilter}
      ${wsFilter}
    GROUP BY error_message
    ORDER BY count DESC
    LIMIT 50
  `);

  // Failure rate by repo
  const failureByRepo = await db.execute<{
    repo_url: string;
    total: string;
    failed: string;
  }>(sql`
    SELECT
      repo_url,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE state = 'failed') AS failed
    FROM tasks
    WHERE state NOT IN ('cancelled')
      ${dateFilter}
      ${repoFilter}
      ${agentFilter}
      ${wsFilter}
    GROUP BY repo_url
    HAVING COUNT(*) >= 2
    ORDER BY COUNT(*) FILTER (WHERE state = 'failed') DESC
    LIMIT 20
  `);

  // Failure rate by agent type
  const failureByAgent = await db.execute<{
    agent_type: string;
    total: string;
    failed: string;
  }>(sql`
    SELECT
      agent_type,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE state = 'failed') AS failed
    FROM tasks
    WHERE state NOT IN ('cancelled')
      ${dateFilter}
      ${repoFilter}
      ${agentFilter}
      ${wsFilter}
    GROUP BY agent_type
    ORDER BY COUNT(*) FILTER (WHERE state = 'failed') DESC
  `);

  // Failure rate by model
  const failureByModel = await db.execute<{
    model: string;
    total: string;
    failed: string;
  }>(sql`
    SELECT
      COALESCE(model_used, 'unknown') AS model,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE state = 'failed') AS failed
    FROM tasks
    WHERE state NOT IN ('cancelled')
      ${dateFilter}
      ${repoFilter}
      ${agentFilter}
      ${wsFilter}
    GROUP BY COALESCE(model_used, 'unknown')
    ORDER BY COUNT(*) FILTER (WHERE state = 'failed') DESC
  `);

  // Retry success rate
  const [retryStats] = await db.execute<{
    retried: string;
    retry_succeeded: string;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE retry_count > 0) AS retried,
      COUNT(*) FILTER (WHERE retry_count > 0 AND state IN ('completed', 'pr_opened')) AS retry_succeeded
    FROM tasks
    WHERE 1=1
      ${dateFilter}
      ${repoFilter}
      ${agentFilter}
      ${wsFilter}
  `);

  // Stall stats
  const [stallStats] = await db.execute<{
    stalled: string;
    recovered: string;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE activity_substate = 'stalled') AS stalled,
      COUNT(*) FILTER (WHERE activity_substate = 'recovered') AS recovered
    FROM tasks
    WHERE 1=1
      ${dateFilter}
      ${repoFilter}
      ${agentFilter}
      ${wsFilter}
  `);

  const retried = parseInt(retryStats.retried) || 0;
  const retrySucceeded = parseInt(retryStats.retry_succeeded) || 0;
  const stalled = parseInt(stallStats.stalled) || 0;
  const recovered = parseInt(stallStats.recovered) || 0;

  return {
    errorMessages: errorMessages.map((r) => ({
      message: r.error_message,
      count: parseInt(r.count) || 0,
    })),
    failureByRepo: failureByRepo.map((r) => {
      const total = parseInt(r.total) || 0;
      const failed = parseInt(r.failed) || 0;
      return {
        repoUrl: r.repo_url,
        total,
        failed,
        failureRate: total > 0 ? Math.round((failed / total) * 100) : 0,
      };
    }),
    failureByAgent: failureByAgent.map((r) => {
      const total = parseInt(r.total) || 0;
      const failed = parseInt(r.failed) || 0;
      return {
        agentType: r.agent_type,
        total,
        failed,
        failureRate: total > 0 ? Math.round((failed / total) * 100) : 0,
      };
    }),
    failureByModel: failureByModel.map((r) => {
      const total = parseInt(r.total) || 0;
      const failed = parseInt(r.failed) || 0;
      return {
        model: r.model,
        total,
        failed,
        failureRate: total > 0 ? Math.round((failed / total) * 100) : 0,
      };
    }),
    retrySuccessRate: retried > 0 ? Math.round((retrySucceeded / retried) * 100) : 0,
    retriedCount: retried,
    retrySucceededCount: retrySucceeded,
    stallCount: stalled,
    stallRecoveryRate: stalled > 0 ? Math.round((recovered / stalled) * 100) : 0,
  };
}

// ── PR Lifecycle Analytics ───────────────────────────────────────────────────

export async function getPrAnalytics(filters: AnalyticsFilters) {
  const { dateFilter, repoFilter, agentFilter, wsFilter } = buildFilters(filters);

  // PR lifecycle stats
  const [prStats] = await db.execute<{
    total_prs: string;
    merged: string;
    closed: string;
    open: string;
    checks_passing: string;
    checks_failing: string;
    review_approved: string;
    review_changes_requested: string;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE pr_url IS NOT NULL) AS total_prs,
      COUNT(*) FILTER (WHERE pr_state = 'merged') AS merged,
      COUNT(*) FILTER (WHERE pr_state = 'closed') AS closed,
      COUNT(*) FILTER (WHERE pr_state = 'open') AS open,
      COUNT(*) FILTER (WHERE pr_checks_status = 'passing') AS checks_passing,
      COUNT(*) FILTER (WHERE pr_checks_status = 'failing') AS checks_failing,
      COUNT(*) FILTER (WHERE pr_review_status = 'approved') AS review_approved,
      COUNT(*) FILTER (WHERE pr_review_status = 'changes_requested') AS review_changes_requested
    FROM tasks
    WHERE 1=1
      ${dateFilter}
      ${repoFilter}
      ${agentFilter}
      ${wsFilter}
  `);

  // Average PR open → merge time
  const [mergeTime] = await db.execute<{
    avg_merge_time: string;
    merge_count: string;
  }>(sql`
    SELECT
      COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - created_at))), 0) AS avg_merge_time,
      COUNT(*) AS merge_count
    FROM tasks
    WHERE pr_state = 'merged'
      AND completed_at IS NOT NULL
      ${dateFilter}
      ${repoFilter}
      ${agentFilter}
      ${wsFilter}
  `);

  const totalPrs = parseInt(prStats.total_prs) || 0;
  const merged = parseInt(prStats.merged) || 0;
  const checksPassing = parseInt(prStats.checks_passing) || 0;
  const reviewApproved = parseInt(prStats.review_approved) || 0;

  return {
    totalPrs,
    merged,
    closed: parseInt(prStats.closed) || 0,
    open: parseInt(prStats.open) || 0,
    ciPassRate: totalPrs > 0 ? Math.round((checksPassing / totalPrs) * 100) : 0,
    reviewApprovalRate: totalPrs > 0 ? Math.round((reviewApproved / totalPrs) * 100) : 0,
    autoMergeRate: totalPrs > 0 ? Math.round((merged / totalPrs) * 100) : 0,
    avgMergeTime: Math.round(parseFloat(mergeTime.avg_merge_time) || 0),
    mergeCount: parseInt(mergeTime.merge_count) || 0,
    funnel: {
      prOpened: totalPrs,
      ciPassed: checksPassing,
      reviewApproved,
      merged,
    },
  };
}
