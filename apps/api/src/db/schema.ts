import {
  pgTable,
  bigint,
  uuid,
  text,
  timestamp,
  integer,
  smallint,
  jsonb,
  pgEnum,
  boolean,
  customType,
  unique,
  index,
  uniqueIndex,
  primaryKey,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { WorkDefinitionKind, WorkSettings } from "@optio/shared";

// ── Workspace enums ─────────────────────────────────────────────────────────

export const workspaceRoleEnum = pgEnum("workspace_role", ["admin", "member", "viewer"]);

// ── Users (defined early for FK references) ─────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(), // "github" | "google" | "gitlab"
  externalId: text("external_id").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  // The provider's handle (GitHub login, GitLab username) — what "@-mention
  // me" / "assigned to me" event triggers match on. Null for providers
  // without one (Google, generic OIDC) and for rows from before the column.
  username: text("username"),
  avatarUrl: text("avatar_url"),
  defaultWorkspaceId: uuid("default_workspace_id"), // last-used workspace
  // The New work form's last-used agent settings (runtime + per-runtime options).
  workDefaults: jsonb("work_defaults").$type<{
    runtime?: string;
    agentOptions?: Record<string, Record<string, string | boolean>>;
  }>(),
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
  allowDockerInDocker: boolean("allow_docker_in_docker").notNull().default(false),
  // Verified email domains whose people join this workspace when they sign in.
  autoJoinDomains: jsonb("auto_join_domains").$type<string[]>().notNull().default([]),
  autoJoinRole: workspaceRoleEnum("auto_join_role").notNull().default("member"),
  // Pods get only the secrets a piece of work picks (off: legacy "every org secret").
  restrictPodSecrets: boolean("restrict_pod_secrets").notNull().default(false),
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

export const taskActivitySubstateEnum = pgEnum("task_activity_substate", [
  "active",
  "stalled",
  "recovered",
]);

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

// ── Runs ────────────────────────────────────────────────────────────────────

// The one runs table, `tasks` (docs/plans/work-unification.md, phase 3):
// every run, a repo task (`kind = 'repo'`) or a Job run (`kind =
// 'standalone'`). Code about one kind goes through a view (db/run-views.ts):
// `tasks` below is `repo_tasks` (repo runs, every column) and `workflowRuns`
// is `workflow_runs` (Job runs in their old shape); code about every run
// (the Work list, costs) reads `workRuns`. Add a column to `runColumns` and
// to the "tasks" table in a migration — the views follow on their own.
function runColumns() {
  return {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    repoUrl: text("repo_url").notNull(),
    repoBranch: text("repo_branch").notNull().default("main"),
    state: taskStateEnum("state").notNull().default("pending"),
    agentType: text("agent_type").notNull(),
    containerId: text("container_id"),
    sessionId: text("session_id"),
    // Only set for coding tasks (taskType="coding"): the PR this task
    // opened. External pr_review tasks reference a PR via review_drafts
    // instead — do NOT write prUrl/prNumber for them, or the reconciler
    // will treat the external PR as this task's own output and auto-merge it.
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
    taskType: text("task_type").notNull().default("coding"), // "coding" | "review" (subtask-only)
    subtaskOrder: integer("subtask_order").default(0), // ordering within parent's subtasks
    blocksParent: boolean("blocks_parent").notNull().default(false), // if true, parent waits for this
    worktreeState: text("worktree_state"), // "active" | "dirty" | "reset" | "preserved" | "removed"
    lastPodId: uuid("last_pod_id"), // last pod this task ran on (for same-pod retry affinity)
    workflowRunId: uuid("workflow_run_id"), // legacy, unwritten (a Job run is a row of this table)
    // The definition this task was spawned from (a scheduled Task); null for
    // ad-hoc tasks. Deleting the definition keeps its tasks.
    workId: uuid("work_id").references(() => workDefinitions.id, { onDelete: "set null" }),
    // Run location: "cluster" (repo pod + worktree, default) or "local" — the
    // owner's own machine via the Optio Local daemon. Local tasks are backed
    // by a local_terminals row whose lifecycle drives the task's state
    // (services/local-run-service.ts). local_terminal_id is a soft pointer
    // (not an FK) so the two tables don't reference each other.
    runTarget: text("run_target").$type<"cluster" | "local">().notNull().default("cluster"),
    localHostId: uuid("local_host_id").references(() => localHosts.id, { onDelete: "set null" }),
    localDir: text("local_dir"),
    localSessionMode: text("local_session_mode").$type<"interactive" | "headless">(),
    localTerminalId: uuid("local_terminal_id"),
    // Who the work belongs to (null = the organization) and the secrets its
    // pod gets by name (null = the workspace's legacy behavior).
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    podSecrets: jsonb("pod_secrets").$type<string[]>(),
    // What the work changes about the repo's / workspace's agent environment
    // (null = the defaults; packages/shared/src/work/settings.ts).
    settings: jsonb("settings").$type<WorkSettings>(),
    createdBy: uuid("created_by"), // nullable FK to users (null when auth is disabled)
    ignoreOffPeak: boolean("ignore_off_peak").notNull().default(false),
    // PR follow-through for this task, over the repo's settings: null = the
    // repo's auto_resume / auto_merge apply. "Works until merged" sets
    // auto_resume (and auto_merge unless the person merges themselves).
    autoResume: boolean("auto_resume"),
    autoMerge: boolean("auto_merge"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }), // stall detection: last parsed agent event
    activitySubstate: taskActivitySubstateEnum("activity_substate").notNull().default("active"),
    workspaceId: uuid("workspace_id"), // nullable for backward compat; new tasks should always set this
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    // Control plane: declarative user intent. Reconciler observes and clears.
    controlIntent: text("control_intent"), // "cancel" | "retry" | "resume" | "restart" | null
    // Control plane: durable reconcile backoff for transient world-read failures.
    reconcileBackoffUntil: timestamp("reconcile_backoff_until", { withTimezone: true }),
    reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  };
}

