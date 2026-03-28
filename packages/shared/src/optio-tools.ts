/**
 * Optio tool definitions for AI agent function calling.
 *
 * Each tool maps to one or more Optio API endpoints. The schemas are
 * compatible with both Claude and OpenAI/Codex function-calling formats.
 *
 * The agent makes direct HTTP calls to the API server — no MCP wrapping.
 */

/** JSON Schema representation of a tool parameter. */
export interface ToolParameterSchema {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  items?: ToolParameterSchema;
}

/** Standard tool definition compatible with Claude and Codex function calling. */
export interface OptioToolSchema {
  name: string;
  description: string;
  category: string;
  /** The API endpoint(s) this tool maps to. */
  endpoint: string;
  /** HTTP method for the primary endpoint. */
  method: "GET" | "POST" | "PATCH" | "DELETE";
  input_schema: {
    type: "object";
    properties: Record<string, ToolParameterSchema>;
    required?: string[];
  };
}

// ─── Task Tools ─────────────────────────────────────────────────────────────

const list_tasks: OptioToolSchema = {
  name: "list_tasks",
  description:
    "List tasks with optional filters. Returns tasks sorted by most recent first. " +
    "Supports filtering by state, repository, and date range.",
  category: "Tasks",
  endpoint: "GET /api/tasks",
  method: "GET",
  input_schema: {
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
      repoUrl: {
        type: "string",
        description: "Filter by repository URL",
      },
      limit: {
        type: "number",
        description: "Maximum number of tasks to return",
        default: 20,
        minimum: 1,
        maximum: 100,
      },
      offset: {
        type: "number",
        description: "Number of tasks to skip for pagination",
        default: 0,
        minimum: 0,
      },
    },
  },
};

const get_task: OptioToolSchema = {
  name: "get_task",
  description:
    "Get detailed information about a specific task including its current state, " +
    "PR status, error information, cost, and model used.",
  category: "Tasks",
  endpoint: "GET /api/tasks/:id",
  method: "GET",
  input_schema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The task UUID",
      },
    },
    required: ["id"],
  },
};

const create_task: OptioToolSchema = {
  name: "create_task",
  description:
    "Create a new coding task. The task will be queued and assigned to an agent pod. " +
    "Requires a title, repository URL, and prompt describing what to do.",
  category: "Tasks",
  endpoint: "POST /api/tasks",
  method: "POST",
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short title describing the task",
      },
      repoUrl: {
        type: "string",
        description: "Repository URL (e.g., https://github.com/owner/repo)",
      },
      prompt: {
        type: "string",
        description: "Detailed prompt/instructions for the agent",
      },
      priority: {
        type: "number",
        description: "Priority (lower = higher priority). Default is 100.",
        default: 100,
        minimum: 1,
      },
      repoBranch: {
        type: "string",
        description: "Base branch to work from. Defaults to repo's default branch.",
      },
    },
    required: ["title", "repoUrl", "prompt"],
  },
};

const retry_task: OptioToolSchema = {
  name: "retry_task",
  description:
    "Retry a failed or cancelled task. Resets the task state and re-queues it for execution.",
  category: "Tasks",
  endpoint: "POST /api/tasks/:id/retry",
  method: "POST",
  input_schema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The task UUID to retry",
      },
    },
    required: ["id"],
  },
};

const cancel_task: OptioToolSchema = {
  name: "cancel_task",
  description: "Cancel a running, queued, or provisioning task.",
  category: "Tasks",
  endpoint: "POST /api/tasks/:id/cancel",
  method: "POST",
  input_schema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The task UUID to cancel",
      },
    },
    required: ["id"],
  },
};

const bulk_retry_failed: OptioToolSchema = {
  name: "bulk_retry_failed",
  description: "Retry all tasks that are currently in the failed state.",
  category: "Tasks",
  endpoint: "POST /api/tasks/bulk/retry-failed",
  method: "POST",
  input_schema: {
    type: "object",
    properties: {},
  },
};

const bulk_cancel_active: OptioToolSchema = {
  name: "bulk_cancel_active",
  description: "Cancel all tasks that are currently running or queued.",
  category: "Tasks",
  endpoint: "POST /api/tasks/bulk/cancel-active",
  method: "POST",
  input_schema: {
    type: "object",
    properties: {},
  },
};

