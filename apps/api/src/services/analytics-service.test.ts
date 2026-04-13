import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecute = vi.fn();

vi.mock("../db/client.js", () => ({
  db: {
    execute: (...args: unknown[]) => mockExecute(...args),
  },
}));

import {
  getPerformanceAnalytics,
  getAgentAnalytics,
  getFailureAnalytics,
  getPrAnalytics,
} from "./analytics-service.js";

describe("analytics-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getPerformanceAnalytics", () => {
    it("returns duration metrics, success rate, and tasks per day", async () => {
      mockExecute
        // durations
        .mockResolvedValueOnce([
          {
            avg_wall_clock: "3600",
            p50_wall_clock: "3000",
            p95_wall_clock: "7200",
            avg_execution: "3000",
            p50_execution: "2500",
            p95_execution: "6000",
            avg_queue_wait: "600",
            task_count: "10",
          },
        ])
        // success rates
        .mockResolvedValueOnce([{ total: "20", succeeded: "16" }])
        // prev period rates
        .mockResolvedValueOnce([{ total: "15", succeeded: "10" }])
        // tasks per day
        .mockResolvedValueOnce([
          { date: "2026-04-10", total: "5", succeeded: "4", failed: "1" },
          { date: "2026-04-11", total: "7", succeeded: "6", failed: "0" },
        ]);

      const result = await getPerformanceAnalytics({
        days: 30,
        workspaceId: "ws-1",
      });

      expect(result.durations.avgWallClock).toBe(3600);
      expect(result.durations.p50WallClock).toBe(3000);
      expect(result.durations.p95WallClock).toBe(7200);
      expect(result.durations.avgExecution).toBe(3000);
      expect(result.durations.avgQueueWait).toBe(600);
      expect(result.durations.taskCount).toBe(10);
      expect(result.successRate).toBe(80);
      // prev was 67%, current is 80%, trend = 80-67 = 13
      expect(result.successRateTrend).toBe(13);
      expect(result.tasksPerDay).toHaveLength(2);
      expect(result.tasksPerDay[0].total).toBe(5);
    });

    it("handles zero tasks gracefully", async () => {
      mockExecute
        .mockResolvedValueOnce([
          {
            avg_wall_clock: "0",
            p50_wall_clock: "0",
            p95_wall_clock: "0",
            avg_execution: "0",
            p50_execution: "0",
            p95_execution: "0",
            avg_queue_wait: "0",
            task_count: "0",
          },
        ])
        .mockResolvedValueOnce([{ total: "0", succeeded: "0" }])
        .mockResolvedValueOnce([{ total: "0", succeeded: "0" }])
        .mockResolvedValueOnce([]);

      const result = await getPerformanceAnalytics({ days: 7 });

      expect(result.successRate).toBe(0);
      expect(result.successRateTrend).toBe(0);
      expect(result.tasksPerDay).toEqual([]);
    });
  });

  describe("getAgentAnalytics", () => {
    it("returns per-agent-type comparison with model breakdown", async () => {
      mockExecute
        // agents
        .mockResolvedValueOnce([
          {
            agent_type: "claude",
            task_count: "15",
            succeeded: "12",
            avg_duration: "1800",
            avg_cost: "1.5000",
            avg_retries: "0.50",
          },
          {
            agent_type: "codex",
            task_count: "5",
            succeeded: "3",
            avg_duration: "2400",
            avg_cost: "0.8000",
            avg_retries: "1.00",
          },
        ])
        // model breakdown
        .mockResolvedValueOnce([
          {
            agent_type: "claude",
            model: "claude-sonnet-4-6",
            task_count: "10",
            avg_cost: "1.2000",
          },
          { agent_type: "claude", model: "claude-opus-4-6", task_count: "5", avg_cost: "2.5000" },
          { agent_type: "codex", model: "gpt-4o", task_count: "5", avg_cost: "0.8000" },
        ]);

      const result = await getAgentAnalytics({ days: 30, workspaceId: "ws-1" });

      expect(result.agents).toHaveLength(2);
      expect(result.agents[0].agentType).toBe("claude");
      expect(result.agents[0].taskCount).toBe(15);
      expect(result.agents[0].successRate).toBe(80);
      expect(result.agents[0].avgDuration).toBe(1800);
      expect(result.agents[0].avgCost).toBe("1.5000");
      expect(result.agents[0].models).toHaveLength(2);
      expect(result.agents[1].agentType).toBe("codex");
      expect(result.agents[1].successRate).toBe(60);
    });
  });

  describe("getFailureAnalytics", () => {
    it("returns failure patterns with retry and stall stats", async () => {
      mockExecute
        // error messages
        .mockResolvedValueOnce([
          { error_message: "ImagePullBackOff", count: "5" },
          { error_message: "OAuth token expired", count: "3" },
        ])
        // failure by repo
        .mockResolvedValueOnce([
          { repo_url: "https://github.com/org/repo1", total: "10", failed: "3" },
        ])
        // failure by agent
        .mockResolvedValueOnce([{ agent_type: "claude", total: "20", failed: "4" }])
        // failure by model
        .mockResolvedValueOnce([{ model: "claude-sonnet-4-6", total: "15", failed: "2" }])
        // retry stats
        .mockResolvedValueOnce([{ retried: "6", retry_succeeded: "4" }])
        // stall stats
        .mockResolvedValueOnce([{ stalled: "3", recovered: "2" }]);

      const result = await getFailureAnalytics({ days: 7, workspaceId: "ws-1" });

      expect(result.errorMessages).toHaveLength(2);
      expect(result.errorMessages[0].message).toBe("ImagePullBackOff");
      expect(result.errorMessages[0].count).toBe(5);
      expect(result.failureByRepo).toHaveLength(1);
      expect(result.failureByRepo[0].failureRate).toBe(30);
      expect(result.failureByAgent[0].failureRate).toBe(20);
      expect(result.failureByModel[0].failureRate).toBe(13);
      expect(result.retrySuccessRate).toBe(67);
      expect(result.retriedCount).toBe(6);
      expect(result.stallCount).toBe(3);
      expect(result.stallRecoveryRate).toBe(67);
    });

    it("handles zero retries and stalls", async () => {
      mockExecute
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ retried: "0", retry_succeeded: "0" }])
        .mockResolvedValueOnce([{ stalled: "0", recovered: "0" }]);

      const result = await getFailureAnalytics({ days: 7 });

      expect(result.retrySuccessRate).toBe(0);
      expect(result.stallRecoveryRate).toBe(0);
    });
  });

  describe("getPrAnalytics", () => {
    it("returns PR lifecycle metrics and funnel", async () => {
      mockExecute
        // pr stats
        .mockResolvedValueOnce([
          {
            total_prs: "20",
            merged: "15",
            closed: "2",
            open: "3",
            checks_passing: "18",
            checks_failing: "2",
            review_approved: "16",
            review_changes_requested: "4",
          },
        ])
        // merge time
        .mockResolvedValueOnce([{ avg_merge_time: "7200", merge_count: "15" }]);

      const result = await getPrAnalytics({ days: 30, workspaceId: "ws-1" });

      expect(result.totalPrs).toBe(20);
      expect(result.merged).toBe(15);
      expect(result.closed).toBe(2);
      expect(result.open).toBe(3);
      expect(result.ciPassRate).toBe(90);
      expect(result.reviewApprovalRate).toBe(80);
      expect(result.autoMergeRate).toBe(75);
      expect(result.avgMergeTime).toBe(7200);
      expect(result.funnel.prOpened).toBe(20);
      expect(result.funnel.ciPassed).toBe(18);
      expect(result.funnel.reviewApproved).toBe(16);
      expect(result.funnel.merged).toBe(15);
    });

    it("handles zero PRs gracefully", async () => {
      mockExecute
        .mockResolvedValueOnce([
          {
            total_prs: "0",
            merged: "0",
            closed: "0",
            open: "0",
            checks_passing: "0",
            checks_failing: "0",
            review_approved: "0",
            review_changes_requested: "0",
          },
        ])
        .mockResolvedValueOnce([{ avg_merge_time: "0", merge_count: "0" }]);

      const result = await getPrAnalytics({ days: 7 });

      expect(result.ciPassRate).toBe(0);
      expect(result.reviewApprovalRate).toBe(0);
      expect(result.autoMergeRate).toBe(0);
    });
  });
});