export const workRuns = pgTable(
  "tasks",
  {
    ...runColumns(),
    kind: text("kind").$type<"repo" | "standalone">().notNull().default("repo"),
    // Only a repo run must have these (tasks_repo_check).
    title: text("title"),
    prompt: text("prompt"),
    repoUrl: text("repo_url"),
    agentType: text("agent_type"),
    // A Job run's trigger, params, output, and the pod it holds right now.
    triggerId: uuid("trigger_id").references(() => workflowTriggers.id, { onDelete: "set null" }),
    params: jsonb("params").$type<Record<string, unknown>>(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    podId: uuid("pod_id"),
  },
  (table) => [
    index("tasks_kind_state_idx").on(table.kind, table.state),
    index("tasks_kind_created_at_idx").on(table.kind, table.createdAt.desc()),
    index("tasks_pod_id_idx")
      .on(table.podId)
      .where(sql`${table.podId} IS NOT NULL`),
    index("tasks_trigger_id_idx")
      .on(table.triggerId)
      .where(sql`${table.triggerId} IS NOT NULL`),
    index("tasks_repo_url_state_idx").on(table.repoUrl, table.state),
    index("tasks_state_idx").on(table.state),
    index("tasks_parent_task_id_idx").on(table.parentTaskId),
    index("tasks_created_at_idx").on(table.createdAt.desc()),
    index("tasks_workspace_id_idx").on(table.workspaceId),
    index("tasks_workspace_state_idx").on(table.workspaceId, table.state),
    index("tasks_workspace_updated_idx").on(table.workspaceId, table.updatedAt),
    index("tasks_work_id_idx")
      .on(table.workId)
      .where(sql`${table.workId} IS NOT NULL`),
  ],
);

/** Repo runs: the `repo_tasks` view over the runs table. */
export const tasks = pgTable("repo_tasks", runColumns());

export const taskEvents = pgTable(
  "task_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => workRuns.id),
    fromState: taskStateEnum("from_state"),
    toState: taskStateEnum("to_state").notNull(),
    trigger: text("trigger").notNull(),
    message: text("message"),
    userId: uuid("user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("task_events_task_id_idx").on(table.taskId)],
);

/**
 * Every PR a Repo Task opened or tracks. `tasks.pr_url` stays the primary
 * one (what the PR lifecycle follows); extra PRs live only here.
 */
export const taskPrs = pgTable(
  "task_prs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => workRuns.id, { onDelete: "cascade" }),
    repoUrl: text("repo_url").notNull(),
    number: integer("number").notNull(),
    url: text("url").notNull(),
    headBranch: text("head_branch"),
    headRepo: text("head_repo"),
    baseBranch: text("base_branch"),
    source: text("source").notNull(), // tool_call | branch | attached
    state: text("state").notNull().default("open"), // open | merged | closed
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("task_prs_task_url_idx").on(table.taskId, table.url)],
);

// The one log table for every agent run (services/run-log-service.ts): a row
// belongs to exactly one of a task, a PR-review run, or a persistent-agent turn.
export const taskLogs = pgTable(
  "task_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id").references(() => workRuns.id, { onDelete: "cascade" }),
    stream: text("stream").notNull().default("stdout"),
    content: text("content").notNull(),
    logType: text("log_type"), // "text" | "tool_use" | "tool_result" | "thinking" | "system" | "error" | "info"
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    workflowRunId: uuid("workflow_run_id"), // legacy, unwritten: a Job run's lines are keyed by task_id
    prReviewRunId: uuid("pr_review_run_id"), // nullable FK to pr_review_runs
    // A persistent agent's turn (its agent is the turn's). Deleting the turn
    // or the agent deletes its logs.
    persistentAgentTurnId: uuid("persistent_agent_turn_id").references(
      () => persistentAgentTurns.id,
      { onDelete: "cascade" },
    ),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("task_logs_task_id_timestamp_idx").on(table.taskId, table.timestamp),
    index("task_logs_pr_review_run_id_idx").on(table.prReviewRunId, table.timestamp),
    index("task_logs_persistent_agent_turn_id_idx")
      .on(table.persistentAgentTurnId, table.timestamp)
      .where(sql`${table.persistentAgentTurnId} IS NOT NULL`),
  ],
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
    alg: smallint("alg").notNull().default(1), // 1 = AES_256_GCM_V1
    workspaceId: uuid("workspace_id"), // nullable for backward compat
    userId: uuid("user_id").references(() => users.id), // nullable; set iff scope = "user"
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("secrets_name_scope_ws_user_key").on(
      table.name,
      table.scope,
      table.workspaceId,
      table.userId,
    ),
    index("secrets_workspace_id_idx").on(table.workspaceId),
    index("secrets_user_id_idx").on(table.userId),
  ],
);

// ── Auth Events ─────────────────────────────────────────────────────────────
// Lightweight table for recording auth failures from non-task contexts
// (e.g. ticket-sync, pr-watcher) so the failure detector can surface them.
export const authEvents = pgTable(
  "auth_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenType: text("token_type").notNull(), // "claude" | "github"
    source: text("source"), // e.g. "pr-watcher", "ticket-sync:<providerId>"
    errorMessage: text("error_message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("auth_events_token_type_created_idx").on(table.tokenType, table.createdAt)],
);

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoUrl: text("repo_url").notNull(),
    gitPlatform: text("git_platform").notNull().default("github"),
    workspaceId: uuid("workspace_id"), // nullable for backward compat
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    isPrivate: boolean("is_private").notNull().default(false),
    imagePreset: text("image_preset").default("base"),
    extraPackages: text("extra_packages"), // comma-separated
    setupCommands: text("setup_commands"), // shell commands run at pod startup after clone
    customDockerfile: text("custom_dockerfile"), // full Dockerfile override (advanced)
    autoMerge: boolean("auto_merge").notNull().default(false),
    cautiousMode: boolean("cautious_mode").notNull().default(false),
    defaultAgentType: text("default_agent_type").notNull().default("claude-code"),
    promptTemplateOverride: text("prompt_template_override"), // null = use global default
    claudeModel: text("claude_model").default("opus"),
    claudeContextWindow: text("claude_context_window").default("1m"), // "200k" or "1m"
    claudeThinking: boolean("claude_thinking").notNull().default(true),
    claudeEffort: text("claude_effort").default("high"), // "low", "medium", "high"
    copilotModel: text("copilot_model"), // null = use copilot default
    copilotEffort: text("copilot_effort"), // "low", "medium", "high"
    opencodeModel: text("opencode_model"), // e.g. "anthropic/claude-sonnet-4", null = OpenCode default
    opencodeAgent: text("opencode_agent"), // e.g. "build", "plan", null = default
    opencodeProvider: text("opencode_provider"), // "anthropic" | "openai" | ... for default provider inference
    opencodeBaseUrl: text("opencode_base_url"), // Custom OpenAI-compatible endpoint URL (e.g. http://lightllm:8080/v1)
    geminiModel: text("gemini_model").default("gemini-2.5-pro"),
    geminiApprovalMode: text("gemini_approval_mode").default("yolo"), // "default" | "auto_edit" | "yolo"
    openclawModel: text("openclaw_model"), // model selection, null = OpenClaw default
    openclawAgent: text("openclaw_agent"), // named agent/preset, null = default
    cursorModel: text("cursor_model"), // e.g. "composer-2.5", null = Cursor account default
    maxTurnsCoding: integer("max_turns_coding"), // null = use global default (250)
    maxTurnsReview: integer("max_turns_review"), // null = use global default (10)
    autoResume: boolean("auto_resume").notNull().default(false),
    planningModeEnabled: boolean("planning_mode_enabled").notNull().default(false),
    maxConcurrentTasks: integer("max_concurrent_tasks").notNull().default(2),
    maxPodInstances: integer("max_pod_instances").notNull().default(1),
    maxAgentsPerPod: integer("max_agents_per_pod").notNull().default(2),
    reviewEnabled: boolean("review_enabled").notNull().default(false),
    reviewTrigger: text("review_trigger").default("on_ci_pass"), // "manual" | "on_pr" | "on_ci_pass"
    reviewPromptTemplate: text("review_prompt_template"), // null = use default
    testCommand: text("test_command"), // "npm test", "cargo test", etc.
    reviewAgentType: text("review_agent_type"), // null = inherit (defaultAgentType / global)
    reviewModel: text("review_model").default("sonnet"), // can use cheaper model for reviews
    // External (non-optio-authored) PR auto-review
    externalReviewMode: text("external_review_mode").notNull().default("off"), // "off" | "on_request" | "on_pr_hold" | "on_pr_post"
    externalReviewFilters: jsonb("external_review_filters").$type<{
      skipDrafts?: boolean;
      skipOptioAuthored?: boolean;
      includeAuthors?: string[];
      excludeAuthors?: string[];
      includeLabels?: string[];
      excludeLabels?: string[];
    }>(),
    externalReviewWaitForCi: boolean("external_review_wait_for_ci").notNull().default(true),
    maxAutoResumes: integer("max_auto_resumes"), // null = use OPTIO_MAX_AUTO_RESUMES env var or default (10)
    encryptedSlackWebhookUrl: bytea("encrypted_slack_webhook_url"), // AES-256-GCM encrypted Slack webhook URL
    slackWebhookUrlIv: bytea("slack_webhook_url_iv"),
    slackWebhookUrlAuthTag: bytea("slack_webhook_url_auth_tag"),
    slackWebhookUrlAlg: smallint("slack_webhook_url_alg").notNull().default(1), // 1 = AES_256_GCM_V1
    slackChannel: text("slack_channel"), // override channel (optional)
    slackNotifyOn: jsonb("slack_notify_on").$type<string[]>(), // e.g. ["completed","failed","pr_opened","needs_attention"]
    slackEnabled: boolean("slack_enabled").notNull().default(false),
    networkPolicy: text("network_policy").notNull().default("unrestricted"), // "unrestricted" | "restricted"
    secretProxy: boolean("secret_proxy").notNull().default(false), // Envoy sidecar proxy for secret isolation
    stallThresholdMs: integer("stall_threshold_ms"), // per-repo override for stall detection (null = use global default)
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
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  // NULL until the first successful sync completes. Tickets swept while this
  // is NULL are backfill: their tasks are created pending, not auto-queued
  // (issue #579).
  initialSyncAt: timestamp("initial_sync_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentPodStateEnum = pgEnum("agent_pod_state", [
  "provisioning",
  "ready",
  "error",
  "terminating",
]);

