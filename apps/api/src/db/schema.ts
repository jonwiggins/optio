import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  pgEnum,
  boolean,
  customType,
  unique,
} from "drizzle-orm/pg-core";

export const taskStateEnum = pgEnum("task_state", [
  "pending",
  "queued",
  "provisioning",
  "running",
  "needs_attention",
  "pr_opened",
  "completed",
  "failed",
  "cancelled",
]);

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  repoUrl: text("repo_url").notNull(),
  repoBranch: text("repo_branch").notNull().default("main"),
  state: taskStateEnum("state").notNull().default("pending"),
  agentType: text("agent_type").notNull(),
  containerId: text("container_id"),
  sessionId: text("session_id"),
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  prState: text("pr_state"), // "open" | "merged" | "closed"
  prChecksStatus: text("pr_checks_status"), // "pending" | "passing" | "failing" | "none"
  prReviewStatus: text("pr_review_status"), // "approved" | "changes_requested" | "pending" | "none"
  prReviewComments: text("pr_review_comments"), // latest review comments (for resume)
  resultSummary: text("result_summary"),
  costUsd: text("cost_usd"), // stored as string to avoid float precision issues
  errorMessage: text("error_message"),
  ticketSource: text("ticket_source"),
  ticketExternalId: text("ticket_external_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  priority: integer("priority").notNull().default(100), // lower = higher priority
  parentTaskId: uuid("parent_task_id"), // for review tasks linked to a coding task
  taskType: text("task_type").notNull().default("coding"), // "coding" | "review"
  subtaskOrder: integer("subtask_order").default(0), // ordering within parent's subtasks
  blocksParent: boolean("blocks_parent").notNull().default(false), // if true, parent waits for this
  worktreeState: text("worktree_state").default("none"), // "none" | "active" | "dirty" | "reset" | "preserved" | "removed"
  lastPodId: uuid("last_pod_id"), // tracks which pod ran this task (for same-pod retry)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const taskEvents = pgTable("task_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id),
  fromState: taskStateEnum("from_state"),
  toState: taskStateEnum("to_state").notNull(),
  trigger: text("trigger").notNull(),
  message: text("message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const taskLogs = pgTable("task_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id),
  stream: text("stream").notNull().default("stdout"),
  content: text("content").notNull(),
  logType: text("log_type"), // "text" | "tool_use" | "tool_result" | "thinking" | "system" | "error" | "info"
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
});

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    scope: text("scope").notNull().default("global"),
    encryptedValue: bytea("encrypted_value").notNull(),
    iv: bytea("iv").notNull(),
    authTag: bytea("auth_tag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique("secrets_name_scope_key").on(table.name, table.scope)],
);

export const repos = pgTable("repos", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoUrl: text("repo_url").notNull().unique(),
  fullName: text("full_name").notNull(),
  defaultBranch: text("default_branch").notNull().default("main"),
  isPrivate: boolean("is_private").notNull().default(false),
  imagePreset: text("image_preset").default("base"),
  extraPackages: text("extra_packages"), // comma-separated
  setupCommands: text("setup_commands"), // shell commands run at pod startup after clone
  customDockerfile: text("custom_dockerfile"), // full Dockerfile override (advanced)
  autoMerge: boolean("auto_merge").notNull().default(false),
  promptTemplateOverride: text("prompt_template_override"), // null = use global default
  claudeModel: text("claude_model").default("opus"),
  claudeContextWindow: text("claude_context_window").default("1m"), // "200k" or "1m"
  claudeThinking: boolean("claude_thinking").notNull().default(true),
  claudeEffort: text("claude_effort").default("high"), // "low", "medium", "high"
  maxTurnsCoding: integer("max_turns_coding"), // null = use global default (250)
  maxTurnsReview: integer("max_turns_review"), // null = use global default (10)
  autoResume: boolean("auto_resume").notNull().default(false),
  maxConcurrentTasks: integer("max_concurrent_tasks").notNull().default(2),
  maxPodInstances: integer("max_pod_instances").notNull().default(1),
  maxAgentsPerPod: integer("max_agents_per_pod").notNull().default(2),
  reviewEnabled: boolean("review_enabled").notNull().default(false),
  reviewTrigger: text("review_trigger").default("on_ci_pass"), // "manual" | "on_pr" | "on_ci_pass"
  reviewPromptTemplate: text("review_prompt_template"), // null = use default
  testCommand: text("test_command"), // "npm test", "cargo test", etc.
  reviewModel: text("review_model").default("sonnet"), // can use cheaper model for reviews
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ticketProviders = pgTable("ticket_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: text("source").notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const repoPodStateEnum = pgEnum("repo_pod_state", [
  "provisioning",
  "ready",
  "error",
  "terminating",
]);

export const repoPods = pgTable("repo_pods", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoUrl: text("repo_url").notNull(),
  repoBranch: text("repo_branch").notNull().default("main"),
  instanceIndex: integer("instance_index").notNull().default(0),
  podName: text("pod_name"),
  podId: text("pod_id"),
  state: repoPodStateEnum("state").notNull().default("provisioning"),
  activeTaskCount: integer("active_task_count").notNull().default(0),
  lastTaskAt: timestamp("last_task_at", { withTimezone: true }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const podHealthEvents = pgTable("pod_health_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoPodId: uuid("repo_pod_id").notNull(),
  repoUrl: text("repo_url").notNull(),
  eventType: text("event_type").notNull(), // "crashed" | "oom_killed" | "restarted" | "healthy" | "orphan_cleaned"
  podName: text("pod_name"),
  message: text("message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const promptTemplates = pgTable("prompt_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  template: text("template").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  repoUrl: text("repo_url"), // null = global default, set = repo-specific
  autoMerge: boolean("auto_merge").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
