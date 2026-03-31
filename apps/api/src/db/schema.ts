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
  index,
} from "drizzle-orm/pg-core";

// ── Workspace enums ─────────────────────────────────────────────────────────

export const workspaceRoleEnum = pgEnum("workspace_role", ["admin", "member", "viewer"]);

// ── Users (defined early for FK references) ─────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(), // "github" | "google" | "gitlab"
  externalId: text("external_id").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  defaultWorkspaceId: uuid("default_workspace_id"), // last-used workspace
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Workspaces ──────────────────────────────────────────────────────────────

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  description: text("description"),
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: workspaceRoleEnum("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("workspace_members_workspace_user_key").on(table.workspaceId, table.userId),
    index("workspace_members_user_idx").on(table.userId),
    index("workspace_members_workspace_idx").on(table.workspaceId),
  ],
);

// ── Task enums ──────────────────────────────────────────────────────────────

export const taskStateEnum = pgEnum("task_state", [
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
]);

export const tasks = pgTable(
  "tasks",
  {
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
    inputTokens: integer("input_tokens"), // total input tokens used
    outputTokens: integer("output_tokens"), // total output tokens used
    modelUsed: text("model_used"), // model ID used (e.g., "claude-sonnet-4-20250514")
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
    worktreeState: text("worktree_state"), // "active" | "dirty" | "reset" | "preserved" | "removed"
    lastPodId: uuid("last_pod_id"), // last pod this task ran on (for same-pod retry affinity)
    workflowRunId: uuid("workflow_run_id"), // nullable FK to workflow_runs
    createdBy: uuid("created_by"), // nullable FK to users (null when auth is disabled)
    ignoreOffPeak: boolean("ignore_off_peak").notNull().default(false),
    workspaceId: uuid("workspace_id"), // nullable for backward compat; new tasks should always set this
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("tasks_repo_url_state_idx").on(table.repoUrl, table.state),
    index("tasks_state_idx").on(table.state),
    index("tasks_parent_task_id_idx").on(table.parentTaskId),
    index("tasks_created_at_idx").on(table.createdAt.desc()),
    index("tasks_workspace_id_idx").on(table.workspaceId),
    index("tasks_workspace_state_idx").on(table.workspaceId, table.state),
    index("tasks_workspace_updated_idx").on(table.workspaceId, table.updatedAt),
  ],
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    fromState: taskStateEnum("from_state"),
    toState: taskStateEnum("to_state").notNull(),
    trigger: text("trigger").notNull(),
    message: text("message"),
    userId: uuid("user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("task_events_task_id_idx").on(table.taskId)],
);

export const taskLogs = pgTable(
  "task_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    stream: text("stream").notNull().default("stdout"),
    content: text("content").notNull(),
    logType: text("log_type"), // "text" | "tool_use" | "tool_result" | "thinking" | "system" | "error" | "info"
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("task_logs_task_id_timestamp_idx").on(table.taskId, table.timestamp)],
);

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
    workspaceId: uuid("workspace_id"), // nullable for backward compat
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("secrets_name_scope_ws_key").on(table.name, table.scope, table.workspaceId),
    index("secrets_workspace_id_idx").on(table.workspaceId),
  ],
);

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoUrl: text("repo_url").notNull(),
    workspaceId: uuid("workspace_id"), // nullable for backward compat
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    isPrivate: boolean("is_private").notNull().default(false),
    imagePreset: text("image_preset").default("base"),
    extraPackages: text("extra_packages"), // comma-separated
    setupCommands: text("setup_commands"), // shell commands run at pod startup after clone
    customDockerfile: text("custom_dockerfile"), // full Dockerfile override (advanced)
    autoMerge: boolean("auto_merge").notNull().default(false),
    defaultAgentType: text("default_agent_type").notNull().default("claude-code"),
    promptTemplateOverride: text("prompt_template_override"), // null = use global default
    claudeModel: text("claude_model").default("opus"),
    claudeContextWindow: text("claude_context_window").default("1m"), // "200k" or "1m"
    claudeThinking: boolean("claude_thinking").notNull().default(true),
    claudeEffort: text("claude_effort").default("high"), // "low", "medium", "high"
    copilotModel: text("copilot_model"), // null = use copilot default
    copilotEffort: text("copilot_effort"), // "low", "medium", "high"
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
    maxAutoResumes: integer("max_auto_resumes"), // null = use OPTIO_MAX_AUTO_RESUMES env var or default (10)
    encryptedSlackWebhookUrl: bytea("encrypted_slack_webhook_url"), // AES-256-GCM encrypted Slack webhook URL
    slackWebhookUrlIv: bytea("slack_webhook_url_iv"),
    slackWebhookUrlAuthTag: bytea("slack_webhook_url_auth_tag"),
    slackChannel: text("slack_channel"), // override channel (optional)
    slackNotifyOn: jsonb("slack_notify_on").$type<string[]>(), // e.g. ["completed","failed","pr_opened","needs_attention"]
    slackEnabled: boolean("slack_enabled").notNull().default(false),
    networkPolicy: text("network_policy").notNull().default("unrestricted"), // "unrestricted" | "restricted"
    secretProxy: boolean("secret_proxy").notNull().default(false), // Envoy sidecar proxy for secret isolation
    offPeakOnly: boolean("off_peak_only").notNull().default(false),
    cpuRequest: text("cpu_request"), // e.g. "500m", "1000m", "2000m" — K8s CPU request
    cpuLimit: text("cpu_limit"), // e.g. "2000m", "4000m" — K8s CPU limit
    memoryRequest: text("memory_request"), // e.g. "512Mi", "1Gi", "2Gi" — K8s memory request
    memoryLimit: text("memory_limit"), // e.g. "2Gi", "4Gi" — K8s memory limit
    dockerInDocker: boolean("docker_in_docker").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("repos_url_workspace_key").on(table.repoUrl, table.workspaceId),
    index("repos_workspace_id_idx").on(table.workspaceId),
  ],
);

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