/**
 * Every pod Optio runs agents in (services/agent-pod-pool.ts). A pool is what
 * pods are shared across; `poolKey` names its member:
 *   pool = "repo"             poolKey = the normalized repo URL (no workspace —
 *                             StatefulSet / PVC names derive from the URL)
 *   pool = "standalone"       poolKey = the Job (definition) id
 *   pool = "persistent-agent" poolKey = the agent id
 * Repo and Job pools scale out to maxPodInstances replicas (`instanceIndex`)
 * each hosting up to maxAgentsPerPod concurrent runs (`activeCount`); an
 * agent's pod is single-tenant and kept warm until `keepWarmUntil` (null =
 * always-on).
 */
export const agentPods = pgTable(
  "agent_pods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pool: text("pool").$type<"repo" | "standalone" | "persistent-agent">().notNull(),
    poolKey: text("pool_key").notNull(),
    instanceIndex: integer("instance_index").notNull().default(0),
    workspaceId: uuid("workspace_id"),
    repoBranch: text("repo_branch"), // repo pods
    podName: text("pod_name"),
    podId: text("pod_id"),
    state: agentPodStateEnum("state").notNull().default("provisioning"),
    activeCount: integer("active_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    keepWarmUntil: timestamp("keep_warm_until", { withTimezone: true }), // persistent-agent pods
    errorMessage: text("error_message"),
    managedBy: text("managed_by").notNull().default("bare-pod"), // "bare-pod" | "statefulset" | "job"
    statefulSetName: text("statefulset_name"), // repo pods
    jobName: text("job_name"), // Job and persistent-agent pods
    cachePvcName: text("cache_pvc_name"), // repo pods
    cachePvcState: text("cache_pvc_state"), // "pending" | "bound" | "error"
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_pods_pool_key_idx").on(table.pool, table.poolKey),
    index("agent_pods_workspace_id_idx").on(table.workspaceId),
    index("agent_pods_statefulset_name_idx").on(table.statefulSetName),
    index("agent_pods_keep_warm_idx")
      .on(table.keepWarmUntil)
      .where(sql`${table.keepWarmUntil} IS NOT NULL`),
    uniqueIndex("agent_pods_standalone_instance_key")
      .on(table.poolKey, table.instanceIndex)
      .where(sql`${table.pool} = 'standalone'`),
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
    secretAlg: smallint("secret_alg").notNull().default(1), // 1 = AES_256_GCM_V1
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
    // The name given to the session (New session form); null = unnamed.
    title: text("title"),
    state: interactiveSessionStateEnum("state").notNull().default("active"),
    podId: uuid("pod_id"),
    costUsd: text("cost_usd"),
    workspaceId: uuid("workspace_id"),
    // Claude Code session id captured from the first chat turn; later turns
    // pass `--resume <id>` so the chat is one conversation across WS connects.
    agentSessionId: text("agent_session_id"),
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

// Persisted chat events for an interactive session. One row per parsed
// AgentLogEntry the session WebSocket emits. Lets reconnecting clients
// reload the conversation rather than starting from an empty log.
export const sessionChatEvents = pgTable(
  "session_chat_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => interactiveSessions.id, { onDelete: "cascade" }),
    stream: text("stream").notNull().default("stdout"),
    content: text("content").notNull(),
    logType: text("log_type"), // "text" | "tool_use" | "tool_result" | "thinking" | "system" | "error" | "info"
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
    // Insertion order: breaks `timestamp` ties (ms clock, several events per
    // output chunk) so history replays in the order it streamed.
    seq: bigint("seq", { mode: "number" }).generatedByDefaultAsIdentity(),
  },
  (table) => [index("session_chat_events_session_idx").on(table.sessionId, table.timestamp)],
);

export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => workRuns.id),
    userId: uuid("user_id").references(() => users.id),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("task_comments_task_id_idx").on(table.taskId)],
);

// ── Task Messages (user → agent mid-task messaging) ──────────────────────────

export const taskMessageModeEnum = pgEnum("task_message_mode", ["soft", "interrupt"]);

export const taskMessages = pgTable(
  "task_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => workRuns.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id),
    content: text("content").notNull(),
    mode: taskMessageModeEnum("mode").notNull().default("soft"),
    workspaceId: uuid("workspace_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
    deliveryError: text("delivery_error"),
  },
  (table) => [
    index("task_messages_task_id_idx").on(table.taskId),
    index("task_messages_task_created_idx").on(table.taskId, table.createdAt),
  ],
);

// ── Task Dependencies (DAG edges) ────────────────────────────────────────────

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => workRuns.id, { onDelete: "cascade" }),
    dependsOnTaskId: uuid("depends_on_task_id")
      .notNull()
      .references(() => workRuns.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("task_deps_unique").on(table.taskId, table.dependsOnTaskId),
    index("task_deps_task_id_idx").on(table.taskId),
    index("task_deps_depends_on_idx").on(table.dependsOnTaskId),
  ],
);

// ── Work definitions ────────────────────────────────────────────────────────

