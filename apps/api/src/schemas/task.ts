import { z } from "zod";

/**
 * Task domain schemas.
 *
 * These drive both runtime validation via `fastify-type-provider-zod`
 * (request bodies, query strings, params) and the OpenAPI component
 * definitions emitted under `components.schemas`.
 *
 * Required vs optional follows the `tasks` Drizzle schema: `notNull`
 * columns are required, nullable columns are `.nullable().optional()`.
 * Response fields added by service-layer enrichment (stall info, pipeline
 * progress, pending reason, etc.) are declared optional at the envelope
 * level, not on `TaskSchema` itself.
 */

/** Canonical task state enum — matches `packages/shared/src/types/task.ts`. */
export const TaskStateSchema = z
  .enum([
    "pending",
    "waiting_on_deps",
    "queued",
    "provisioning",
    "running",
    "needs_attention",
    "pr_opened",
    "completed",
    "failed",
    "cancelled",
  ])
  .describe("Task lifecycle state");

export const TaskActivitySubstateSchema = z
  .enum(["active", "stalled", "recovered"])
  .describe("Activity sub-state for running tasks");

export const AgentTypeSchema = z
  .enum(["claude-code", "codex", "copilot", "opencode", "gemini", "openclaw"])
  .describe("Agent runtime that executes the task");

export const WorktreeStateSchema = z
  .enum(["active", "dirty", "reset", "preserved", "removed"])
  .describe("Git worktree lifecycle state for this task");

export const TaskTypeSchema = z
  .enum(["coding", "review"])
  .describe("Task classification — coding tasks vs. review subtasks");

/** Full task row as returned by `taskService.getTask()` / `listTasks()`.
 *
 * Note on dates: service methods return Drizzle rows where timestamp
 * columns are JS `Date` objects (serialized to ISO-8601 strings by
 * Fastify's JSON encoder). `z.date()` accepts `Date` at the serializer
 * layer and zod-to-json-schema renders it as `{ type: "string",
 * format: "date-time" }` in the spec — the wire shape clients actually
 * see.
 *
 * Note on enum columns: PR state / checks / review / worktree are plain
 * `text` columns in Drizzle (no DB-level enum), so we accept any string
 * and document the allowed values in the description. Using strict
 * z.enum here would break the serializer when a new value is introduced.
 */