export const repoPods = pgTable(
  "repo_pods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoUrl: text("repo_url").notNull(),
    workspaceId: uuid("workspace_id"), // nullable for backward compat
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
  },
  (table) => [
    index("repo_pods_repo_url_idx").on(table.repoUrl),
    index("repo_pods_workspace_id_idx").on(table.workspaceId),
  ],
);

export const podHealthEvents = pgTable("pod_health_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  repoPodId: uuid("repo_pod_id").notNull(),
  repoUrl: text("repo_url").notNull(),
  eventType: text("event_type").notNull(), // "crashed" | "oom_killed" | "restarted" | "healthy" | "orphan_cleaned"
  podName: text("pod_name"),
  message: text("message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webhookEventEnum = pgEnum("webhook_event", [
  "task.completed",
  "task.failed",
  "task.needs_attention",
  "task.pr_opened",
  "review.completed",
]);

export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    url: text("url").notNull(),
    workspaceId: uuid("workspace_id"), // nullable for backward compat
    events: jsonb("events").$type<string[]>().notNull(), // array of webhook_event values
    encryptedSecret: bytea("encrypted_secret"), // AES-256-GCM encrypted signing secret
    secretIv: bytea("secret_iv"),
    secretAuthTag: bytea("secret_auth_tag"),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("webhooks_workspace_id_idx").on(table.workspaceId)],
);

export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  webhookId: uuid("webhook_id")
    .notNull()
    .references(() => webhooks.id, { onDelete: "cascade" }),
  event: text("event").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  statusCode: integer("status_code"),
  responseBody: text("response_body"),
  success: boolean("success").notNull().default(false),
  attempt: integer("attempt").notNull().default(1),
  error: text("error"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
});

export const interactiveSessionStateEnum = pgEnum("interactive_session_state", ["active", "ended"]);

export const interactiveSessions = pgTable(
  "interactive_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoUrl: text("repo_url").notNull(),
    userId: uuid("user_id"),
    worktreePath: text("worktree_path"),
    branch: text("branch").notNull(),
    state: interactiveSessionStateEnum("state").notNull().default("active"),
    podId: uuid("pod_id"),
    costUsd: text("cost_usd"),
    workspaceId: uuid("workspace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    index("interactive_sessions_repo_url_idx").on(table.repoUrl),
    index("interactive_sessions_state_idx").on(table.state),
    index("interactive_sessions_user_id_idx").on(table.userId),
    index("interactive_sessions_workspace_id_idx").on(table.workspaceId),
  ],
);

export const sessionPrs = pgTable(
  "session_prs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => interactiveSessions.id, { onDelete: "cascade" }),
    prUrl: text("pr_url").notNull(),
    prNumber: integer("pr_number").notNull(),
    prState: text("pr_state"), // "open" | "merged" | "closed"
    prChecksStatus: text("pr_checks_status"), // "pending" | "passing" | "failing" | "none"
    prReviewStatus: text("pr_review_status"), // "approved" | "changes_requested" | "pending" | "none"
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("session_prs_session_id_idx").on(table.sessionId)],
);

export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    cronExpression: text("cron_expression").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    taskConfig: jsonb("task_config")
      .$type<{
        title: string;
        prompt: string;
        repoUrl: string;
        repoBranch?: string;
        agentType: string;
        maxRetries?: number;
        priority?: number;
      }>()
      .notNull(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdBy: uuid("created_by"),
    workspaceId: uuid("workspace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("schedules_enabled_next_run_idx").on(table.enabled, table.nextRunAt),
    index("schedules_workspace_id_idx").on(table.workspaceId),
  ],
);

export const scheduleRuns = pgTable(
  "schedule_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id),
    status: text("status").notNull().default("triggered"), // "triggered" | "completed" | "failed"
    error: text("error"),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("schedule_runs_schedule_id_idx").on(table.scheduleId)],
);

export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id),
    userId: uuid("user_id").references(() => users.id),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("task_comments_task_id_idx").on(table.taskId)],
);