// Saved, re-runnable work: what a trigger (the When) starts each time it
// fires. One table for the three kinds, told apart by `kind`
// (services/work-definition-service.ts):
//   repo-blueprint   a scheduled Task — each firing spawns a repo task
//   standalone       a Job — each firing starts a Job run (a `tasks` row of
//                    kind 'standalone', read through the workflow_runs view)
//   local-blueprint  a Local automation — each firing opens a terminal on
//                    its owner's machine (local_terminals)
// Columns a kind doesn't use keep their defaults. The legacy endpoints
// (/api/task-configs, /api/jobs, /api/local/blueprints) project rows back to
// the shapes they always returned.
export const workDefinitions = pgTable(
  "work_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").$type<WorkDefinitionKind>().notNull(),
    name: text("name").notNull(),
    description: text("description"),
    // Scheduled Tasks and Jobs live in a workspace (deleting it deletes
    // them: workspace-service); Local automations are their owner's.
    workspaceId: uuid("workspace_id"),
    // Who the work belongs to: null = the organization's, set = one person's
    // own (it runs with their credentials; a Local automation always is).
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id),
    // The secrets its pod gets, by name (null = the workspace's legacy behavior).
    podSecrets: jsonb("pod_secrets").$type<string[]>(),
    // What the work changes about the repo's / workspace's agent environment
    // (null = the defaults; packages/shared/src/work/settings.ts).
    settings: jsonb("settings").$type<WorkSettings>(),
    enabled: boolean("enabled").notNull().default(true),

    // What. The prompt (a Local automation's command when it runs no agent)
    // is a `{{param}}` template rendered with each firing's params, unless a
    // saved prompt from the Prompts library replaces it.
    prompt: text("prompt").notNull(),
    promptTemplateId: uuid("prompt_template_id").references(() => promptTemplates.id, {
      onDelete: "set null",
    }),
    // Name each run gets, a `{{param}}` template ("Triage: {{ticketTitle}}").
    // Null = the definition's name.
    runTitle: text("run_title"),
    paramsSchema: jsonb("params_schema").$type<Record<string, unknown>>(),

    // Who. Null agent = a scheduled Task's template / the repo default, or a
    // Local automation that runs a plain shell command.
    agentType: text("agent_type"),
    // Jobs' legacy single model field; agentOptions is the full set.
    model: text("model"),
    // Per-run agent parameters keyed like the provider catalog (model,
    // effort, Claude Code's permission mode, …). Null = the defaults.
    agentOptions: jsonb("agent_options").$type<Record<string, string | boolean>>(),

    // Where. Repo kinds: the repo and the branch the work starts from (and
    // its PR targets); a Local automation with a null branch works in the
    // checkout as it is.
    repoUrl: text("repo_url"),
    repoBranch: text("repo_branch"),
    runTarget: text("run_target").$type<"cluster" | "local">().notNull().default("cluster"),
    localHostId: uuid("local_host_id").references(() => localHosts.id, { onDelete: "set null" }),
    localDir: text("local_dir"),
    localSessionMode: text("local_session_mode").$type<"interactive" | "headless">(),
    environmentSpec: jsonb("environment_spec").$type<Record<string, unknown>>(),
    // Local automations: "hold" parks each spawned terminal until you start it.
    spawnMode: text("spawn_mode").$type<"auto" | "hold">().notNull().default("auto"),

    // How runs go.
    maxRetries: integer("max_retries").notNull().default(1),
    priority: integer("priority").notNull().default(100),
    // PR follow-through copied onto every spawned task (see tasks.auto_resume).
    autoResume: boolean("auto_resume"),
    autoMerge: boolean("auto_merge"),
    maxTurns: integer("max_turns"),
    budgetUsd: text("budget_usd"),
    maxConcurrent: integer("max_concurrent").notNull().default(2),
    warmPoolSize: integer("warm_pool_size").notNull().default(0),
    // Job pod pooling — mirrors repos.maxPodInstances / maxAgentsPerPod. Runs
    // share pods within a Job, scaling out to maxPodInstances replicas.
    maxPodInstances: integer("max_pod_instances").notNull().default(1),
    maxAgentsPerPod: integer("max_agents_per_pod").notNull().default(2),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Names are unique per kind: scheduled Tasks and Jobs per workspace,
    // Local automations per person.
    uniqueIndex("work_definitions_workspace_name_key")
      .on(table.kind, table.workspaceId, table.name)
      .where(sql`${table.kind} <> 'local-blueprint'`),
    uniqueIndex("work_definitions_user_name_key")
      .on(table.ownerUserId, table.name)
      .where(sql`${table.kind} = 'local-blueprint'`),
    index("work_definitions_workspace_id_idx").on(table.workspaceId),
    index("work_definitions_owner_user_id_idx")
      .on(table.ownerUserId)
      .where(sql`${table.ownerUserId} IS NOT NULL`),
    check(
      "work_definitions_kind_check",
      sql`${table.kind} IN ('repo-blueprint', 'standalone', 'local-blueprint')`,
    ),
    check(
      "work_definitions_repo_check",
      sql`${table.kind} <> 'repo-blueprint' OR ${table.repoUrl} IS NOT NULL`,
    ),
  ],
);

// Generic trigger table — dispatches to any target: a work definition (by its
// kind's target type: "job", "task_config", "local_blueprint"), a persistent
// agent, or a PR review. Historical name "workflow_triggers" kept to avoid a
// large rename migration; treat it as the generic `triggers` table.
export const workflowTriggers = pgTable(
  "workflow_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Legacy, from before target_type: still written (it mirrors target_id
    // for target_type='job', null for other types) but nothing reads it.
    workflowId: uuid("workflow_id").references(() => workDefinitions.id, { onDelete: "cascade" }),
    // "job" | "task_config" | "local_blueprint" | "persistent_agent" | "pr_review"
    targetType: text("target_type").notNull().default("job"),
    targetId: uuid("target_id").notNull(),
    // "manual" | "schedule" | "webhook" | "ticket" | "github" | "slack" | "linear"
    type: text("type").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>(),
    paramMapping: jsonb("param_mapping").$type<Record<string, unknown>>(),
    enabled: boolean("enabled").notNull().default(true),
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("workflow_triggers_workflow_id_idx").on(table.workflowId),
    index("workflow_triggers_schedule_due_idx").on(table.enabled, table.nextFireAt),
    index("workflow_triggers_target_idx").on(table.targetType, table.targetId),
  ],
);

/**
 * Job runs: the `workflow_runs` view over the runs table (db/run-views.ts),
 * in the shape the Job code has always used — `workflowId` is the run's
 * `work_id`, `finishedAt` its `completed_at`, `podName` its `container_id`.
 * Inserts through it are Job runs (`kind` defaults to 'standalone').
 */
export const workflowRuns = pgTable("workflow_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowId: uuid("workflow_id").notNull(),
  // SET NULL on the table: deleting a trigger keeps the runs it started.
  triggerId: uuid("trigger_id"),
  params: jsonb("params").$type<Record<string, unknown>>(),
  // The Job's run_title rendered with this run's params; null = no template.
  title: text("title"),
  state: text("state").notNull().default("queued"), // "queued" | "running" | "completed" | "failed"
  output: jsonb("output").$type<Record<string, unknown>>(),
  costUsd: text("cost_usd"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  modelUsed: text("model_used"),
  errorMessage: text("error_message"),
  sessionId: text("session_id"),
  podName: text("pod_name"),
  // The Job pod running this attempt; null when queued or released, so a
  // pod's active count reflects live runs.
  podId: uuid("pod_id"),
  // Retry affinity — the last pod that ran this, even after release.
  lastPodId: uuid("last_pod_id"),
  // Local runs (the Job's run_target = "local"): the local_terminals row
  // executing this attempt. Soft pointer, replaced on retry.
  localTerminalId: uuid("local_terminal_id"),
  retryCount: integer("retry_count").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  // Control plane: declarative user intent. Reconciler observes and clears.
  controlIntent: text("control_intent"), // "cancel" | "retry" | "resume" | "restart" | null
  // Control plane: durable reconcile backoff.
  reconcileBackoffUntil: timestamp("reconcile_backoff_until", { withTimezone: true }),
  reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
  // Scoping and identity, from the Job when the run is made.
  workspaceId: uuid("workspace_id"),
  ownerUserId: uuid("owner_user_id"),
  // What the attempt actually ran: the rendered prompt and the agent.
  prompt: text("prompt"),
  agentType: text("agent_type"),
  // Where and how often it runs, from the Job when the run is made (the
  // worker reads the Job live; these keep the runs table truthful).
  runTarget: text("run_target").$type<"cluster" | "local">(),
  maxRetries: integer("max_retries"),
  // Stall detection: the attempt's last agent event.
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Connection Providers (catalog) ──────────────────────────────────────────

export const connectionProviders = pgTable(
  "connection_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(), // e.g. "notion", "postgres", "custom-mcp"
    name: text("name").notNull(), // "Notion"
    description: text("description"),
    icon: text("icon"), // SVG string or URL
    category: text("category").notNull().default("custom"), // "productivity" | "database" | "cloud" | "knowledge" | "custom"
    type: text("type").notNull().default("mcp"), // "mcp" | "http" | "database"
    configSchema: jsonb("config_schema").$type<Record<string, unknown>>(), // JSON Schema for setup form
    requiredSecrets: jsonb("required_secrets").$type<string[]>().default([]),
    mcpConfig: jsonb("mcp_config").$type<{
      command: string;
      args: string[];
      envMapping: Record<string, string>; // maps config fields to env vars
      installCommand?: string;
    }>(),
    capabilities: jsonb("capabilities").$type<string[]>().default([]),
    docsUrl: text("docs_url"),
    builtIn: boolean("built_in").notNull().default(false),
    workspaceId: uuid("workspace_id"), // null for built-in providers
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("connection_providers_slug_ws_key").on(table.slug, table.workspaceId),
    // The composite unique above treats NULL workspace_id as distinct, so it
    // can't stop duplicate built-in (NULL-workspace) rows; this partial index
    // is the conflict target for seedBuiltInProviders()'s upsert.
    uniqueIndex("connection_providers_slug_builtin_key")
      .on(table.slug)
      .where(sql`${table.workspaceId} IS NULL`),
    index("connection_providers_category_idx").on(table.category),
    index("connection_providers_workspace_id_idx").on(table.workspaceId),
  ],
);

// ── Connections (configured instances) ─────────────────────────────────────

export const connectionStatusEnum = pgEnum("connection_status", ["healthy", "error", "unknown"]);

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(), // "Our Notion Workspace"
    providerId: uuid("provider_id")
      .notNull()
      .references(() => connectionProviders.id, { onDelete: "cascade" }),
    config: jsonb("config").$type<Record<string, unknown>>(), // provider-specific config
    scope: text("scope").notNull().default("global"), // "global" or repo URL
    repoUrl: text("repo_url"), // null = global
    workspaceId: uuid("workspace_id"),
    // Null = the organization's; set = one person's own (only their work gets it).
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    status: connectionStatusEnum("status").notNull().default("unknown"),
    statusMessage: text("status_message"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("connections_provider_id_idx").on(table.providerId),
    index("connections_workspace_id_idx").on(table.workspaceId),
    index("connections_scope_idx").on(table.scope),
  ],
);