export const TaskSchema = z
  .object({
    id: z.string().describe("Task UUID"),
    title: z.string().describe("Human-readable task title"),
    prompt: z.string().describe("Prompt passed to the agent"),
    repoUrl: z.string().describe("Fully-qualified repository URL"),
    repoBranch: z.string().describe("Git branch the agent operates on"),
    state: TaskStateSchema,
    agentType: z.string().describe("Agent runtime identifier"),
    containerId: z.string().nullable().describe("Kubernetes pod/container ID, if provisioned"),
    sessionId: z.string().nullable().describe("Owning interactive session ID, if any"),
    prUrl: z.string().nullable().describe("Opened PR URL, set after the agent opens a PR"),
    prNumber: z.number().int().nullable().describe("PR number parsed from prUrl"),
    prState: z
      .string()
      .nullable()
      .describe("Latest PR state observed by the PR watcher (`open` | `merged` | `closed`)"),
    prChecksStatus: z
      .string()
      .nullable()
      .describe("CI check aggregate status (`pending` | `passing` | `failing` | `none`)"),
    prReviewStatus: z
      .string()
      .nullable()
      .describe(
        "Latest review decision from GitHub (`approved` | `changes_requested` | `pending` | `none`)",
      ),
    prReviewComments: z
      .string()
      .nullable()
      .describe("Latest review comment text used for resume prompts"),
    resultSummary: z.string().nullable().describe("Agent-produced completion summary"),
    costUsd: z
      .string()
      .nullable()
      .describe("Total cost in USD as a decimal string (avoids float precision loss)"),
    inputTokens: z.number().int().nullable().describe("Total input tokens consumed"),
    outputTokens: z.number().int().nullable().describe("Total output tokens produced"),
    modelUsed: z.string().nullable().describe("Model identifier used by the agent"),
    errorMessage: z.string().nullable().describe("Last error message when state is `failed`"),
    ticketSource: z
      .string()
      .nullable()
      .describe("Origin ticket provider (`github` | `linear` | `jira` | `notion`)"),
    ticketExternalId: z.string().nullable().describe("External ID within the ticket provider"),
    metadata: z
      .record(z.unknown())
      .nullable()
      .describe("Arbitrary JSON metadata passed through to the agent"),
    retryCount: z.number().int().describe("Number of retries attempted"),
    maxRetries: z.number().int().describe("Maximum retries allowed"),
    priority: z.number().int().describe("Priority — lower numbers run first"),
    parentTaskId: z.string().nullable().describe("Parent task ID when this is a subtask"),
    taskType: z.string().optional().describe("`coding` | `review` | `step` | `child`"),
    subtaskOrder: z.number().int().nullable().describe("Order within parent's subtasks"),
    blocksParent: z.boolean().describe("Whether this subtask must finish before the parent"),
    worktreeState: z
      .string()
      .nullable()
      .describe("Git worktree state (`active` | `dirty` | `reset` | `preserved` | `removed`)"),
    lastPodId: z
      .string()
      .nullable()
      .describe("Most recent pod ID this task ran on (used for retry affinity)"),
    workflowRunId: z.string().nullable().describe("Workflow run ID if spawned by a workflow"),
    createdBy: z.string().nullable().describe("User ID of the creator (null if auth disabled)"),
    ignoreOffPeak: z.boolean().describe("If true, the task runs immediately even off-peak"),
    lastActivityAt: z
      .date()
      .nullable()
      .describe("Timestamp of last observed agent activity (stall detection)"),
    activitySubstate: z.string().describe("`active` | `stalled` | `recovered`"),
    workspaceId: z.string().nullable().describe("Owning workspace ID"),
    lastMessageAt: z
      .date()
      .nullable()
      .describe("Timestamp of the latest user message on this task"),
    createdAt: z.date().describe("Creation timestamp"),
    updatedAt: z.date().describe("Last-update timestamp"),
    startedAt: z.date().nullable().describe("When the task transitioned to running"),
    completedAt: z.date().nullable().describe("When the task reached a terminal state"),
  })
  .describe("Task — a single unit of agent work against a repository");

/** Enrichment overlay: a task with the list-level `isStalled` flag added. */
export const EnrichedTaskSchema = TaskSchema.extend({
  isStalled: z.boolean().describe("Computed stall flag (running with no recent activity)"),
}).describe("Task augmented with cheap list-view enrichment");

/** Task event row (`task_events` table). */
export const TaskEventSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    fromState: TaskStateSchema.nullable(),
    toState: TaskStateSchema,
    trigger: z.string().describe("Short identifier for what caused the transition"),
    message: z.string().nullable(),
    userId: z.string().nullable(),
    createdAt: z.date(),
  })
  .passthrough()
  .describe("State-transition event recorded for a task");

/** Log entry row (`task_logs` table). */
export const LogEntrySchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    stream: z.string().describe("stdout | stderr"),
    content: z.string(),
    logType: z
      .string()
      .nullable()
      .describe(
        "Parsed log category: text | tool_use | tool_result | thinking | system | error | info",
      ),
    metadata: z.record(z.unknown()).nullable(),
    workflowRunId: z.string().nullable(),
    timestamp: z.date(),
  })
  .describe("Task log entry emitted by the agent");

/** Pending-reason annotation surfaced by `GET /api/tasks/:id`. */
export const PendingReasonSchema = z
  .string()
  .nullable()
  .describe("Why a non-terminal task is waiting, or null if running normally");