export const taskTemplates = pgTable(
  "task_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    repoUrl: text("repo_url"),
    prompt: text("prompt").notNull(),
    agentType: text("agent_type").notNull().default("claude-code"),
    priority: integer("priority").notNull().default(100),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    workspaceId: uuid("workspace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("task_templates_workspace_id_idx").on(table.workspaceId)],
);

// ── Task Dependencies (DAG edges) ────────────────────────────────────────────

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: uuid("depends_on_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("task_deps_unique").on(table.taskId, table.dependsOnTaskId),
    index("task_deps_task_id_idx").on(table.taskId),
    index("task_deps_depends_on_idx").on(table.dependsOnTaskId),
  ],
);

// ── Workflow Templates & Runs ────────────────────────────────────────────────

export const workflowTemplates = pgTable("workflow_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  workspaceId: uuid("workspace_id"),
  steps: jsonb("steps")
    .$type<
      Array<{
        id: string;
        title: string;
        prompt: string;
        repoUrl?: string;
        agentType?: string;
        dependsOn?: string[];
        condition?: { type: string; value?: string };
      }>
    >()
    .notNull(),
  status: text("status").notNull().default("draft"), // "draft" | "active" | "archived"
  createdBy: uuid("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowTemplateId: uuid("workflow_template_id")
      .notNull()
      .references(() => workflowTemplates.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id"),
    status: text("status").notNull().default("running"), // "running" | "paused" | "completed" | "failed" | "cancelled"
    taskMapping: jsonb("task_mapping").$type<Record<string, string>>(), // stepId → taskId
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("workflow_runs_template_id_idx").on(table.workflowTemplateId)],
);

// ── MCP Servers ──────────────────────────────────────────────────────────────

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    command: text("command").notNull(),
    args: jsonb("args").$type<string[]>().notNull().default([]),
    env: jsonb("env").$type<Record<string, string>>(),
    installCommand: text("install_command"),
    scope: text("scope").notNull().default("global"), // "global" or repo URL
    repoUrl: text("repo_url"), // null = global, set = repo-scoped
    workspaceId: uuid("workspace_id"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("mcp_servers_scope_idx").on(table.scope),
    index("mcp_servers_repo_url_idx").on(table.repoUrl),
  ],
);

// ── Custom Skills ────────────────────────────────────────────────────────────

export const customSkills = pgTable(
  "custom_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    prompt: text("prompt").notNull(), // markdown content
    scope: text("scope").notNull().default("global"), // "global" or repo URL
    repoUrl: text("repo_url"), // null = global, set = repo-scoped
    workspaceId: uuid("workspace_id"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("custom_skills_scope_idx").on(table.scope),
    index("custom_skills_repo_url_idx").on(table.repoUrl),
  ],
);

// ── Optio Agent Settings (singleton per workspace) ────────────────────────────

export const optioSettings = pgTable(
  "optio_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    model: text("model").notNull().default("sonnet"), // "opus" | "sonnet" | "haiku"
    systemPrompt: text("system_prompt").notNull().default(""), // custom additions appended to base prompt
    enabledTools: jsonb("enabled_tools").$type<string[]>().notNull().default([]), // empty = all enabled
    confirmWrites: boolean("confirm_writes").notNull().default(true),
    maxTurns: integer("max_turns").notNull().default(20),
    workspaceId: uuid("workspace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("optio_settings_workspace_id_idx").on(table.workspaceId)],
);

// ── Optio Action Audit Trail ─────────────────────────────────────────────────

export const optioActions = pgTable(
  "optio_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id),
    action: text("action").notNull(), // tool name e.g. "retry_task", "bulk_cancel_active"
    params: jsonb("params").$type<Record<string, unknown>>(), // sanitized tool call parameters
    result: jsonb("result").$type<Record<string, unknown>>(), // outcome: affected IDs, error, etc.
    success: boolean("success").notNull(),
    conversationSnippet: text("conversation_snippet"), // user message that triggered this
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("optio_actions_user_id_idx").on(table.userId),
    index("optio_actions_action_idx").on(table.action),
    index("optio_actions_created_at_idx").on(table.createdAt.desc()),
  ],
);

// ── Review Drafts (PR Review Assistant) ─────────────────────────────────────

export const reviewDraftStateEnum = pgEnum("review_draft_state", [
  "drafting",
  "ready",
  "submitted",
  "stale",
]);

export const reviewDrafts = pgTable(
  "review_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    prUrl: text("pr_url").notNull(),
    prNumber: integer("pr_number").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    headSha: text("head_sha").notNull(),
    state: reviewDraftStateEnum("state").notNull().default("drafting"),
    verdict: text("verdict"), // "approve" | "request_changes" | "comment"
    summary: text("summary"),
    fileComments:
      jsonb("file_comments").$type<
        Array<{ path: string; line?: number; side?: string; body: string }>
      >(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("review_drafts_task_id_idx").on(table.taskId),
    index("review_drafts_state_idx").on(table.state),
  ],
);

export const promptTemplates = pgTable(
  "prompt_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    template: text("template").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    repoUrl: text("repo_url"), // null = global default, set = repo-specific
    autoMerge: boolean("auto_merge").notNull().default(false),
    workspaceId: uuid("workspace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("prompt_templates_workspace_id_idx").on(table.workspaceId)],
);