// ── Model providers (Bedrock for Claude Code / Codex) ──────────────────────

export const modelProviders = pgTable(
  "model_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id"),
    // Null = the organization's; set = one person's own.
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind").$type<"bedrock">().notNull().default("bedrock"),
    name: text("name").notNull(),
    agents: jsonb("agents").$type<string[]>().notNull().default([]),
    region: text("region").notNull(),
    models: jsonb("models")
      .$type<Record<string, Array<{ id: string; label?: string }>>>()
      .notNull()
      .default({}),
    localAwsProfile: text("local_aws_profile"),
    podCredential: text("pod_credential")
      .$type<"access-key" | "bearer-token" | "ambient" | "none">()
      .notNull()
      .default("none"),
    // AES-256-GCM JSON of the pod credentials; never returned by the API.
    encryptedCredentials: bytea("encrypted_credentials"),
    credentialsIv: bytea("credentials_iv"),
    credentialsAuthTag: bytea("credentials_auth_tag"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("model_providers_workspace_id_idx").on(table.workspaceId),
    index("model_providers_owner_user_id_idx").on(table.ownerUserId),
  ],
);

// ── Connection Assignments (which repos get which connections) ──────────────

export const connectionAssignments = pgTable(
  "connection_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id").references(() => repos.id, { onDelete: "cascade" }), // null = all repos
    agentTypes: jsonb("agent_types").$type<string[]>().default([]), // empty = all agents
    permission: text("permission").notNull().default("read"), // "read" | "write" | "full"
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("connection_assignments_conn_repo_key").on(table.connectionId, table.repoId),
    index("connection_assignments_connection_id_idx").on(table.connectionId),
    index("connection_assignments_repo_id_idx").on(table.repoId),
  ],
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
    // Null = the organization's; set = one person's private server (ownership.ts).
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("mcp_servers_scope_idx").on(table.scope),
    index("mcp_servers_repo_url_idx").on(table.repoUrl),
    index("mcp_servers_owner_user_id_idx").on(table.ownerUserId),
  ],
);

// ── Custom Skills ────────────────────────────────────────────────────────────

export const customSkills = pgTable(
  "custom_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    prompt: text("prompt").notNull(), // markdown content (SKILL.md body for skill-dir layout)
    scope: text("scope").notNull().default("global"), // "global" or repo URL
    repoUrl: text("repo_url"), // null = global, set = repo-scoped
    workspaceId: uuid("workspace_id"),
    // Null = the organization's; set = one person's private skill (ownership.ts).
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    // Layout discriminator: "commands" writes .claude/commands/<name>.md (legacy),
    // "skill-dir" writes .claude/skills/<name>/SKILL.md plus any `files`.
    layout: text("layout").notNull().default("commands"),
    // Extra files for skill-dir layout: [{ relativePath, content }].
    // relativePath is resolved under .claude/skills/<name>/.
    files: jsonb("files").$type<Array<{ relativePath: string; content: string }>>(),
    // Agent types this skill applies to. null/empty = all agents.
    agentTypes: jsonb("agent_types").$type<string[]>(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("custom_skills_scope_idx").on(table.scope),
    index("custom_skills_repo_url_idx").on(table.repoUrl),
    index("custom_skills_owner_user_id_idx").on(table.ownerUserId),
  ],
);

// ── Installed Skills (marketplace-sourced) ──────────────────────────────────
//
// Phase 2 of issue #497. Skills installed from a remote source (today: any
// public git URL — e.g. Anthropic's "superpowers" skill from the Claude
// marketplace). The sync worker shallow-clones the source, resolves the ref
// to an immutable SHA, parks the contents in a content-addressable cache PVC,
// and the row records `resolvedSha` for reproducible task runs. Re-syncing
// only when the user advances the ref keeps task setups deterministic.

export const installedSkills = pgTable(
  "installed_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(), // becomes .claude/skills/<name>/ inside the worktree
    description: text("description"),
    sourceType: text("source_type").notNull().default("git"), // "git" only for v1
    sourceUrl: text("source_url").notNull(), // e.g. https://github.com/anthropics/skills.git
    ref: text("ref").notNull().default("main"), // branch/tag the user requested
    resolvedSha: text("resolved_sha"), // pinned commit SHA written by sync worker
    subpath: text("subpath").notNull().default("."), // dir within source to use as the skill
    scope: text("scope").notNull().default("global"), // "global" or repo URL
    repoUrl: text("repo_url"),
    workspaceId: uuid("workspace_id"),
    // Null = the organization's; set = one person's private skill (ownership.ts).
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    agentTypes: jsonb("agent_types").$type<string[]>(), // null/empty = all agents
    enabled: boolean("enabled").notNull().default(true),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncError: text("last_sync_error"),
    cachedManifest: jsonb("cached_manifest"), // SKILL.md frontmatter, file list, etc.
    hasExecutableFiles: boolean("has_executable_files").notNull().default(false),
    totalSizeBytes: integer("total_size_bytes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("installed_skills_scope_idx").on(table.scope),
    index("installed_skills_repo_url_idx").on(table.repoUrl),
    index("installed_skills_resolved_sha_idx").on(table.resolvedSha),
    index("installed_skills_owner_user_id_idx").on(table.ownerUserId),
  ],
);

// ── API Keys (CLI personal access tokens + user-created keys) ─────────────────

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // "CLI (jane-macbook)" or user-set
    prefix: text("prefix").notNull(), // first 12 chars, e.g. "optio_pat_ab"
    hashedKey: text("hashed_key").notNull().unique(), // SHA-256 hex of full token
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("api_keys_user_id_idx").on(table.userId),
    index("api_keys_prefix_idx").on(table.prefix),
  ],
);

// ── Optio Agent Settings (singleton per workspace) ────────────────────────────

export const optioSettings = pgTable(
  "optio_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    model: text("model").notNull().default("opus"), // alias (newest of a family) or a pinned model id
    systemPrompt: text("system_prompt").notNull().default(""), // custom additions appended to base prompt
    enabledTools: jsonb("enabled_tools").$type<string[]>().notNull().default([]), // empty = all enabled
    confirmWrites: boolean("confirm_writes").notNull().default(true),
    maxTurns: integer("max_turns").notNull().default(20),
    // Review-agent defaults applied when a repo doesn't override them.
    // NULL means "fall back to repo's defaultAgentType / catalog default".
    defaultReviewAgentType: text("default_review_agent_type"),
    defaultReviewModel: text("default_review_model"),
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
    // Nullable: NULL rows are operator/legacy actions with no tenant context and
    // are only surfaced to admins by the activity feed (deny-by-default).
    workspaceId: uuid("workspace_id"),
    userId: uuid("user_id").references(() => users.id),
    action: text("action").notNull(), // tool name e.g. "retry_task", "bulk_cancel_active"
    params: jsonb("params").$type<Record<string, unknown>>(), // allowlisted, non-secret tool call parameters
    result: jsonb("result").$type<Record<string, unknown>>(), // outcome: affected IDs, error, etc.
    success: boolean("success").notNull(),
    conversationSnippet: text("conversation_snippet"), // user message that triggered this
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("optio_actions_user_id_idx").on(table.userId),
    index("optio_actions_action_idx").on(table.action),
    index("optio_actions_created_at_idx").on(table.createdAt.desc()),
    index("optio_actions_workspace_id_idx").on(table.workspaceId),
  ],
);

