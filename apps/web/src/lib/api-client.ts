const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Read the current workspace ID from localStorage (set by workspace switcher). */
function getWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("optio_workspace_id");
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...(opts?.headers as Record<string, string>) };
  if (opts?.body) {
    headers["Content-Type"] = "application/json";
  }
  const wsId = getWorkspaceId();
  if (wsId) {
    headers["x-workspace-id"] = wsId;
  }
  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers,
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `API error: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  // Tasks
  listTasks: (params?: { state?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.state) qs.set("state", params.state);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.offset) qs.set("offset", String(params.offset));
    const query = qs.toString();
    return request<{ tasks: any[] }>(`/api/tasks${query ? `?${query}` : ""}`);
  },

  searchTasks: (params?: {
    q?: string;
    state?: string;
    repoUrl?: string;
    agentType?: string;
    taskType?: string;
    costMin?: string;
    costMax?: string;
    createdAfter?: string;
    createdBefore?: string;
    author?: string;
    cursor?: string;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params) {
      for (const [key, val] of Object.entries(params)) {
        if (val != null && val !== "") qs.set(key, String(val));
      }
    }
    const query = qs.toString();
    return request<{ tasks: any[]; nextCursor: string | null; hasMore: boolean }>(
      `/api/tasks/search${query ? `?${query}` : ""}`,
    );
  },

  getTask: (id: string) => request<{ task: any }>(`/api/tasks/${id}`),

  createTask: (data: {
    title: string;
    prompt: string;
    repoUrl: string;
    repoBranch?: string;
    agentType: string;
    ticketSource?: string;
    ticketExternalId?: string;
    metadata?: Record<string, unknown>;
    maxRetries?: number;
    priority?: number;
    dependsOn?: string[];
  }) =>
    request<{ task: any }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  cancelTask: (id: string) => request<{ task: any }>(`/api/tasks/${id}/cancel`, { method: "POST" }),

  retryTask: (id: string) => request<{ task: any }>(`/api/tasks/${id}/retry`, { method: "POST" }),

  forceRedoTask: (id: string) =>
    request<{ task: any }>(`/api/tasks/${id}/force-redo`, { method: "POST" }),

  resumeTask: (id: string, prompt?: string) =>
    request<{ task: any }>(`/api/tasks/${id}/resume`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    }),

  forceRestartTask: (id: string, prompt?: string) =>
    request<{ task: any }>(`/api/tasks/${id}/force-restart`, {
      method: "POST",
      body: JSON.stringify(prompt ? { prompt } : {}),
    }),

  getTaskLogs: (
    id: string,
    params?: { limit?: number; offset?: number; search?: string; logType?: string },
  ) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.offset) qs.set("offset", String(params.offset));
    if (params?.search) qs.set("search", params.search);
    if (params?.logType) qs.set("logType", params.logType);
    const query = qs.toString();
    return request<{ logs: any[] }>(`/api/tasks/${id}/logs${query ? `?${query}` : ""}`);
  },

  exportTaskLogs: (id: string, params?: { format?: string; search?: string; logType?: string }) => {
    const qs = new URLSearchParams();
    if (params?.format) qs.set("format", params.format);
    if (params?.search) qs.set("search", params.search);
    if (params?.logType) qs.set("logType", params.logType);
    const query = qs.toString();
    const url = `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/api/tasks/${id}/logs/export${query ? `?${query}` : ""}`;
    return url;
  },

  getTaskEvents: (id: string) => request<{ events: any[] }>(`/api/tasks/${id}/events`),

  // Comments & Activity
  getTaskComments: (id: string) => request<{ comments: any[] }>(`/api/tasks/${id}/comments`),

  addTaskComment: (id: string, content: string) =>
    request<{ comment: any }>(`/api/tasks/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),

  updateTaskComment: (taskId: string, commentId: string, content: string) =>
    request<{ comment: any }>(`/api/tasks/${taskId}/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    }),

  deleteTaskComment: (taskId: string, commentId: string) =>
    request<void>(`/api/tasks/${taskId}/comments/${commentId}`, { method: "DELETE" }),

  getTaskActivity: (id: string) => request<{ activity: any[] }>(`/api/tasks/${id}/activity`),

  // Secrets
  listSecrets: (scope?: string) => {
    const qs = scope ? `?scope=${scope}` : "";
    return request<{ secrets: any[] }>(`/api/secrets${qs}`);
  },

  createSecret: (data: { name: string; value: string; scope?: string }) =>
    request<{ name: string; scope: string }>("/api/secrets", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  deleteSecret: (name: string, scope?: string) => {
    const qs = scope ? `?scope=${scope}` : "";
    return request<void>(`/api/secrets/${name}${qs}`, { method: "DELETE" });
  },

  // Health
  getHealth: () => request<{ healthy: boolean; checks: Record<string, boolean> }>("/api/health"),

  // Tickets (Phase 3)
  syncTickets: () => request<{ synced: number }>("/api/tickets/sync", { method: "POST" }),

  listTicketProviders: () => request<{ providers: any[] }>("/api/tickets/providers"),

  createTicketProvider: (data: { source: string; config: Record<string, unknown> }) =>
    request<{ provider: any }>("/api/tickets/providers", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Prompt templates
  getEffectiveTemplate: (repoUrl?: string) => {
    const qs = repoUrl ? `?repoUrl=${encodeURIComponent(repoUrl)}` : "";
    return request<{ id: string; template: string; autoMerge: boolean }>(
      `/api/prompt-templates/effective${qs}`,
    );
  },

  getBuiltinDefault: () => request<{ template: string }>("/api/prompt-templates/builtin-default"),

  savePromptTemplate: (data: { template: string; autoMerge?: boolean; repoUrl?: string }) =>
    request<{ ok: boolean }>("/api/prompt-templates", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getReviewDefault: () => request<{ template: string }>("/api/prompt-templates/review-default"),

  saveReviewDefault: (template: string) =>
    request<{ ok: boolean }>("/api/prompt-templates", {
      method: "POST",
      body: JSON.stringify({ template, isReview: true }),
    }),

  // Repos
  listRepos: () => request<{ repos: any[] }>("/api/repos"),

  getRepo: (id: string) => request<{ repo: any }>(`/api/repos/${id}`),

  createRepoConfig: (data: {
    repoUrl: string;
    fullName: string;
    defaultBranch?: string;
    isPrivate?: boolean;
  }) => request<{ repo: any }>("/api/repos", { method: "POST", body: JSON.stringify(data) }),

  updateRepo: (id: string, data: Record<string, unknown>) =>
    request<{ repo: any }>(`/api/repos/${id}`, { method: "PATCH", body: JSON.stringify(data) }),

  deleteRepo: (id: string) => request<void>(`/api/repos/${id}`, { method: "DELETE" }),

  // Cluster
  getClusterOverview: () =>
    request<{
      nodes: any[];
      pods: any[];
      services: any[];
      events: any[];
      repoPods: any[];
      metricsAvailable: boolean;
      summary: {
        totalPods: number;
        runningPods: number;
        agentPods: number;
        infraPods: number;
        totalNodes: number;
        readyNodes: number;
      };
    }>("/api/cluster/overview"),

  listClusterPods: () => request<{ pods: any[] }>("/api/cluster/pods"),

  getClusterPod: (id: string) => request<{ pod: any }>(`/api/cluster/pods/${id}`),

  getHealthEvents: (limit?: number) =>
    request<{ events: any[] }>(`/api/cluster/health-events${limit ? `?limit=${limit}` : ""}`),

  restartPod: (id: string) =>
    request<{ ok: boolean }>(`/api/cluster/pods/${id}/restart`, { method: "POST" }),

  // Setup
  getSetupStatus: () =>
    request<{
      isSetUp: boolean;
      steps: Record<string, { done: boolean; label: string }>;
    }>("/api/setup/status"),

  listUserRepos: (token: string) =>
    request<{
      repos: Array<{
        fullName: string;
        cloneUrl: string;
        htmlUrl: string;
        defaultBranch: string;
        isPrivate: boolean;
        description: string | null;
        language: string | null;
        pushedAt: string;
      }>;
      error?: string;
    }>("/api/setup/repos", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),

  validateGithubToken: (token: string) =>
    request<{ valid: boolean; error?: string; user?: { login: string; name: string } }>(
      "/api/setup/validate/github-token",
      { method: "POST", body: JSON.stringify({ token }) },
    ),

  validateAnthropicKey: (key: string) =>
    request<{ valid: boolean; error?: string }>("/api/setup/validate/anthropic-key", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),

  validateOpenAIKey: (key: string) =>
    request<{ valid: boolean; error?: string }>("/api/setup/validate/openai-key", {
      method: "POST",
      body: JSON.stringify({ key }),
    }),

  validateRepo: (repoUrl: string, token?: string) =>
    request<{
      valid: boolean;
      error?: string;
      repo?: { fullName: string; defaultBranch: string; isPrivate: boolean };
    }>("/api/setup/validate/repo", {
      method: "POST",
      body: JSON.stringify({ repoUrl, token }),
    }),

  getAuthStatus: () =>
    request<{
      subscription: { available: boolean; expiresAt?: string; error?: string };
    }>("/api/auth/status"),

  refreshAuth: () =>
    request<{
      subscription: { available: boolean; expiresAt?: string; error?: string };
    }>("/api/auth/refresh", { method: "POST" }),

  getUsage: () =>
    request<{
      usage: {
        available: boolean;
        fiveHour?: { utilization: number | null; resetsAt: string | null };
        sevenDay?: { utilization: number | null; resetsAt: string | null };
        sevenDaySonnet?: { utilization: number | null; resetsAt: string | null };
        sevenDayOpus?: { utilization: number | null; resetsAt: string | null };
        extraUsage?: {
          isEnabled: boolean;
          monthlyLimit: number | null;
          usedCredits: number | null;
          utilization: number | null;
        };
        error?: string;
      };
    }>("/api/auth/usage"),

  // Bulk operations
  bulkRetryFailed: () =>
    request<{ retried: number; total: number }>("/api/tasks/bulk/retry-failed", { method: "POST" }),

  bulkCancelActive: () =>
    request<{ cancelled: number; total: number }>("/api/tasks/bulk/cancel-active", {
      method: "POST",
    }),

  reorderTasks: (taskIds: string[]) =>
    request<{ ok: boolean; reordered: number }>("/api/tasks/reorder", {
      method: "POST",
      body: JSON.stringify({ taskIds }),
    }),

  // Issues
  listIssues: (params?: { repoId?: string; state?: string }) => {
    const qs = new URLSearchParams();
    if (params?.repoId) qs.set("repoId", params.repoId);
    if (params?.state) qs.set("state", params.state);
    const query = qs.toString();
    return request<{ issues: any[] }>(`/api/issues${query ? `?${query}` : ""}`);
  },

  launchReview: (taskId: string) =>
    request<{ reviewTaskId: string }>(`/api/tasks/${taskId}/review`, { method: "POST" }),

  // Subtasks
  getSubtasks: (taskId: string) => request<{ subtasks: any[] }>(`/api/tasks/${taskId}/subtasks`),

  createSubtask: (
    taskId: string,
    data: {
      title: string;
      prompt: string;
      taskType?: string;
      blocksParent?: boolean;
      autoQueue?: boolean;
    },
  ) =>
    request<{ subtask: any }>(`/api/tasks/${taskId}/subtasks`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getSubtaskStatus: (taskId: string) =>
    request<{
      allComplete: boolean;
      total: number;
      pending: number;
      running: number;
      completed: number;
      failed: number;
    }>(`/api/tasks/${taskId}/subtasks/status`),

  // Analytics
  getCostAnalytics: (params?: { days?: number; repoUrl?: string }) => {
    const qs = new URLSearchParams();
    if (params?.days) qs.set("days", String(params.days));
    if (params?.repoUrl) qs.set("repoUrl", params.repoUrl);
    const query = qs.toString();
    return request<{
      summary: {
        totalCost: string;
        taskCount: number;
        tasksWithCost: number;
        avgCost: string;
        costTrend: string;
        prevPeriodCost: string;
        days: number;
      };
      forecast: {
        dailyAvgCost: string;
        monthCostSoFar: string;
        forecastedMonthTotal: string;
        daysRemaining: number;
      };
      dailyCosts: Array<{ date: string; cost: number; taskCount: number }>;
      costByRepo: Array<{ repoUrl: string; totalCost: number; taskCount: number }>;
      costByType: Array<{ taskType: string; totalCost: number; taskCount: number }>;
      costByModel: Array<{
        model: string;
        totalCost: number;
        taskCount: number;
        successRate: number;
        avgCost: number;
        totalInputTokens: number;
        totalOutputTokens: number;
      }>;
      anomalies: Array<{
        id: string;
        title: string;
        repoUrl: string;
        taskType: string;
        state: string;
        costUsd: string;
        modelUsed: string;
        repoAvgCost: number;
        costRatio: number;
        createdAt: string;
      }>;
      modelSuggestions: Array<{
        repoUrl: string;
        currentModel: string;
        taskCount: number;
        avgCost: number;
        cheaperModelAvgCost: number;
      }>;
      topTasks: Array<{
        id: string;
        title: string;
        repoUrl: string;
        taskType: string;
        state: string;
        costUsd: string;
        inputTokens: number;
        outputTokens: number;
        modelUsed: string;
        createdAt: string;
      }>;
    }>(`/api/analytics/costs${query ? `?${query}` : ""}`);
  },

  assignIssue: (data: {
    issueNumber: number;
    repoId: string;
    title: string;
    body: string;
    agentType?: string;
  }) =>
    request<{ task: any }>("/api/issues/assign", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // OAuth / User Auth
  getAuthProviders: () =>
    request<{
      providers: Array<{ name: string; displayName: string }>;
      authDisabled: boolean;
    }>("/api/auth/providers"),

  getCurrentUser: () =>
    request<{
      user: {
        id: string;
        provider: string;
        email: string;
        displayName: string;
        avatarUrl: string | null;
        workspaceId: string | null;
        workspaceRole: string | null;
      };
      authDisabled: boolean;
    }>("/api/auth/me"),

  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  // Task Templates
  listTaskTemplates: (repoUrl?: string) => {
    const qs = repoUrl ? `?repoUrl=${encodeURIComponent(repoUrl)}` : "";
    return request<{ templates: any[] }>(`/api/task-templates${qs}`);
  },

  getTaskTemplate: (id: string) => request<{ template: any }>(`/api/task-templates/${id}`),

  createTaskTemplate: (data: {
    name: string;
    prompt: string;
    repoUrl?: string;
    agentType?: string;
    priority?: number;
    metadata?: Record<string, unknown>;
  }) =>
    request<{ template: any }>("/api/task-templates", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateTaskTemplate: (id: string, data: Record<string, unknown>) =>
    request<{ template: any }>(`/api/task-templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteTaskTemplate: (id: string) =>
    request<void>(`/api/task-templates/${id}`, { method: "DELETE" }),

  createTaskFromTemplate: (
    templateId: string,
    data: {
      title: string;
      repoUrl?: string;
      repoBranch?: string;
      prompt?: string;
      agentType?: string;
      priority?: number;
      maxRetries?: number;
      metadata?: Record<string, unknown>;
    },
  ) =>
    request<{ task: any }>(`/api/tasks/from-template/${templateId}`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Interactive Sessions
  listSessions: (params?: {
    repoUrl?: string;
    state?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params?.repoUrl) qs.set("repoUrl", params.repoUrl);
    if (params?.state) qs.set("state", params.state);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.offset) qs.set("offset", String(params.offset));
    const query = qs.toString();
    return request<{ sessions: any[]; activeCount: number }>(
      `/api/sessions${query ? `?${query}` : ""}`,
    );
  },

  getSession: (id: string) => request<{ session: any }>(`/api/sessions/${id}`),

  createSession: (data: { repoUrl: string }) =>
    request<{ session: any }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  endSession: (id: string) =>
    request<{ session: any }>(`/api/sessions/${id}/end`, { method: "POST" }),

  getSessionPrs: (sessionId: string) => request<{ prs: any[] }>(`/api/sessions/${sessionId}/prs`),

  addSessionPr: (sessionId: string, data: { prUrl: string; prNumber: number }) =>
    request<{ pr: any }>(`/api/sessions/${sessionId}/prs`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Schedules
  listSchedules: () =>
    request<{
      schedules: Array<{
        id: string;
        name: string;
        description: string | null;
        cronExpression: string;
        enabled: boolean;
        taskConfig: {
          title: string;
          prompt: string;
          repoUrl: string;
          repoBranch?: string;
          agentType: string;
          maxRetries?: number;
          priority?: number;
        };
        lastRunAt: string | null;
        nextRunAt: string | null;
        createdAt: string;
        updatedAt: string;
      }>;
    }>("/api/schedules"),

  getSchedule: (id: string) =>
    request<{
      schedule: {
        id: string;
        name: string;
        description: string | null;
        cronExpression: string;
        enabled: boolean;
        taskConfig: {
          title: string;
          prompt: string;
          repoUrl: string;
          repoBranch?: string;
          agentType: string;
          maxRetries?: number;
          priority?: number;
        };
        lastRunAt: string | null;
        nextRunAt: string | null;
        createdAt: string;
        updatedAt: string;
      };
    }>(`/api/schedules/${id}`),

  createSchedule: (data: {
    name: string;
    description?: string;
    cronExpression: string;
    enabled?: boolean;
    taskConfig: {
      title: string;
      prompt: string;
      repoUrl: string;
      repoBranch?: string;
      agentType: string;
      maxRetries?: number;
      priority?: number;
    };
  }) =>
    request<{ schedule: any }>("/api/schedules", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateSchedule: (id: string, data: Record<string, unknown>) =>
    request<{ schedule: any }>(`/api/schedules/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteSchedule: (id: string) => request<void>(`/api/schedules/${id}`, { method: "DELETE" }),

  triggerSchedule: (id: string) =>
    request<{ task: any }>(`/api/schedules/${id}/trigger`, { method: "POST" }),

  getScheduleRuns: (id: string, limit?: number) => {
    const qs = limit ? `?limit=${limit}` : "";
    return request<{
      runs: Array<{
        id: string;
        scheduleId: string;
        taskId: string | null;
        status: string;
        error: string | null;
        triggeredAt: string;
      }>;
    }>(`/api/schedules/${id}/runs${qs}`);
  },

  validateCron: (cronExpression: string) =>
    request<{ valid: boolean; error?: string; nextRun?: string; description?: string }>(
      "/api/schedules/validate-cron",
      {
        method: "POST",
        body: JSON.stringify({ cronExpression }),
      },
    ),

  getWsToken: () => request<{ token: string }>("/api/auth/ws-token"),

  // Workspaces
  listWorkspaces: () =>
    request<{
      workspaces: Array<{
        id: string;
        name: string;
        slug: string;
        role: string;
      }>;
    }>("/api/workspaces"),

  getWorkspace: (id: string) =>
    request<{
      workspace: {
        id: string;
        name: string;
        slug: string;
        description: string | null;
        createdAt: string;
        updatedAt: string;
      };
      role: string;
    }>(`/api/workspaces/${id}`),

  createWorkspace: (data: { name: string; slug: string; description?: string }) =>
    request<{ workspace: any }>("/api/workspaces", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateWorkspace: (id: string, data: Record<string, unknown>) =>
    request<{ workspace: any }>(`/api/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteWorkspace: (id: string) => request<void>(`/api/workspaces/${id}`, { method: "DELETE" }),

  switchWorkspace: (id: string) =>
    request<{ ok: boolean }>(`/api/workspaces/${id}/switch`, { method: "POST" }),

  listWorkspaceMembers: (id: string) =>
    request<{
      members: Array<{
        id: string;
        workspaceId: string;
        userId: string;
        role: string;
        email: string;
        displayName: string;
        avatarUrl: string | null;
        createdAt: string;
      }>;
    }>(`/api/workspaces/${id}/members`),

  addWorkspaceMember: (workspaceId: string, userId: string, role?: string) =>
    request<{ ok: boolean }>(`/api/workspaces/${workspaceId}/members`, {
      method: "POST",
      body: JSON.stringify({ userId, role }),
    }),

  updateWorkspaceMemberRole: (workspaceId: string, userId: string, role: string) =>
    request<{ ok: boolean }>(`/api/workspaces/${workspaceId}/members/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),

  removeWorkspaceMember: (workspaceId: string, userId: string) =>
    request<void>(`/api/workspaces/${workspaceId}/members/${userId}`, { method: "DELETE" }),

  // Task Dependencies
  getTaskDependencies: (taskId: string) =>
    request<{ dependencies: any[] }>(`/api/tasks/${taskId}/dependencies`),

  getTaskDependents: (taskId: string) =>
    request<{ dependents: any[] }>(`/api/tasks/${taskId}/dependents`),

  addTaskDependencies: (taskId: string, dependsOnIds: string[]) =>
    request<{ ok: boolean }>(`/api/tasks/${taskId}/dependencies`, {
      method: "POST",
      body: JSON.stringify({ dependsOnIds }),
    }),

  removeTaskDependency: (taskId: string, depTaskId: string) =>
    request<void>(`/api/tasks/${taskId}/dependencies/${depTaskId}`, { method: "DELETE" }),

  // Workflow Templates
  listWorkflows: () => request<{ workflows: any[] }>("/api/workflows"),

  getWorkflow: (id: string) => request<{ workflow: any }>(`/api/workflows/${id}`),

  createWorkflow: (data: {
    name: string;
    description?: string;
    steps: Array<{
      id: string;
      title: string;
      prompt: string;
      repoUrl?: string;
      agentType?: string;
      dependsOn?: string[];
    }>;
    status?: string;
  }) =>
    request<{ workflow: any }>("/api/workflows", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateWorkflow: (id: string, data: Record<string, unknown>) =>
    request<{ workflow: any }>(`/api/workflows/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteWorkflow: (id: string) => request<void>(`/api/workflows/${id}`, { method: "DELETE" }),

  runWorkflow: (templateId: string, data?: { repoUrlOverride?: string }) =>
    request<{ workflowRun: any }>(`/api/workflows/${templateId}/run`, {
      method: "POST",
      body: JSON.stringify(data ?? {}),
    }),

  getWorkflowRuns: (templateId: string) =>
    request<{ runs: any[] }>(`/api/workflows/${templateId}/runs`),

  getWorkflowRun: (id: string) => request<{ workflowRun: any }>(`/api/workflow-runs/${id}`),

  // MCP Servers
  listMcpServers: (scope?: string) => {
    const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
    return request<{ servers: any[] }>(`/api/mcp-servers${qs}`);
  },

  getMcpServer: (id: string) => request<{ server: any }>(`/api/mcp-servers/${id}`),

  createMcpServer: (data: {
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    installCommand?: string;
    repoUrl?: string;
    enabled?: boolean;
  }) =>
    request<{ server: any }>("/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateMcpServer: (id: string, data: Record<string, unknown>) =>
    request<{ server: any }>(`/api/mcp-servers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteMcpServer: (id: string) => request<void>(`/api/mcp-servers/${id}`, { method: "DELETE" }),

  listRepoMcpServers: (repoId: string) =>
    request<{ servers: any[] }>(`/api/repos/${repoId}/mcp-servers`),

  createRepoMcpServer: (
    repoId: string,
    data: {
      name: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
      installCommand?: string;
      enabled?: boolean;
    },
  ) =>
    request<{ server: any }>(`/api/repos/${repoId}/mcp-servers`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Custom Skills
  listSkills: (scope?: string) => {
    const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
    return request<{ skills: any[] }>(`/api/skills${qs}`);
  },

  getSkill: (id: string) => request<{ skill: any }>(`/api/skills/${id}`),

  createSkill: (data: {
    name: string;
    description?: string;
    prompt: string;
    repoUrl?: string;
    enabled?: boolean;
  }) =>
    request<{ skill: any }>("/api/skills", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateSkill: (id: string, data: Record<string, unknown>) =>
    request<{ skill: any }>(`/api/skills/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteSkill: (id: string) => request<void>(`/api/skills/${id}`, { method: "DELETE" }),
};