/** Pipeline progress for tasks with step subtasks. */
export const PipelineProgressSchema = z
  .object({
    totalSteps: z.number().int(),
    completedSteps: z.number().int(),
    failedSteps: z.number().int(),
    runningSteps: z.number().int(),
    currentStepIndex: z.number().int(),
    currentStepTitle: z.string().nullable(),
    steps: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          state: TaskStateSchema,
          subtaskOrder: z.number().int().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough()
  .nullable()
  .describe("Multi-step pipeline progress, null for tasks without step subtasks");

/** Stall info for running tasks. */
export const StallInfoSchema = z
  .object({
    isStalled: z.boolean(),
    silentForMs: z.number().int(),
    thresholdMs: z.number().int(),
    lastLogSummary: z.string().optional(),
  })
  .nullable()
  .describe("Silent-activity detector output for running tasks");

/** Pipeline stats envelope from `GET /api/tasks/stats`. */
export const TaskStatsSchema = z
  .object({
    pending: z.number().int().optional(),
    waiting_on_deps: z.number().int().optional(),
    queued: z.number().int().optional(),
    provisioning: z.number().int().optional(),
    running: z.number().int().optional(),
    needs_attention: z.number().int().optional(),
    pr_opened: z.number().int().optional(),
    completed: z.number().int().optional(),
    failed: z.number().int().optional(),
    cancelled: z.number().int().optional(),
  })
  .passthrough()
  .describe("Counts of tasks grouped by state");

/** Task comment row (`task_comments` table) enriched with user info. */
export const TaskCommentSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    userId: z.string().nullable(),
    content: z.string(),
    createdAt: z.date(),
    updatedAt: z.date(),
    user: z
      .object({
        id: z.string(),
        displayName: z.string(),
        avatarUrl: z.string().nullable(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .describe("Comment on a task, with denormalized user info");

/** Task message row (`task_messages` table). Mid-run user messages. */
export const TaskMessageSchema = z
  .object({
    id: z.string(),
    taskId: z.string(),
    userId: z.string().nullable(),
    content: z.string(),
    mode: z.string().describe("`soft` | `interrupt`"),
    workspaceId: z.string().nullable().optional(),
    createdAt: z.union([z.date(), z.string()]),
    deliveredAt: z.union([z.date(), z.string()]).nullable(),
    ackedAt: z.union([z.date(), z.string()]).nullable(),
    deliveryError: z.string().nullable().optional(),
    user: z
      .object({
        id: z.string(),
        displayName: z.string(),
        avatarUrl: z.string().nullable(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .describe("User message sent mid-run to a running task");

/**
 * Denormalized dependency row — the shape the dependency service returns
 * when listing what a task depends on or what depends on a task. Joins
 * `task_dependencies` to `tasks` and selects a small projection.
 */
export const TaskDependencySchema = z
  .object({
    id: z.string().describe("Joined task ID"),
    title: z.string().describe("Joined task title"),
    state: TaskStateSchema,
    dependencyId: z.string().describe("ID of the dependency edge row"),
  })
  .passthrough()
  .describe("Dependency/dependent task with the edge row ID");

/** Subtask status envelope returned by `/api/tasks/:id/subtasks/status`. */
export const SubtaskStatusSchema = z
  .object({
    allComplete: z.boolean().describe("True when every blocking subtask has completed"),
    total: z.number().int().describe("Total number of blocking subtasks"),
    pending: z.number().int().describe("Blocking subtasks still in `pending` state"),
    running: z
      .number()
      .int()
      .describe("Blocking subtasks in `running`, `provisioning`, or `queued`"),
    completed: z.number().int().describe("Blocking subtasks that have completed"),
    failed: z.number().int().describe("Blocking subtasks that have failed"),
  })
  .passthrough()
  .describe("Aggregated blocking-subtask counts for a parent task");

/** Activity feed item — discriminated union of comments, events, messages. */
export const ActivityItemSchema = z
  .object({
    type: z.string().describe("`comment` | `event` | `message`"),
    id: z.string(),
    taskId: z.string(),
    createdAt: z.union([z.date(), z.string()]),
  })
  .passthrough()
  .describe("Interleaved activity feed item");