// ── PR Reviews (first-class primitive) ──────────────────────────────────────
//
// External PR reviews are a sibling of Repo Tasks (`tasks`) and Standalone
// Tasks (Jobs, `work_definitions`) — they have their own state machine, their own
// execution runs, their own reconciler, and their own UI at `/reviews`.
//
// `pr_reviews`         canonical review record (one per PR being reviewed)
// `pr_review_runs`     each agent execution: initial, rereview, chat turn
// `pr_review_events`   transition log
// `pr_review_chat_messages`  user ↔ agent conversation after initial review

export const prReviewStateEnum = pgEnum("pr_review_state", [
  "queued",
  "waiting_ci",
  "reviewing",
  "ready",
  "stale",
  "submitted",
  "cancelled",
  "failed",
]);

export const prReviews = pgTable(
  "pr_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id"),
    prUrl: text("pr_url").notNull(),
    prNumber: integer("pr_number").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    repoUrl: text("repo_url").notNull(),
    headSha: text("head_sha").notNull(),
    state: prReviewStateEnum("state").notNull().default("queued"),
    verdict: text("verdict"), // "approve" | "request_changes" | "comment"
    summary: text("summary"),
    fileComments:
      jsonb("file_comments").$type<
        Array<{ path: string; line?: number; side?: string; body: string }>
      >(),
    origin: text("origin").notNull().default("manual"), // "manual" | "auto"
    userEngaged: boolean("user_engaged").notNull().default(false),
    autoSubmitted: boolean("auto_submitted").notNull().default(false),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    createdBy: uuid("created_by"),
    // Control plane — same shape as tasks/workflow_runs.
    controlIntent: text("control_intent"), // "cancel" | "rereview" | null
    reconcileBackoffUntil: timestamp("reconcile_backoff_until", { withTimezone: true }),
    reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pr_reviews_workspace_idx").on(table.workspaceId),
    index("pr_reviews_state_idx").on(table.state),
    index("pr_reviews_pr_url_idx").on(table.prUrl),
    index("pr_reviews_repo_url_idx").on(table.repoUrl),
    index("pr_reviews_updated_idx").on(table.updatedAt.desc()),
  ],
);

export const prReviewRunStateEnum = pgEnum("pr_review_run_state", [
  "queued",
  "provisioning",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const prReviewRuns = pgTable(
  "pr_review_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prReviewId: uuid("pr_review_id")
      .notNull()
      .references(() => prReviews.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("initial"), // "initial" | "rereview" | "chat"
    state: prReviewRunStateEnum("state").notNull().default("queued"),
    prompt: text("prompt"),
    sessionId: text("session_id"),
    resumeSessionId: text("resume_session_id"),
    containerId: text("container_id"),
    podId: uuid("pod_id"),
    lastPodId: uuid("last_pod_id"),
    worktreeState: text("worktree_state"),
    resultSummary: text("result_summary"),
    errorMessage: text("error_message"),
    costUsd: text("cost_usd"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    modelUsed: text("model_used"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pr_review_runs_review_idx").on(table.prReviewId),
    index("pr_review_runs_state_idx").on(table.state),
    index("pr_review_runs_created_idx").on(table.createdAt.desc()),
  ],
);

export const prReviewEvents = pgTable(
  "pr_review_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prReviewId: uuid("pr_review_id")
      .notNull()
      .references(() => prReviews.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => prReviewRuns.id, { onDelete: "set null" }),
    fromState: prReviewStateEnum("from_state"),
    toState: prReviewStateEnum("to_state").notNull(),
    trigger: text("trigger").notNull(),
    message: text("message"),
    userId: uuid("user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("pr_review_events_review_idx").on(table.prReviewId),
    index("pr_review_events_created_idx").on(table.createdAt.desc()),
  ],
);

export const prReviewChatRoleEnum = pgEnum("pr_review_chat_role", ["user", "assistant"]);

export const prReviewChatMessages = pgTable(
  "pr_review_chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    prReviewId: uuid("pr_review_id")
      .notNull()
      .references(() => prReviews.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => prReviewRuns.id, { onDelete: "set null" }),
    role: prReviewChatRoleEnum("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("pr_review_chat_messages_review_idx").on(table.prReviewId, table.createdAt)],
);

// ── Push Subscriptions (Web Push API) ────────────────────────────────────────

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    failureCount: integer("failure_count").notNull().default(0),
  },
  (table) => [
    unique("push_subscriptions_user_endpoint_key").on(table.userId, table.endpoint),
    index("push_subscriptions_user_id_idx").on(table.userId),
  ],
);

// ── APNs (iOS push) ──────────────────────────────────────────────────────────
// Mirrors push_subscriptions: one row per device token, 5 consecutive
// failures (or a 410/Unregistered) drops the row. See docs/ios-push.md.

export const apnsEnvironmentEnum = pgEnum("apns_environment", ["sandbox", "production"]);

export const apnsDevices = pgTable(
  "apns_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id"),
    // Hex device token from UIApplication; globally unique — a token that
    // re-registers under another user moves to them.
    token: text("token").notNull().unique("apns_devices_token_key"),
    platform: text("platform").$type<"ios">().notNull().default("ios"),
    environment: apnsEnvironmentEnum("environment").notNull().default("sandbox"),
    bundleId: text("bundle_id").notNull(),
    appVersion: text("app_version"),
    deviceName: text("device_name"),
    failureCount: integer("failure_count").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("apns_devices_user_id_idx").on(table.userId)],
);

// ActivityKit update tokens (one per running Live Activity per device). `kind`
// is the activity type; only "watch" exists today (one aggregate activity per
// user, docs/design/ios-glanceable-surfaces.md §2a), so subject_id is null.
export const liveActivityTokens = pgTable(
  "live_activity_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"watch">().notNull().default("watch"),
    subjectId: text("subject_id"),
    token: text("token").notNull().unique("live_activity_tokens_token_key"),
    environment: apnsEnvironmentEnum("environment").notNull().default("sandbox"),
    failureCount: integer("failure_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("live_activity_tokens_user_kind_idx").on(table.userId, table.kind)],
);

// ActivityKit push-to-start tokens (one per device per activity type).
export const liveActivityStartTokens = pgTable(
  "live_activity_start_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"watch">().notNull().default("watch"),
    token: text("token").notNull().unique("live_activity_start_tokens_token_key"),
    environment: apnsEnvironmentEnum("environment").notNull().default("sandbox"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("live_activity_start_tokens_user_kind_idx").on(table.userId, table.kind)],
);

// ── FCM (Android push) ───────────────────────────────────────────────────────
// Mirrors apns_devices for the Android app: one row per FCM registration
// token. UNREGISTERED / 404 / an invalid-token INVALID_ARGUMENT drops the row
// at once; 5 consecutive failures drop it. Android has no per-activity tokens,
// so Watch frames go to every row of the user. See docs/android-push.md.

export const fcmDevices = pgTable(
  "fcm_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id"),
    // Opaque, case-sensitive FCM registration token; globally unique — a token
    // that re-registers under another user moves to them.
    token: text("token").notNull().unique("fcm_devices_token_key"),
    // Android application id (`dev.optio.android`); informational.
    appId: text("app_id").notNull(),
    appVersion: text("app_version"),
    deviceName: text("device_name"),
    // The app's own id for this server (its paired-server profile), echoed as
    // `serverId` in every message so a multi-server app can route it.
    clientServerId: text("client_server_id"),
    failureCount: integer("failure_count").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("fcm_devices_user_id_idx").on(table.userId)],
);

