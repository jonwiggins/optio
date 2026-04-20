import { z } from "zod";

/**
 * Workflow, workflow run, and workflow trigger domain schemas.
 *
 * These mirror the `workflow_templates`, `workflow_runs`, and `workflow_triggers`
 * Drizzle tables. Timestamp columns use `z.date()` so
 * Drizzle row objects pass the serializer; `zod-to-json-schema` renders them
 * as `{ type: "string", format: "date-time" }` in the spec.
 *
 * Schemas use `.passthrough()` where additional aggregate fields (run counts,
 * cost totals) are injected by service-layer queries that join against run
 * history. This keeps the named schema stable while tolerating enrichment.
 */

// Some service methods (e.g. `listWorkflowsWithStats`) JSON-serialize
// timestamps to ISO strings before enriching with aggregate run stats.
// Accept both `Date` and `string` so the serializer validates either.
const flexibleTimestamp = z.union([z.date(), z.string()]).describe("ISO-8601 timestamp");

export const WorkflowSchema = z
  .object({
    id: z.string().describe("Workflow UUID"),
    name: z.string().describe("Human-readable workflow name"),
    description: z.string().nullable().describe("Optional description"),
    promptTemplate: z.string().describe("Handlebars-style prompt with {{param}} placeholders"),
    agentRuntime: z.string().describe("Agent runtime identifier (e.g. `claude-code`)"),
    model: z.string().nullable().describe("Optional model override"),
    maxTurns: z.number().int().nullable().describe("Optional hard turn limit"),
    budgetUsd: z.string().nullable().describe("Optional per-run USD budget (decimal string)"),
    maxConcurrent: z.number().int().describe("Max concurrent runs for this workflow"),
    maxRetries: z.number().int().describe("Max retry attempts on run failure"),
    warmPoolSize: z.number().int().describe("Warm pod pool target size"),
    maxPodInstances: z
      .number()
      .int()
      .describe("Pod replicas; extra pods spin up as demand exceeds single-pod capacity"),
    maxAgentsPerPod: z.number().int().describe("Max concurrent runs (agents) in a single pod"),
    enabled: z.boolean().describe("If false, new runs are blocked"),
    environmentSpec: z.unknown().describe("Optional Kubernetes env overrides (arbitrary JSON)"),
    paramsSchema: z.unknown().describe("Optional JSON Schema describing allowed run params"),
    workspaceId: z.string().nullable(),
    createdBy: z.string().nullable(),
    createdAt: flexibleTimestamp,
    updatedAt: flexibleTimestamp,
  })
  .passthrough()
  .describe("Workflow template — the blueprint for scheduled / triggered runs");

export const WorkflowRunSchema = z
  .object({
    id: z.string().describe("Workflow run UUID"),
    workflowId: z.string(),
    triggerId: z.string().nullable().describe("Trigger that created this run, if any"),
    state: z
      .string()
      .describe("Run lifecycle: `queued` | `running` | `completed` | `failed` | `cancelled`"),
    params: z.record(z.unknown()).nullable().describe("Run parameter bag"),
    output: z.record(z.unknown()).nullable().describe("Agent result output if any"),
    costUsd: z.string().nullable().describe("Total cost in USD (decimal string)"),
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
    modelUsed: z.string().nullable(),
    errorMessage: z.string().nullable(),
    sessionId: z.string().nullable(),
    podName: z.string().nullable().describe("Kubernetes pod that ran (or will run) this"),
    retryCount: z.number().int(),
    startedAt: z.date().nullable(),
    finishedAt: z.date().nullable().describe("Terminal timestamp — success or failure"),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .passthrough()
  .describe("Single workflow run — one concrete execution of a workflow template");

export const WorkflowTriggerSchema = z
  .object({
    id: z.string(),
    workflowId: z.string().nullable(),
    targetType: z.string().describe("`job` | `task_config`"),
    targetId: z.string().describe("UUID of the target entity (job or task_config)"),
    type: z.string().describe("`manual` | `schedule` | `webhook`"),
    config: z
      .record(z.unknown())
      .nullable()
      .describe("Trigger-specific configuration (e.g. `{ cronExpression }` for schedule)"),
    paramMapping: z
      .record(z.unknown())
      .nullable()
      .describe("How to map incoming data to workflow params"),
    enabled: z.boolean(),
    lastFiredAt: z.date().nullable().optional(),
    nextFireAt: z.date().nullable().optional(),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .passthrough()
  .describe("Trigger that creates workflow runs in response to some signal");

export const WorkflowRunLogEntrySchema = z
  .object({
    id: z.string(),
    workflowRunId: z.string(),
    content: z.string(),
    logType: z.string().nullable(),
    metadata: z.record(z.unknown()).nullable(),
    timestamp: z.date(),
  })
  .passthrough()
  .describe("Log entry emitted during a workflow run");

export const WorkflowRunStatsSchema = z
  .object({
    total: z.number().int(),
    queued: z.number().int(),
    running: z.number().int(),
    failed: z.number().int(),
    completed: z.number().int(),
  })
  .describe("Counts of workflow runs grouped by state");

export const CronValidationResultSchema = z
  .object({
    valid: z.boolean(),
    error: z.string().optional().describe("Parse error if the expression is invalid"),
    nextRun: z.string().optional().describe("ISO-8601 of the next projected fire time"),
    description: z.string().optional().describe("Human-readable breakdown of the expression"),
  })
  .passthrough()
  .describe("Cron expression validation result");