const get_task_logs: OptioToolSchema = {
  name: "get_task_logs",
  description:
    "Get logs for a specific task. Returns a summary line and the most recent log entries. " +
    "Supports filtering by log type and limiting the number of entries returned. " +
    "Individual log entries are truncated if they exceed 2000 characters.",
  category: "Tasks",
  endpoint: "GET /api/tasks/:id/logs",
  method: "GET",
  input_schema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The task UUID",
      },
      tail: {
        type: "number",
        description: "Number of most recent log entries to return",
        default: 100,
        minimum: 1,
        maximum: 500,
      },
      logType: {
        type: "string",
        description: "Filter by log type",
        enum: ["text", "tool_use", "tool_result", "thinking", "system", "error", "info"],
      },
    },
    required: ["id"],
  },
};

// ─── Repo Tools ─────────────────────────────────────────────────────────────

const list_repos: OptioToolSchema = {
  name: "list_repos",
  description:
    "List all configured repositories with their settings, including concurrency limits, " +
    "model configuration, and review settings.",
  category: "Repos",
  endpoint: "GET /api/repos",
  method: "GET",
  input_schema: {
    type: "object",
    properties: {},
  },
};

const get_repo: OptioToolSchema = {
  name: "get_repo",
  description:
    "Get detailed information about a specific repository including its settings, " +
    "pod status, and configuration.",
  category: "Repos",
  endpoint: "GET /api/repos/:id",
  method: "GET",
  input_schema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The repository UUID",
      },
    },
    required: ["id"],
  },
};

const update_repo_settings: OptioToolSchema = {
  name: "update_repo_settings",
  description:
    "Update settings for a repository. Can modify concurrency limits, model configuration, " +
    "review settings, auto-merge, and more.",
  category: "Repos",
  endpoint: "PATCH /api/repos/:id",
  method: "PATCH",
  input_schema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The repository UUID",
      },
      maxConcurrentTasks: {
        type: "number",
        description: "Maximum concurrent tasks for this repo",
        minimum: 1,
        maximum: 50,
      },
      maxPodInstances: {
        type: "number",
        description: "Maximum pod replicas for this repo",
        minimum: 1,
        maximum: 20,
      },
      maxAgentsPerPod: {
        type: "number",
        description: "Maximum concurrent agents per pod",
        minimum: 1,
        maximum: 50,
      },
      claudeModel: {
        type: "string",
        description: "Claude model to use for coding tasks",
        enum: ["opus", "sonnet", "haiku"],
      },
      reviewEnabled: {
        type: "boolean",
        description: "Enable automatic code review",
      },
      autoMerge: {
        type: "boolean",
        description: "Enable auto-merge when CI passes and review is approved",
      },
      autoResume: {
        type: "boolean",
        description: "Enable auto-resume when reviewer requests changes",
      },
    },
    required: ["id"],
  },
};

// ─── Issue Tools ────────────────────────────────────────────────────────────

const list_issues: OptioToolSchema = {
  name: "list_issues",
  description: "List GitHub issues across configured repositories. Can filter by repository URL.",
  category: "Issues",
  endpoint: "GET /api/issues",
  method: "GET",
  input_schema: {
    type: "object",
    properties: {
      repoUrl: {
        type: "string",
        description: "Filter issues by repository URL",
      },
    },
  },
};

const assign_issue: OptioToolSchema = {
  name: "assign_issue",
  description:
    "Assign a GitHub issue to Optio, creating a task from it. The issue title and body " +
    "become the task title and prompt.",
  category: "Issues",
  endpoint: "POST /api/issues/assign",
  method: "POST",
  input_schema: {
    type: "object",
    properties: {
      repoUrl: {
        type: "string",
        description: "Repository URL the issue belongs to",
      },
      issueNumber: {
        type: "number",
        description: "The GitHub issue number",
      },
    },
    required: ["repoUrl", "issueNumber"],
  },
};

// ─── Pod / Cluster Tools ────────────────────────────────────────────────────

const list_pods: OptioToolSchema = {
  name: "list_pods",
  description:
    "List all active repo pods with their status, active task count, and health information.",
  category: "Pods",
  endpoint: "GET /api/cluster",
  method: "GET",
  input_schema: {
    type: "object",
    properties: {},
  },
};

const get_pod_health: OptioToolSchema = {
  name: "get_pod_health",
  description:
    "Get detailed health information for a specific pod including recent health events, " +
    "resource usage, and running tasks.",
  category: "Pods",
  endpoint: "GET /api/cluster/:id",
  method: "GET",
  input_schema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The pod UUID (from repo_pods table)",
      },
    },
    required: ["id"],
  },
};