// ── Notification Preferences ─────────────────────────────────────────────────

export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id"), // reserved for future per-workspace prefs
    preferences: jsonb("preferences").$type<Record<string, { push: boolean }>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("notification_preferences_user_key").on(table.userId),
    index("notification_preferences_user_id_idx").on(table.userId),
  ],
);

export const promptTemplates = pgTable(
  "prompt_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Unique within its scope (see the index below), not across the instance.
    name: text("name").notNull(),
    template: text("template").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    repoUrl: text("repo_url"), // null = global default, set = repo-specific
    autoMerge: boolean("auto_merge").notNull().default(false),
    workspaceId: uuid("workspace_id"),
    // Null = the organization's; set = one person's private prompt (ownership.ts).
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    // Discriminator: "prompt" (coding template, existing usage)
    //                "review" (review agent template)
    //                "job"    (Job prompt template — previously inline on the Job)
    //                "task"   (Task config template)
    kind: text("kind").notNull().default("prompt"),
    paramsSchema: jsonb("params_schema").$type<Record<string, unknown>>(),
    defaultAgentType: text("default_agent_type"),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("prompt_templates_workspace_id_idx").on(table.workspaceId),
    index("prompt_templates_kind_idx").on(table.kind),
    index("prompt_templates_owner_user_id_idx").on(table.ownerUserId),
    // A name is unique per scope: the organization's in one workspace, or one person's.
    uniqueIndex("prompt_templates_scope_name_key").on(
      sql`COALESCE(${table.workspaceId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`COALESCE(${table.ownerUserId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      table.name,
    ),
  ],
);

// ── Repo Shared Directories (persistent cache) ───────────────────────────────

export const repoSharedDirectories = pgTable(
  "repo_shared_directories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id"),
    name: text("name").notNull(),
    description: text("description"),
    mountLocation: text("mount_location").notNull(), // "workspace" | "home"
    mountSubPath: text("mount_sub_path").notNull(),
    sizeGi: integer("size_gi").notNull().default(10),
    scope: text("scope").notNull().default("per-pod"), // "per-pod" | "per-repo" (future)
    createdBy: uuid("created_by"),
    lastClearedAt: timestamp("last_cleared_at", { withTimezone: true }),
    lastMountedAt: timestamp("last_mounted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("repo_shared_dirs_repo_name_key").on(table.repoId, table.name),
    index("repo_shared_dirs_repo_id_idx").on(table.repoId),
    index("repo_shared_dirs_workspace_idx").on(table.workspaceId),
  ],
);

// ── Persistent Agents ───────────────────────────────────────────────────────────
//
// Long-lived, named, addressable agent processes. Unlike Tasks (Repo or
// Standalone), a Persistent Agent does not terminate after running — it halts
// after each turn and waits to be re-woken by a user message, an agent message,
// a webhook, a cron tick, or a ticket event. State machine is cyclic
// (idle → queued → provisioning → running → idle), with paused/failed/archived
// as terminal-ish branches. See docs/persistent-agents.md.

export const persistentAgentStateEnum = pgEnum("persistent_agent_state", [
  "idle",
  "queued",
  "provisioning",
  "running",
  "paused",
  "failed",
  "archived",
]);

export const persistentAgentPodLifecycleEnum = pgEnum("persistent_agent_pod_lifecycle", [
  "always-on", // pod runs until agent is paused/archived
  "sticky", // pod kept warm for idle_pod_timeout_ms after each turn (default)
  "on-demand", // cold start every turn
]);

export const persistentAgents = pgTable(
  "persistent_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id"),
    slug: text("slug").notNull(), // addressable name, unique within a workspace
    name: text("name").notNull(),
    description: text("description"),
    agentRuntime: text("agent_runtime").notNull().default("claude-code"),
    model: text("model"),
    // Per-turn agent parameters (see work_definitions.agent_options). Null = defaults.
    agentOptions: jsonb("agent_options").$type<Record<string, string | boolean>>(),
    systemPrompt: text("system_prompt"),
    // Operator manual: "how to use the optio agent CLI/MCP". Injected into the
    // prompt at turn-start. Mirrors Scion's per-template agents.md.
    agentsMd: text("agents_md"),
    // First turn's prompt — used when the agent has never run before, or when
    // restarted from scratch.
    initialPrompt: text("initial_prompt").notNull(),
    promptTemplateId: uuid("prompt_template_id").references(() => promptTemplates.id),
    // Repo mode (optional). When set, agent gets a long-lived worktree.
    repoId: uuid("repo_id").references(() => repos.id, { onDelete: "set null" }),
    branch: text("branch"),
    worktreePath: text("worktree_path"),
    podLifecycle: persistentAgentPodLifecycleEnum("pod_lifecycle").notNull().default("sticky"),
    idlePodTimeoutMs: integer("idle_pod_timeout_ms").notNull().default(300000),
    // Affinity for sticky/always-on modes — the last pod assigned. The pool
    // service prefers this pod when ready and within warm window.
    stickyPodId: uuid("sticky_pod_id"),
    maxTurnDurationMs: integer("max_turn_duration_ms").notNull().default(600000),
    maxTurns: integer("max_turns").notNull().default(50),
    consecutiveFailureLimit: integer("consecutive_failure_limit").notNull().default(3),
    state: persistentAgentStateEnum("state").notNull().default("idle"),
    enabled: boolean("enabled").notNull().default(true),
    totalCostUsd: text("total_cost_usd").notNull().default("0"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    lastFailureReason: text("last_failure_reason"),
    lastTurnAt: timestamp("last_turn_at", { withTimezone: true }),
    // Native runtime session id used to resume conversation context across
    // turns (e.g. claude --resume <id>). Cleared on archive/restart.
    sessionId: text("session_id"),
    controlIntent: text("control_intent"), // "pause" | "resume" | "archive" | "restart" | null
    reconcileBackoffUntil: timestamp("reconcile_backoff_until", { withTimezone: true }),
    reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
    // Who the work belongs to (null = the organization) and the secrets its
    // pod gets by name (null = the workspace's legacy behavior).
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    podSecrets: jsonb("pod_secrets").$type<string[]>(),
    // What the work changes about the repo's / workspace's agent environment
    // (null = the defaults; packages/shared/src/work/settings.ts).
    settings: jsonb("settings").$type<WorkSettings>(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("persistent_agents_workspace_slug_key").on(table.workspaceId, table.slug),
    index("persistent_agents_workspace_id_idx").on(table.workspaceId),
    index("persistent_agents_state_idx").on(table.state),
    index("persistent_agents_repo_id_idx").on(table.repoId),
  ],
);

export const persistentAgentTurnHaltReasonEnum = pgEnum("persistent_agent_turn_halt_reason", [
  "natural",
  "wait_tool",
  "max_duration",
  "max_turns",
  "error",
  "cancelled",
]);

