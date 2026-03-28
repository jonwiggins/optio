/**
 * Optio tool definitions for AI agents.
 *
 * Each tool maps to one or more Optio API endpoints. These schemas are
 * compatible with both Claude and OpenAI function-calling formats.
 *
 * The agent makes direct HTTP calls to the API server using these definitions.
 * Auth is handled via passthrough — the requesting user's session token is
 * injected as a cookie/header on every call.
 */

export interface OptioToolParameter {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  items?: { type: string };
}

export interface OptioToolDefinition {
  name: string;
  description: string;
  category: "tasks" | "repos" | "issues" | "pods" | "costs" | "system" | "watch";
  parameters: {
    type: "object";
    properties: Record<string, OptioToolParameter>;
    required?: string[];
  };
  /** The HTTP method and path template for the primary API call. */
  endpoint: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
  };
  /** If true, this tool uses polling rather than a single API call. */
  isPolling?: boolean;
}

// ---------------------------------------------------------------------------
// Task tools
// ---------------------------------------------------------------------------

const listTasks: OptioToolDefinition = {
  name: "list_tasks",
  description:
    "List tasks with optional filters. Returns tasks sorted by creation date (newest first). " +
    "Use the state filter to find running, failed, queued, or completed tasks.",
  category: "tasks",
  parameters: {
    type: "object",
    properties: {
      state: {
        type: "string",
        description: "Filter by task state",
        enum: [
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
        ],
      },
      limit: {
        type: "number",
        description: "Maximum number of tasks to return (1-1000)",
        default: 50,
        minimum: 1,
        maximum: 1000,
      },
      offset: {
        type: "number",
        description: "Number of tasks to skip for pagination",
        default: 0,
        minimum: 0,
      },
    },
  },
  endpoint: { method: "GET", path: "/api/tasks" },
};

const getTask: OptioToolDefinition = {
  name: "get_task",
  description:
    "Get detailed information about a specific task including PR status, error info, " +
    "retry count, cost, and pipeline progress.",
  category: "tasks",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The task UUID",
      },
    },
    required: ["id"],
  },
  endpoint: { method: "GET", path: "/api/tasks/:id" },
};

const createTask: OptioToolDefinition = {
  name: "create_task",
  description:
    "Create a new task. The task will be queued and picked up by an available agent pod. " +
    "Requires a title, prompt (the instructions for the agent), repository URL, and agent type.",
  category: "tasks",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short title for the task",
      },
      prompt: {
        type: "string",
        description: "Detailed instructions for the agent to execute",
      },
      repoUrl: {
        type: "string",
        description: "The repository URL (e.g. https://github.com/owner/repo)",
      },
      repoBranch: {
        type: "string",
        description: "Target branch (defaults to repo default branch)",
      },
      agentType: {
        type: "string",
        description: "The agent runtime to use",
        enum: ["claude-code", "codex"],
      },
      priority: {
        type: "number",
        description: "Priority (lower = higher priority, 1-1000)",
        minimum: 1,
        maximum: 1000,
      },
      maxRetries: {
        type: "number",
        description: "Maximum number of automatic retries on failure (0-10)",
        minimum: 0,
        maximum: 10,
      },
    },
    required: ["title", "prompt", "repoUrl", "agentType"],
  },
  endpoint: { method: "POST", path: "/api/tasks" },
};

const retryTask: OptioToolDefinition = {
  name: "retry_task",
  description:
    "Retry a failed or cancelled task. The task will be re-queued with a fresh agent session.",
  category: "tasks",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The task UUID to retry",
      },
    },
    required: ["id"],
  },
  endpoint: { method: "POST", path: "/api/tasks/:id/retry" },
};

const cancelTask: OptioToolDefinition = {
  name: "cancel_task",
  description: "Cancel a running or queued task. The agent process will be terminated.",
  category: "tasks",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The task UUID to cancel",
      },
    },
    required: ["id"],
  },
  endpoint: { method: "POST", path: "/api/tasks/:id/cancel" },
};

const bulkRetryFailed: OptioToolDefinition = {
  name: "bulk_retry_failed",
  description:
    "Retry all failed tasks in the workspace. Returns the count of tasks that were re-queued.",
  category: "tasks",
  parameters: {
    type: "object",
    properties: {},
  },
  endpoint: { method: "POST", path: "/api/tasks/bulk/retry-failed" },
};

const bulkCancelActive: OptioToolDefinition = {
  name: "bulk_cancel_active",
  description:
    "Cancel all running and queued tasks in the workspace. Returns the count of tasks cancelled.",
  category: "tasks",
  parameters: {
    type: "object",
    properties: {},
  },
  endpoint: { method: "POST", path: "/api/tasks/bulk/cancel-active" },
};

