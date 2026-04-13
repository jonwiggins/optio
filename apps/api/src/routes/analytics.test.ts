import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";

// ─── Mocks ───

const mockExecute = vi.fn();

vi.mock("../db/client.js", () => ({
  db: {
    execute: (...args: unknown[]) => mockExecute(...args),
  },
}));

const mockGetPerformance = vi.fn();
const mockGetAgents = vi.fn();
const mockGetFailures = vi.fn();
const mockGetPrs = vi.fn();

vi.mock("../services/analytics-service.js", () => ({
  getPerformanceAnalytics: (...args: unknown[]) => mockGetPerformance(...args),
  getAgentAnalytics: (...args: unknown[]) => mockGetAgents(...args),
  getFailureAnalytics: (...args: unknown[]) => mockGetFailures(...args),
  getPrAnalytics: (...args: unknown[]) => mockGetPrs(...args),
}));

import { analyticsRoutes } from "./analytics.js";

// ─── Helpers ───

async function buildTestApp(): Promise<FastifyInstance> {
  return buildRouteTestApp(analyticsRoutes);
}

describe("GET /api/analytics/costs", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns cost analytics with default params (30 days)", async () => {
    // Mock the 11 sequential db.execute calls
    mockExecute
      // 1. totals
      .mockResolvedValueOnce([{ total_cost: "12.5000", task_count: "10", tasks_with_cost: "8" }])
      // 2. prevTotals
      .mockResolvedValueOnce([{ total_cost: "10.0000" }])
      // 3. dailyCosts
      .mockResolvedValueOnce([
        { date: "2026-03-27", cost: "5.0000", task_count: "3" },
        { date: "2026-03-28", cost: "7.5000", task_count: "5" },
      ])
      // 4. costByRepo
      .mockResolvedValueOnce([
        { repo_url: "https://github.com/org/repo1", total_cost: "8.0000", task_count: "6" },
      ])
      // 5. costByType
      .mockResolvedValueOnce([{ task_type: "coding", total_cost: "10.0000", task_count: "7" }])
      // 6. costByModel
      .mockResolvedValueOnce([
        {
          model: "claude-sonnet-4-6",
          total_cost: "12.5000",
          task_count: "10",
          success_count: "8",
          avg_cost: "1.2500",
          total_input_tokens: "50000",
          total_output_tokens: "20000",
        },
      ])
      // 7. anomalies
      .mockResolvedValueOnce([])
      // 8. monthTotals
      .mockResolvedValueOnce([{ month_cost: "5.0000", month_tasks: "4" }])
      // 9. modelSuggestions
      .mockResolvedValueOnce([])
      // 10. topTasks
      .mockResolvedValueOnce([
        {
          id: "task-1",
          title: "Fix bug",
          repo_url: "https://github.com/org/repo1",
          task_type: "coding",
          state: "completed",
          cost_usd: "3.5000",
          input_tokens: "15000",
          output_tokens: "5000",
          model_used: "claude-sonnet-4-6",
          created_at: "2026-03-27",
        },
      ]);

    const res = await app.inject({
      method: "GET",
      url: "/api/analytics/costs",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toBeDefined();
    expect(body.summary.totalCost).toBe("12.5000");
    expect(body.summary.taskCount).toBe(10);
    expect(body.summary.days).toBe(30);
    expect(body.dailyCosts).toHaveLength(2);
    expect(body.costByRepo).toHaveLength(1);
    expect(body.costByType).toHaveLength(1);
    expect(body.costByModel).toHaveLength(1);
    expect(body.costByModel[0].successRate).toBe(80);
    expect(body.topTasks).toHaveLength(1);
    expect(body.topTasks[0].id).toBe("task-1");
    expect(body.forecast).toBeDefined();
    expect(body.anomalies).toEqual([]);
    expect(body.modelSuggestions).toEqual([]);
  });

  it("passes custom days query parameter", async () => {
    // Provide minimal mock responses for all 10 queries
    mockExecute
      .mockResolvedValueOnce([{ total_cost: "0", task_count: "0", tasks_with_cost: "0" }])
      .mockResolvedValueOnce([{ total_cost: "0" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ month_cost: "0", month_tasks: "0" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await app.inject({
      method: "GET",
      url: "/api/analytics/costs?days=7",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary.days).toBe(7);
  });

  it("computes cost trend correctly", async () => {
    mockExecute
      .mockResolvedValueOnce([{ total_cost: "20.0000", task_count: "10", tasks_with_cost: "10" }])
      .mockResolvedValueOnce([{ total_cost: "10.0000" }])
      .mockResolvedValueOnce([{ date: "2026-03-28", cost: "20.0000", task_count: "10" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ month_cost: "20.0000", month_tasks: "10" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await app.inject({
      method: "GET",
      url: "/api/analytics/costs",
    });

    const body = res.json();
    // (20 - 10) / 10 * 100 = 100%
    expect(body.summary.costTrend).toBe("100.0");
    expect(body.summary.prevPeriodCost).toBe("10.0000");
  });

  it("handles zero previous cost (no division by zero)", async () => {
    mockExecute
      .mockResolvedValueOnce([{ total_cost: "5.0000", task_count: "3", tasks_with_cost: "3" }])
      .mockResolvedValueOnce([{ total_cost: "0" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ month_cost: "0", month_tasks: "0" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await app.inject({
      method: "GET",
      url: "/api/analytics/costs",
    });

    const body = res.json();
    expect(body.summary.costTrend).toBe("0.0");
  });

  it("passes repoUrl filter when provided", async () => {
    mockExecute
      .mockResolvedValueOnce([{ total_cost: "0", task_count: "0", tasks_with_cost: "0" }])
      .mockResolvedValueOnce([{ total_cost: "0" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ month_cost: "0", month_tasks: "0" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await app.inject({
      method: "GET",
      url: "/api/analytics/costs?repoUrl=https://github.com/org/repo",
    });

    expect(res.statusCode).toBe(200);
    // Verify that db.execute was called (the repoUrl filter is embedded in SQL)
    expect(mockExecute).toHaveBeenCalledTimes(10);
  });
});

describe("GET /api/analytics/performance", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns performance analytics with default params", async () => {
    mockGetPerformance.mockResolvedValueOnce({
      durations: {
        avgWallClock: 3600,
        p50WallClock: 3000,
        p95WallClock: 7200,
        avgExecution: 3000,
        p50Execution: 2500,
        p95Execution: 6000,
        avgQueueWait: 600,
        taskCount: 10,
      },
      successRate: 80,
      successRateTrend: 5,
      tasksPerDay: [{ date: "2026-04-10", total: 5, succeeded: 4, failed: 1 }],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/analytics/performance",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.durations.avgWallClock).toBe(3600);
    expect(body.successRate).toBe(80);
    expect(body.tasksPerDay).toHaveLength(1);
  });

  it("passes filters to service", async () => {
    mockGetPerformance.mockResolvedValueOnce({
      durations: {
        avgWallClock: 0,
        p50WallClock: 0,
        p95WallClock: 0,
        avgExecution: 0,
        p50Execution: 0,
        p95Execution: 0,
        avgQueueWait: 0,
        taskCount: 0,
      },
      successRate: 0,
      successRateTrend: 0,
      tasksPerDay: [],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/analytics/performance?days=7&agentType=claude&repoUrl=https://github.com/org/repo",
    });

    expect(res.statusCode).toBe(200);
    expect(mockGetPerformance).toHaveBeenCalledWith({
      days: 7,
      agentType: "claude",
      repoUrl: "https://github.com/org/repo",
      workspaceId: "ws-1",
    });
  });
});

describe("GET /api/analytics/agents", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns agent comparison analytics", async () => {
    mockGetAgents.mockResolvedValueOnce({
      agents: [
        {
          agentType: "claude",
          taskCount: 15,
          successRate: 80,
          avgDuration: 1800,
          avgCost: "1.5000",
          avgRetries: 0.5,
          models: [{ model: "claude-sonnet-4-6", taskCount: 10, avgCost: "1.2000" }],
        },
      ],
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/analytics/agents",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].agentType).toBe("claude");
  });
});

describe("GET /api/analytics/failures", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns failure analytics", async () => {
    mockGetFailures.mockResolvedValueOnce({
      errorMessages: [{ message: "ImagePullBackOff", count: 5 }],
      failureByRepo: [],
      failureByAgent: [],
      failureByModel: [],
      retrySuccessRate: 67,
      retriedCount: 6,
      retrySucceededCount: 4,
      stallCount: 3,
      stallRecoveryRate: 67,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/analytics/failures?days=7",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.errorMessages).toHaveLength(1);
    expect(body.retrySuccessRate).toBe(67);
  });
});

describe("GET /api/analytics/prs", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildTestApp();
  });

  it("returns PR lifecycle metrics", async () => {
    mockGetPrs.mockResolvedValueOnce({
      totalPrs: 20,
      merged: 15,
      closed: 2,
      open: 3,
      ciPassRate: 90,
      reviewApprovalRate: 80,
      autoMergeRate: 75,
      avgMergeTime: 7200,
      mergeCount: 15,
      funnel: { prOpened: 20, ciPassed: 18, reviewApproved: 16, merged: 15 },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/analytics/prs",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalPrs).toBe(20);
    expect(body.funnel.merged).toBe(15);
  });
});