export const persistentAgentTurns = pgTable(
  "persistent_agent_turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => persistentAgents.id, { onDelete: "cascade" }),
    turnNumber: integer("turn_number").notNull(),
    // 'user' | 'agent' | 'webhook' | 'schedule' | 'ticket' | 'system' | 'initial'
    wakeSource: text("wake_source").notNull(),
    // Drained messages and trigger payload that produced this turn's prompt.
    wakePayload: jsonb("wake_payload").$type<Record<string, unknown>>(),
    promptUsed: text("prompt_used"),
    podId: uuid("pod_id"),
    podName: text("pod_name"),
    haltReason: persistentAgentTurnHaltReasonEnum("halt_reason"),
    errorMessage: text("error_message"),
    costUsd: text("cost_usd"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    sessionId: text("session_id"),
    summary: text("summary"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("persistent_agent_turns_agent_turn_key").on(table.agentId, table.turnNumber),
    index("persistent_agent_turns_agent_id_idx").on(table.agentId),
  ],
);

export const persistentAgentMessageSenderTypeEnum = pgEnum("persistent_agent_message_sender_type", [
  "user",
  "agent",
  "system",
  "external",
]);

export const persistentAgentMessages = pgTable(
  "persistent_agent_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => persistentAgents.id, { onDelete: "cascade" }),
    senderType: persistentAgentMessageSenderTypeEnum("sender_type").notNull(),
    // For user → users.id; agent → "<workspace>/<slug>"; system/external → free-form label.
    senderId: text("sender_id"),
    senderName: text("sender_name"),
    body: text("body").notNull(),
    structuredPayload: jsonb("structured_payload").$type<Record<string, unknown>>(),
    broadcasted: boolean("broadcasted").notNull().default(false),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    // Set when drained into a turn's wakePayload. Null = pending in inbox.
    processedAt: timestamp("processed_at", { withTimezone: true }),
    turnId: uuid("turn_id").references(() => persistentAgentTurns.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("persistent_agent_messages_inbox_idx").on(table.agentId, table.processedAt),
    index("persistent_agent_messages_received_idx").on(table.agentId, table.receivedAt),
    index("persistent_agent_messages_turn_idx").on(table.turnId),
  ],
);

// ── Optio Local (terminals on a user's own machine) ─────────────────────────
// See docs/optio-local.md. Hosts are personal: bound to the registering user,
// never shared workspace compute. Scrollback stays in the daemon; the DB holds
// metadata plus a throttled ANSI-stripped preview for the wall view.

export const localHostStateEnum = pgEnum("local_host_state", ["online", "offline"]);

export const localHosts = pgTable(
  "local_hosts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable: auth-disabled dev/e2e has no user rows (mirrors interactive_sessions).
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id"),
    name: text("name").notNull(),
    hostname: text("hostname").notNull(),
    platform: text("platform").notNull(),
    arch: text("arch"),
    daemonVersion: text("daemon_version"),
    dirs: jsonb("dirs").$type<Array<{ path: string; repoUrl?: string }>>().notNull().default([]),
    // Agent subscription limits the daemon read off the machine (Codex session logs).
    agentLimits: jsonb("agent_limits").$type<{
      codex?: {
        primary: {
          usedPercent: number;
          windowMinutes: number | null;
          resetsAt: string | null;
        } | null;
        secondary: {
          usedPercent: number;
          windowMinutes: number | null;
          resetsAt: string | null;
        } | null;
        planType: string | null;
        observedAt: string;
      };
    } | null>(),
    // AWS profile names on the machine (for model providers), as its daemon
    // last reported them. Null until a daemon that reports them connects.
    awsProfiles: jsonb("aws_profiles").$type<string[]>(),
    // The models the machine's agent CLIs offer (Codex's own catalog), read by
    // the daemon; merged into the model and effort pickers.
    agentModels: jsonb("agent_models").$type<{
      codex?: {
        models: Array<{
          id: string;
          label: string;
          description?: string;
          efforts: string[];
          defaultEffort: string | null;
        }>;
        fetchedAt: string;
      };
    } | null>(),
    state: localHostStateEnum("state").notNull().default("offline"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("local_hosts_user_hostname_key").on(table.userId, table.hostname),
    index("local_hosts_user_id_idx").on(table.userId),
  ],
);

export const localTerminalStateEnum = pgEnum("local_terminal_state", [
  "pending",
  "launching",
  "running",
  "exited",
  "error",
]);

export const localAttentionStateEnum = pgEnum("local_attention_state", [
  "working",
  "needs_you",
  "idle",
]);

export const localTerminals = pgTable(
  "local_terminals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hostId: uuid("host_id")
      .notNull()
      .references(() => localHosts.id, { onDelete: "cascade" }),
    // Nullable: auth-disabled dev/e2e has no user rows (mirrors interactive_sessions).
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id"),
    title: text("title").notNull(),
    dir: text("dir").notNull(),
    // Display-only rendering of what runs; the daemon executes `spec`.
    command: text("command"),
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    state: localTerminalStateEnum("state").notNull().default("pending"),
    pendingReason: text("pending_reason").$type<"hold" | "host_offline">(),
    exitCode: integer("exit_code"),
    errorMessage: text("error_message"),
    attentionState: localAttentionStateEnum("attention_state").notNull().default("idle"),
    attentionReason: text("attention_reason"),
    spawnedBy: text("spawned_by")
      .$type<"manual" | "ticket" | "trigger" | "blueprint" | "api" | "resume" | "job" | "task">()
      .notNull()
      .default("manual"),
    // The Local automation (work_definitions) that spawned it. Soft pointer.
    blueprintId: uuid("blueprint_id"),
    triggerId: uuid("trigger_id"),
    // Back-links for terminals that execute a Job run / Repo Task whose run
    // location is this host (spawned_by = "job" | "task"). Soft pointers —
    // tasks / workflow_runs point back via local_terminal_id.
    workflowRunId: uuid("workflow_run_id"),
    taskId: uuid("task_id"),
    ticketSource: text("ticket_source"),
    ticketExternalId: text("ticket_external_id"),
    ticketUrl: text("ticket_url"),
    // The agent CLI's own session id (Claude Code hooks' `session_id`), so an
    // exited run can be resumed as an interactive chat (`claude --resume`).
    agentSessionId: text("agent_session_id"),
    preview: text("preview"),
    // PR / ticket links the daemon extracted from the output, first-seen order.
    links: jsonb("links")
      .$type<
        Array<{
          url: string;
          kind: "pr" | "issue" | "ref";
          provider: "github" | "gitlab" | "linear" | "jira";
          label: string;
        }>
      >()
      .notNull()
      .default([]),
    // Token / cost totals the daemon summed from the agent's transcript.
    usage: jsonb("usage").$type<{
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      turns: number;
      model: string | null;
      costUsd: number | null;
      updatedAt: string;
    } | null>(),
    costUsd: text("cost_usd"),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    // When a person last typed into it (throttled): the rail's order.
    lastInteractedAt: timestamp("last_interacted_at", { withTimezone: true }),
    // "Later": while in the future the terminal is out of the needs-you queue.
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    index("local_terminals_host_id_idx").on(table.hostId),
    index("local_terminals_user_state_idx").on(table.userId, table.state),
    index("local_terminals_created_at_idx").on(table.createdAt.desc()),
    index("local_terminals_workflow_run_id_idx").on(table.workflowRunId),
    index("local_terminals_task_id_idx").on(table.taskId),
  ],
);

// The final screen of an exited terminal: the tail of the daemon's output
// ring as raw bytes plus the PTY grid it was laid out for, so opening a
// finished session replays what was on screen at the size it ran at
// (scrollback otherwise dies with the PTY). Its own table keeps the
// terminal row — and every list response — free of a few hundred KB.
export const localTerminalSnapshots = pgTable("local_terminal_snapshots", {
  terminalId: uuid("terminal_id")
    .primaryKey()
    .references(() => localTerminals.id, { onDelete: "cascade" }),
  data: bytea("data").notNull(),
  cols: integer("cols").notNull(),
  rows: integer("rows").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The conversation behind an agent session (Optio Local), distilled by the
 * daemon from the agent CLI's transcript. One row per entry, keyed by the
 * daemon's per-terminal `seq` so re-sent batches are idempotent. Own table:
 * a long session is thousands of rows that no list endpoint should carry.
 */
export const localTerminalTranscripts = pgTable(
  "local_terminal_transcripts",
  {
    terminalId: uuid("terminal_id")
      .notNull()
      .references(() => localTerminals.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role").notNull(), // user | assistant | tool | system
    kind: text("kind").notNull(), // text | thinking | tool_use | tool_result
    // prompt | task | agent | compact | interrupt | rewind | other (LocalTranscriptSource)
    source: text("source"),
    text: text("text").notNull(),
    detail: text("detail"),
    toolName: text("tool_name"),
    toolUseId: text("tool_use_id"),
    isError: boolean("is_error").notNull().default(false),
    at: timestamp("at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.terminalId, table.seq] })],
);