const getTaskLogs: OptioToolDefinition = {
  name: "get_task_logs",
  description:
    "Get logs for a specific task. Logs can be large — use the tail parameter to get " +
    "only the most recent entries, and logType to filter by category. " +
    "Returns a summary line showing how many total logs exist.",
  category: "tasks",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The task UUID",
      },
      tail: {
        type: "number",
        description: "Number of most recent log entries to return (default: 100)",
        default: 100,
        minimum: 1,
        maximum: 1000,
      },
      logType: {
        type: "string",
        description: "Filter by log type",
        enum: ["text", "tool_use", "tool_result", "thinking", "system", "error", "info"],
      },
      search: {
        type: "string",
        description: "Search string to filter log content",
      },
    },
    required: ["id"],
  },
  endpoint: { method: "GET", path: "/api/tasks/:id/logs" },
};

// ---------------------------------------------------------------------------
// Repo tools
// ---------------------------------------------------------------------------

const listRepos: OptioToolDefinition = {
  name: "list_repos",
  description: "List all configured repositories in the workspace with their settings and status.",
  category: "repos",
  parameters: {
    type: "object",
    properties: {},
  },
  endpoint: { method: "GET", path: "/api/repos" },
};

const getRepo: OptioToolDefinition = {
  name: "get_repo",
  description:
    "Get detailed information about a repository including its settings, " +
    "pod status, concurrency limits, model configuration, and review settings.",
  category: "repos",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The repository UUID",
      },
    },
    required: ["id"],
  },
  endpoint: { method: "GET", path: "/api/repos/:id" },
};

const updateRepoSettings: OptioToolDefinition = {
  name: "update_repo_settings",
  description:
    "Update repository settings such as concurrency limits, model, review configuration, " +
    "auto-merge, and more. Only include the fields you want to change.",
  category: "repos",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The repository UUID",
      },
      maxConcurrentTasks: {
        type: "number",
        description: "Maximum concurrent tasks for this repo (1-50)",
        minimum: 1,
        maximum: 50,
      },
      maxPodInstances: {
        type: "number",
        description: "Maximum pod replicas for this repo (1-20)",
        minimum: 1,
        maximum: 20,
      },
      maxAgentsPerPod: {
        type: "number",
        description: "Maximum concurrent agents per pod (1-50)",
        minimum: 1,
        maximum: 50,
      },
      claudeModel: {
        type: "string",
        description: "Claude model to use (e.g. sonnet, opus, haiku)",
      },
      claudeContextWindow: {
        type: "string",
        description: "Context window size",
        enum: ["default", "1m"],
      },
      claudeThinking: {
        type: "boolean",
        description: "Enable extended thinking mode",
      },
      claudeEffort: {
        type: "string",
        description: "Effort level for the agent",
        enum: ["low", "medium", "high"],
      },
      autoMerge: {
        type: "boolean",
        description: "Auto-merge PRs when CI passes and reviews approved",
      },
      reviewEnabled: {
        type: "boolean",
        description: "Enable automatic code review agent",
      },
      reviewTrigger: {
        type: "string",
        description: "When to trigger the review agent",
        enum: ["on_ci_pass", "on_pr"],
      },
      autoResume: {
        type: "boolean",
        description: "Auto-resume agent when reviewer requests changes",
      },
    },
    required: ["id"],
  },
  endpoint: { method: "PATCH", path: "/api/repos/:id" },
};

// ---------------------------------------------------------------------------
// Issue tools
// ---------------------------------------------------------------------------

const listIssues: OptioToolDefinition = {
  name: "list_issues",
  description:
    "List GitHub Issues across configured repositories. Useful for finding work to assign to agents.",
  category: "issues",
  parameters: {
    type: "object",
    properties: {
      repoUrl: {
        type: "string",
        description: "Filter by repository URL",
      },
    },
  },
  endpoint: { method: "GET", path: "/api/issues" },
};

const assignIssue: OptioToolDefinition = {
  name: "assign_issue",
  description:
    "Assign a GitHub Issue to Optio, creating a task from it. The issue title and body " +
    "become the task prompt.",
  category: "issues",
  parameters: {
    type: "object",
    properties: {
      repoUrl: {
        type: "string",
        description: "The repository URL containing the issue",
      },
      issueNumber: {
        type: "number",
        description: "The GitHub Issue number",
      },
    },
    required: ["repoUrl", "issueNumber"],
  },
  endpoint: { method: "POST", path: "/api/issues/assign" },
};

// ---------------------------------------------------------------------------
// Pod tools
// ---------------------------------------------------------------------------

const listPods: OptioToolDefinition = {
  name: "list_pods",
  description:
    "List all repo pods in the cluster with their status, active task count, " +
    "and resource usage. Requires admin role.",
  category: "pods",
  parameters: {
    type: "object",
    properties: {},
  },
  endpoint: { method: "GET", path: "/api/cluster/pods" },
};

