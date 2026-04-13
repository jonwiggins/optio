import { z } from "zod";

/**
 * Workspace, notification, and analytics domain schemas.
 *
 * Like the integration tag, these use `z.unknown()` for response bodies
 * where the shape is rich, service-computed, or varies by caller. Request
 * schemas remain strict.
 */

export const WorkspaceSchema = z.unknown().describe("Workspace row with enrichment");

export const WorkspaceMemberSchema = z
  .unknown()
  .describe("Workspace membership row with user enrichment");

export const NotificationSubscriptionSchema = z
  .unknown()
  .describe("Web push subscription registered for a user");

export const NotificationPreferencesSchema = z
  .unknown()
  .describe("Per-event-type notification preferences for a user");

export const CostAnalyticsSchema = z
  .unknown()
  .describe(
    "Aggregated cost analytics envelope: summary, forecast, dailyCosts, " +
      "costByRepo, costByType, costByModel, anomalies, modelSuggestions, " +
      "topTasks.",
  );

export const PerformanceAnalyticsSchema = z
  .unknown()
  .describe(
    "Task performance analytics: duration metrics (avg/p50/p95 wall clock and execution), " +
      "success rate with trend, and tasks-per-day time series.",
  );

export const AgentAnalyticsSchema = z
  .unknown()
  .describe(
    "Per-agent-type comparison: task count, success rate, avg duration, " +
      "avg cost, avg retries, and model breakdown for each agent type.",
  );

export const FailureAnalyticsSchema = z
  .unknown()
  .describe(
    "Failure pattern analysis: top error messages, failure rate by repo/agent/model, " +
      "retry success rate, and stall frequency.",
  );

export const PrAnalyticsSchema = z
  .unknown()
  .describe(
    "PR lifecycle metrics: open→merge time, CI pass rate, review approval rate, " +
      "auto-merge rate, and lifecycle funnel data.",
  );
