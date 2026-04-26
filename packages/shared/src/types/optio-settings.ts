export interface OptioSettings {
  id: string;
  model: string; // "opus" | "sonnet" | "haiku"
  systemPrompt: string;
  enabledTools: string[];
  confirmWrites: boolean;
  maxTurns: number;
  /**
   * Workspace-level review-agent fallback. When a repo doesn't set its own
   * `reviewAgentType` and `defaultAgentType`, the resolver in
   * `apps/api/src/services/review-config.ts` picks this up. Null = no
   * preference (resolver continues falling back through its chain).
   */
  defaultReviewAgentType: string | null;
  defaultReviewModel: string | null;
  workspaceId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateOptioSettingsInput {
  model?: string;
  systemPrompt?: string;
  enabledTools?: string[];
  confirmWrites?: boolean;
  maxTurns?: number;
  defaultReviewAgentType?: string | null;
  defaultReviewModel?: string | null;
}

/** Tool category for UI grouping */
export interface OptioToolCategory {
  name: string;
  tools: OptioToolDefinition[];
}

export interface OptioToolDefinition {
  name: string;
  description: string;
  category: string;
}

/** All available Optio tools, grouped by category */
export const OPTIO_TOOL_CATEGORIES: OptioToolCategory[] = [
  {
    name: "Tasks",
    tools: [
      { name: "list_tasks", description: "List and search tasks", category: "Tasks" },
      { name: "create_task", description: "Create a new task", category: "Tasks" },
      { name: "cancel_task", description: "Cancel a running task", category: "Tasks" },
      { name: "retry_task", description: "Retry a failed task", category: "Tasks" },
      { name: "get_task_details", description: "View task details and logs", category: "Tasks" },
      { name: "resume_task", description: "Resume a paused task", category: "Tasks" },
    ],
  },
  {
    name: "Repos",
    tools: [
      { name: "list_repos", description: "List configured repositories", category: "Repos" },
      { name: "add_repo", description: "Add a new repository", category: "Repos" },
      { name: "update_repo", description: "Update repository settings", category: "Repos" },
      { name: "delete_repo", description: "Remove a repository", category: "Repos" },
    ],
  },
  {
    name: "Issues",
    tools: [
      { name: "list_issues", description: "Browse GitHub issues", category: "Issues" },
      { name: "assign_issue", description: "Assign an issue to Optio", category: "Issues" },
    ],
  },
  {
    name: "Pods",
    tools: [
      { name: "list_pods", description: "List running pods", category: "Pods" },
      { name: "restart_pod", description: "Restart a pod", category: "Pods" },
      { name: "get_cluster_status", description: "View cluster health", category: "Pods" },
    ],
  },
  {
    name: "Costs",
    tools: [{ name: "get_cost_analytics", description: "View cost analytics", category: "Costs" }],
  },
  {
    name: "System",
    tools: [
      { name: "manage_secrets", description: "Create or delete secrets", category: "System" },
      { name: "manage_schedules", description: "Create or modify schedules", category: "System" },
      { name: "manage_webhooks", description: "Configure webhooks", category: "System" },
    ],
  },
];

/** Flat list of all tool names */
export const ALL_OPTIO_TOOL_NAMES: string[] = OPTIO_TOOL_CATEGORIES.flatMap((cat) =>
  cat.tools.map((t) => t.name),
);