const getPodHealth: OptioToolDefinition = {
  name: "get_pod_health",
  description:
    "Get detailed health information for a specific pod including recent health events, " +
    "K8s status, resource usage, and associated tasks. Requires admin role.",
  category: "pods",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The repo pod UUID",
      },
    },
    required: ["id"],
  },
  endpoint: { method: "GET", path: "/api/cluster/pods/:id" },
};

// ---------------------------------------------------------------------------
// Cost tools
// ---------------------------------------------------------------------------

const getCostAnalytics: OptioToolDefinition = {
  name: "get_cost_analytics",
  description:
    "Get cost analytics including total spend, daily breakdown, cost by repo, " +
    "cost by task type, top expensive tasks, and trend compared to previous period.",
  category: "costs",
  parameters: {
    type: "object",
    properties: {
      days: {
        type: "number",
        description: "Number of days to analyze (1-365, default: 30)",
        default: 30,
        minimum: 1,
        maximum: 365,
      },
      repoUrl: {
        type: "string",
        description: "Filter to a specific repository",
      },
    },
  },
  endpoint: { method: "GET", path: "/api/analytics/costs" },
};

// ---------------------------------------------------------------------------
// System tools
// ---------------------------------------------------------------------------

const getSystemStatus: OptioToolDefinition = {
  name: "get_system_status",
  description:
    "Get an aggregate system health summary including task counts by state, " +
    "pod health, queue depth, today's cost, and any active alerts " +
    "(recent OOM kills, auth errors, etc.).",
  category: "system",
  parameters: {
    type: "object",
    properties: {},
  },
  endpoint: { method: "GET", path: "/api/optio/system-status" },
};

// ---------------------------------------------------------------------------
// Watch tools
// ---------------------------------------------------------------------------

const watchTask: OptioToolDefinition = {
  name: "watch_task",
  description:
    "Poll a task until it reaches a terminal state (completed, failed, cancelled, pr_opened). " +
    "Reports the final status. Useful for waiting on a task you just created or retried. " +
    "This is a polling operation — the agent will check the task status at regular intervals.",
  category: "watch",
  isPolling: true,
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The task UUID to watch",
      },
      timeoutSeconds: {
        type: "number",
        description: "Maximum time to wait in seconds (default: 600 = 10 minutes)",
        default: 600,
        minimum: 10,
        maximum: 3600,
      },
      pollIntervalSeconds: {
        type: "number",
        description: "How often to check status in seconds (default: 10)",
        default: 10,
        minimum: 5,
        maximum: 60,
      },
    },
    required: ["id"],
  },
  endpoint: { method: "GET", path: "/api/tasks/:id" },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * All Optio tool definitions, keyed by tool name.
 */
export const OPTIO_TOOLS: Record<string, OptioToolDefinition> = {
  list_tasks: listTasks,
  get_task: getTask,
  create_task: createTask,
  retry_task: retryTask,
  cancel_task: cancelTask,
  bulk_retry_failed: bulkRetryFailed,
  bulk_cancel_active: bulkCancelActive,
  get_task_logs: getTaskLogs,
  list_repos: listRepos,
  get_repo: getRepo,
  update_repo_settings: updateRepoSettings,
  list_issues: listIssues,
  assign_issue: assignIssue,
  list_pods: listPods,
  get_pod_health: getPodHealth,
  get_cost_analytics: getCostAnalytics,
  get_system_status: getSystemStatus,
  watch_task: watchTask,
};

/**
 * Get all tool definitions as an array, suitable for injecting into an
 * agent's system prompt or function-calling config.
 */
export function getOptioToolDefinitions(): OptioToolDefinition[] {
  return Object.values(OPTIO_TOOLS);
}

/**
 * Get tool definitions for a specific category.
 */
export function getOptioToolsByCategory(
  category: OptioToolDefinition["category"],
): OptioToolDefinition[] {
  return Object.values(OPTIO_TOOLS).filter((t) => t.category === category);
}

/**
 * Convert Optio tool definitions to the Claude/OpenAI function-calling format.
 * Strips Optio-specific fields (endpoint, isPolling, category) and returns
 * the standard { name, description, parameters } shape.
 */
export function toFunctionCallingFormat(
  tools: OptioToolDefinition[],
): Array<{ name: string; description: string; parameters: OptioToolDefinition["parameters"] }> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/** Terminal states where watch_task stops polling. */
export const WATCH_TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "pr_opened"]);

/**
 * Maximum length for individual log entry content when returned via
 * the get_task_logs tool. Longer entries are truncated with a suffix.
 */
export const LOG_ENTRY_MAX_LENGTH = 2000;