// ─── Cost Tools ─────────────────────────────────────────────────────────────

const get_cost_analytics: OptioToolSchema = {
  name: "get_cost_analytics",
  description:
    "Get cost analytics including total spend, daily breakdown, cost by repo, " +
    "cost by task type, and top expensive tasks.",
  category: "Costs",
  endpoint: "GET /api/analytics/costs",
  method: "GET",
  input_schema: {
    type: "object",
    properties: {
      days: {
        type: "number",
        description: "Number of days to look back",
        default: 30,
        minimum: 1,
        maximum: 365,
      },
      repoUrl: {
        type: "string",
        description: "Filter costs by repository URL",
      },
    },
  },
};

// ─── System Tools ───────────────────────────────────────────────────────────

const get_system_status: OptioToolSchema = {
  name: "get_system_status",
  description:
    "Get an aggregate system health summary including task counts by state, " +
    "pod health, queue depth, today's cost, and any active alerts " +
    "(recent OOM kills, auth errors, etc.).",
  category: "System",
  endpoint: "GET /api/optio/system-status",
  method: "GET",
  input_schema: {
    type: "object",
    properties: {},
  },
};

// ─── Watch Tool ─────────────────────────────────────────────────────────────

const watch_task: OptioToolSchema = {
  name: "watch_task",
  description:
    "Watch a task until it reaches a terminal state (completed, failed, cancelled). " +
    "Polls the task status at a configurable interval and returns the final state. " +
    "This is a long-running operation with a configurable timeout.",
  category: "Tasks",
  endpoint: "GET /api/tasks/:id",
  method: "GET",
  input_schema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The task UUID to watch",
      },
      pollIntervalSeconds: {
        type: "number",
        description: "Seconds between status checks",
        default: 10,
        minimum: 5,
        maximum: 60,
      },
      timeoutMinutes: {
        type: "number",
        description: "Maximum minutes to watch before giving up",
        default: 10,
        minimum: 1,
        maximum: 60,
      },
    },
    required: ["id"],
  },
};

// ─── Exports ────────────────────────────────────────────────────────────────

/** All 18 Optio tool definitions. */
export const OPTIO_TOOL_SCHEMAS: OptioToolSchema[] = [
  // Tasks (8)
  list_tasks,
  get_task,
  create_task,
  retry_task,
  cancel_task,
  bulk_retry_failed,
  bulk_cancel_active,
  get_task_logs,
  // Repos (3)
  list_repos,
  get_repo,
  update_repo_settings,
  // Issues (2)
  list_issues,
  assign_issue,
  // Pods (2)
  list_pods,
  get_pod_health,
  // Costs (1)
  get_cost_analytics,
  // System (1)
  get_system_status,
  // Watch (1)
  watch_task,
];

/** Map of tool name to schema for quick lookup. */
export const OPTIO_TOOL_MAP: Record<string, OptioToolSchema> = Object.fromEntries(
  OPTIO_TOOL_SCHEMAS.map((t) => [t.name, t]),
);

/** All tool names as a flat array. */
export const OPTIO_TOOL_NAMES: string[] = OPTIO_TOOL_SCHEMAS.map((t) => t.name);

/** Tool schemas grouped by category. */
export function getToolsByCategory(): Record<string, OptioToolSchema[]> {
  const grouped: Record<string, OptioToolSchema[]> = {};
  for (const tool of OPTIO_TOOL_SCHEMAS) {
    if (!grouped[tool.category]) {
      grouped[tool.category] = [];
    }
    grouped[tool.category].push(tool);
  }
  return grouped;
}

/**
 * Get tool schemas for a specific set of enabled tools.
 * Used to build the agent's tool configuration from the enabledTools setting.
 */
export function getEnabledToolSchemas(enabledToolNames: string[]): OptioToolSchema[] {
  const set = new Set(enabledToolNames);
  return OPTIO_TOOL_SCHEMAS.filter((t) => set.has(t.name));
}

/** Terminal task states for the watch_task tool. */
export const TERMINAL_TASK_STATES = ["completed", "failed", "cancelled"] as const;

/** Maximum character length for individual log entries in get_task_logs. */
export const LOG_ENTRY_MAX_LENGTH = 2000;

/** Default tail count for get_task_logs. */
export const LOG_TAIL_DEFAULT = 100;
