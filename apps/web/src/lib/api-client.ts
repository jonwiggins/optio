/**
 * All API requests are routed through the Next.js BFF proxy at /api/[...path].
 * The proxy reads the HttpOnly session cookie server-side and forwards it as a
 * Bearer token to the real API — the session token never touches client-side JS.
 */

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
  const res = await fetch(path, {
    ...opts,
    headers,
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

  getTaskStats: () =>
    request<{
      stats: {
        total: number;
        queued: number;
        running: number;
        ci: number;
        review: number;
        needsAttention: number;
        failed: number;
        completed: number;
      };
    }>("/api/tasks/stats"),

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

  getTask: (id: string) =>
    request<{
      task: any;
      pendingReason?: string | null;
      pipelineProgress?: any | null;
      stallInfo?: {
        isStalled: boolean;
        silentForMs: number;
        thresholdMs: number;
        lastLogSummary?: string;
      } | null;
    }>(`/api/tasks/${id}`),

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

  runNowTask: (id: string) =>
    request<{ task: any }>(`/api/tasks/${id}/run-now`, { method: "POST" }),

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
    return `/api/tasks/${id}/logs/export${query ? `?${query}` : ""}`;
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

  // Task Messages (mid-task user → agent messaging)
  sendTaskMessage: (id: string, content: string, mode: "soft" | "interrupt" = "soft") =>
    request<{ message: any }>(`/api/tasks/${id}/message`, {
      method: "POST",
      body: JSON.stringify({ content, mode }),
    }),

  getTaskMessages: (id: string) => request<{ messages: any[] }>(`/api/tasks/${id}/messages`),

  // Secrets
  listSecrets: (scope?: string) => {
    const qs = scope ? `?scope=${scope}` : "";
    return request<{ secrets: any[] }>(`/api/secrets${qs}`);
  },

  createSecret: (data: { name: string; value: string; scope?: string }) =>
    request<{ name: string; scope: string; validation?: { valid: boolean; error?: string } }>(
      "/api/secrets",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    ),

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

  deleteTicketProvider: (id: string) =>
    request<void>(`/api/tickets/providers/${id}`, { method: "DELETE" }),

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

  getClusterVersion: () =>
    request<{
      current: string;
      latest: string | null;
      updateAvailable: boolean;
    }>("/api/cluster/version"),

  triggerClusterUpdate: (targetVersion: string) =>
    request<{ ok: boolean; targetVersion: string; message: string }>("/api/cluster/update", {
      method: "POST",
      body: JSON.stringify({ targetVersion }),
    }),

  // GitHub Token Management
  getGithubTokenStatus: () =>
    request<{
      status: "valid" | "expired" | "missing" | "error";
      source?: "pat" | "github_app";
      user?: { login: string; name: string };
      message?: string;
      error?: string;
    }>("/api/github-token/status"),

  rotateGithubToken: (token: string) =>
    request<{
      success: boolean;
      user?: { login: string; name: string };
      message?: string;
      error?: string;
    }>("/api/github-token/rotate", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),

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

  validateGitlabToken: (token: string, host?: string) =>
    request<{ valid: boolean; error?: string; user?: { login: string; name: string } }>(
      "/api/setup/validate/gitlab-token",
      { method: "POST", body: JSON.stringify({ token, host }) },
    ),

  listGitlabRepos: (token: string, host?: string) =>
    request<{
      repos: Array<{
        fullName: string;
        cloneUrl: string;
        defaultBranch: string;
        isPrivate: boolean;
        description: string;
        language: string;
        pushedAt: string;
      }>;
      error?: string;
    }>("/api/setup/repos/gitlab", {
      method: "POST",
      body: JSON.stringify({ token, host }),
    }),

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

  validateCopilotToken: (token: string) =>
    request<{ valid: boolean; error?: string; user?: { login: string; name: string } }>(
      "/api/setup/validate/copilot-token",
      { method: "POST", body: JSON.stringify({ token }) },
    ),

  validateGeminiKey: (key: string) =>
    request<{ valid: boolean; error?: string }>("/api/setup/validate/gemini-key", {
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
      subscription: { available: boolean; expiresAt?: string; error?: string; expired?: boolean };
    }>("/api/auth/status"),

  refreshAuth: () =>
    request<{
      subscription: { available: boolean; expiresAt?: string; error?: string };
    }>("/api/auth/refresh", { method: "POST" }),

  getUsage: () =>
    request<{
      usage: {
        available: boolean;
        hasRecentAuthFailure?: boolean;
        authFailures?: { claude: boolean; github: boolean };
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

  getPerformanceAnalytics: (params?: { days?: number; repoUrl?: string; agentType?: string }) => {
    const qs = new URLSearchParams();
    if (params?.days) qs.set("days", String(params.days));
    if (params?.repoUrl) qs.set("repoUrl", params.repoUrl);
    if (params?.agentType) qs.set("agentType", params.agentType);
    const query = qs.toString();
    return request<{
      durations: {
        avgWallClock: number;
        p50WallClock: number;
        p95WallClock: number;
        avgExecution: number;
        p50Execution: number;
        p95Execution: number;
        avgQueueWait: number;
        taskCount: number;
      };
      successRate: number;
      successRateTrend: number;
      tasksPerDay: Array<{
        date: string;
        total: number;
        succeeded: number;
        failed: number;
      }>;
    }>(`/api/analytics/performance${query ? `?${query}` : ""}`);
  },

  getAgentAnalytics: (params?: { days?: number; repoUrl?: string }) => {
    const qs = new URLSearchParams();
    if (params?.days) qs.set("days", String(params.days));
    if (params?.repoUrl) qs.set("repoUrl", params.repoUrl);
    const query = qs.toString();
    return request<{
      agents: Array<{
        agentType: string;
        taskCount: number;
        successRate: number;
        avgDuration: number;
        avgCost: string;
        avgRetries: number;
        models: Array<{
          model: string;
          taskCount: number;
          avgCost: string;
        }>;
      }>;
    }>(`/api/analytics/agents${query ? `?${query}` : ""}`);
  },

  getFailureAnalytics: (params?: { days?: number; repoUrl?: string; agentType?: string }) => {
    const qs = new URLSearchParams();
    if (params?.days) qs.set("days", String(params.days));
    if (params?.repoUrl) qs.set("repoUrl", params.repoUrl);
    if (params?.agentType) qs.set("agentType", params.agentType);
    const query = qs.toString();
    return request<{
      errorMessages: Array<{ message: string; count: number }>;
      failureByRepo: Array<{
        repoUrl: string;
        total: number;
        failed: number;
        failureRate: number;
      }>;
      failureByAgent: Array<{
        agentType: string;
        total: number;
        failed: number;
        failureRate: number;
      }>;
      failureByModel: Array<{
        model: string;
        total: number;
        failed: number;
        failureRate: number;
      }>;
      retrySuccessRate: number;
      retriedCount: number;
      retrySucceededCount: number;
      stallCount: number;
      stallRecoveryRate: number;
    }>(`/api/analytics/failures${query ? `?${query}` : ""}`);
  },

  getPrAnalytics: (params?: { days?: number; repoUrl?: string; agentType?: string }) => {
    const qs = new URLSearchParams();
    if (params?.days) qs.set("days", String(params.days));
    if (params?.repoUrl) qs.set("repoUrl", params.repoUrl);
    if (params?.agentType) qs.set("agentType", params.agentType);
    const query = qs.toString();
    return request<{
      totalPrs: number;
      merged: number;
      closed: number;
      open: number;
      ciPassRate: number;
      reviewApprovalRate: number;
      autoMergeRate: number;
      avgMergeTime: number;
      mergeCount: number;
      funnel: {
        prOpened: number;
        ciPassed: number;
        reviewApproved: number;
        merged: number;
      };
    }>(`/api/analytics/prs${query ? `?${query}` : ""}`);
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

  getGitHubAppStatus: () =>
    request<{ configured: boolean; appId?: string; installationId?: string }>(
      "/api/github-app/status",
    ),

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

  // PR Reviews
  listPullRequests: (params?: { repoId?: string }) => {
    const qs = new URLSearchParams();
    if (params?.repoId) qs.set("repoId", params.repoId);
    const query = qs.toString();
    return request<{ pullRequests: any[] }>(`/api/pull-requests${query ? `?${query}` : ""}`);
  },

  createPrReview: (data: { prUrl: string }) =>
    request<{ task: any; draft: any }>("/api/pull-requests/review", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getReviewDraft: (taskId: string) => request<{ draft: any }>(`/api/tasks/${taskId}/review-draft`),

  updateReviewDraft: (
    taskId: string,
    data: {
      summary?: string;
      verdict?: string;
      fileComments?: Array<{ path: string; line?: number; side?: string; body: string }>;
    },
  ) =>
    request<{ draft: any }>(`/api/tasks/${taskId}/review-draft`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  submitReviewDraft: (taskId: string) =>
    request<{ draft: any; reviewUrl?: string }>(`/api/tasks/${taskId}/review-draft/submit`, {
      method: "POST",
    }),

  reReview: (taskId: string) =>
    request<{ task: any; draft: any }>(`/api/tasks/${taskId}/review-draft/re-review`, {
      method: "POST",
    }),

  mergePullRequest: (data: { prUrl: string; mergeMethod: "merge" | "squash" | "rebase" }) =>
    request<{ merged: boolean }>("/api/pull-requests/merge", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getPrStatus: (prUrl: string) =>
    request<{
      checksStatus: string;
      reviewStatus: string;
      mergeable: boolean | null;
      prState: string;
      headSha: string;
    }>(`/api/pull-requests/status?prUrl=${encodeURIComponent(prUrl)}`),

  // Optio Agent Settings
  getOptioSettings: () => request<{ settings: any }>("/api/optio/settings"),

  updateOptioSettings: (data: {
    model?: string;
    systemPrompt?: string;
    enabledTools?: string[];
    confirmWrites?: boolean;
    maxTurns?: number;
  }) =>
    request<{ settings: any }>("/api/optio/settings", {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // Push Notifications
  getVapidPublicKey: () => request<{ publicKey: string }>("/api/notifications/vapid-public-key"),

  subscribePush: (data: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    userAgent?: string;
  }) =>
    request<{ ok: boolean }>("/api/notifications/subscribe", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  unsubscribePush: (data: { endpoint: string }) =>
    request<void>("/api/notifications/subscribe", {
      method: "DELETE",
      body: JSON.stringify(data),
    }),

  listPushSubscriptions: () =>
    request<{ subscriptions: any[] }>("/api/notifications/subscriptions"),

  getNotificationPreferences: () =>
    request<{ preferences: Record<string, { push: boolean }> }>("/api/notifications/preferences"),

  updateNotificationPreferences: (prefs: Record<string, { push: boolean }>) =>
    request<{ preferences: Record<string, { push: boolean }> }>("/api/notifications/preferences", {
      method: "PUT",
      body: JSON.stringify(prefs),
    }),

  testPushNotification: () =>
    request<{ sent: number }>("/api/notifications/test", { method: "POST" }),

  // Shared Directories (Cache)
  listRepoSharedDirectories: (repoId: string) =>
    request<{
      directories: Array<{
        id: string;
        repoId: string;
        name: string;
        description: string | null;
        mountLocation: string;
        mountSubPath: string;
        sizeGi: number;
        scope: string;
        lastClearedAt: string | null;
        lastMountedAt: string | null;
        createdAt: string;
        updatedAt: string;
      }>;
    }>(`/api/repos/${repoId}/shared-directories`),

  createRepoSharedDirectory: (
    repoId: string,
    data: {
      name: string;
      description?: string;
      mountLocation: "workspace" | "home";
      mountSubPath: string;
      sizeGi?: number;
    },
  ) =>
    request<{ directory: any }>(`/api/repos/${repoId}/shared-directories`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateRepoSharedDirectory: (
    repoId: string,
    dirId: string,
    data: { description?: string | null; sizeGi?: number },
  ) =>
    request<{ directory: any }>(`/api/repos/${repoId}/shared-directories/${dirId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteRepoSharedDirectory: (repoId: string, dirId: string) =>
    request<void>(`/api/repos/${repoId}/shared-directories/${dirId}`, {
      method: "DELETE",
    }),

  clearRepoSharedDirectory: (repoId: string, dirId: string) =>
    request<{ ok: boolean }>(`/api/repos/${repoId}/shared-directories/${dirId}/clear`, {
      method: "POST",
    }),

  getRepoSharedDirectoryUsage: (repoId: string, dirId: string) =>
    request<{ usage: string | null }>(`/api/repos/${repoId}/shared-directories/${dirId}/usage`, {
      method: "POST",
    }),

  recycleRepoPods: (repoId: string) =>
    request<{ ok: boolean; recycled: number }>(`/api/repos/${repoId}/pods/recycle`, {
      method: "POST",
    }),

  // Workflows
  listWorkflows: () => request<{ workflows: any[] }>("/api/workflows"),

  getWorkflow: (id: string) => request<{ workflow: any }>(`/api/workflows/${id}`),

  createWorkflow: (data: {
    name: string;
    description?: string;
    promptTemplate: string;
    agentRuntime?: string;
    model?: string;
    maxTurns?: number;
    budgetUsd?: string;
    maxConcurrent?: number;
    maxRetries?: number;
    warmPoolSize?: number;
    enabled?: boolean;
    environmentSpec?: Record<string, unknown>;
    paramsSchema?: Record<string, unknown>;
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

  cloneWorkflow: (id: string) =>
    request<{ workflow: any }>(`/api/workflows/${id}/clone`, { method: "POST" }),

  runWorkflow: (workflowId: string, params?: Record<string, unknown> | null) =>
    request<{ run: any }>(`/api/workflows/${workflowId}/runs`, {
      method: "POST",
      body: JSON.stringify({ params: params ?? null }),
    }),

  getWorkflowRuns: (workflowId: string) =>
    request<{ runs: any[] }>(`/api/workflows/${workflowId}/runs`),

  listWorkflowRuns: (workflowId: string, limit?: number) => {
    const qs = limit ? `?limit=${limit}` : "";
    return request<{ runs: any[] }>(`/api/workflows/${workflowId}/runs${qs}`);
  },

  getWorkflowRun: (id: string) => request<{ run: any }>(`/api/workflow-runs/${id}`),

  // Workflow Triggers
  getWorkflowTriggers: (workflowId: string) =>
    request<{ triggers: any[] }>(`/api/workflows/${workflowId}/triggers`),

  listWorkflowTriggers: (workflowId: string) =>
    request<{ triggers: any[] }>(`/api/workflows/${workflowId}/triggers`),

  retryWorkflowRun: (id: string) =>
    request<{ run: any }>(`/api/workflow-runs/${id}/retry`, { method: "POST" }),

  cancelWorkflowRun: (id: string) =>
    request<{ run: any }>(`/api/workflow-runs/${id}/cancel`, { method: "POST" }),

  getWorkflowRunLogs: (id: string, opts?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.offset != null) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return request<{ logs: any[] }>(`/api/workflow-runs/${id}/logs${qs ? `?${qs}` : ""}`);
  },

  createWorkflowTrigger: (
    workflowId: string,
    data: {
      type: "manual" | "schedule" | "webhook";
      config?: Record<string, unknown>;
      paramMapping?: Record<string, unknown>;
      enabled?: boolean;
    },
  ) =>
    request<{ trigger: any }>(`/api/workflows/${workflowId}/triggers`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateWorkflowTrigger: (workflowId: string, triggerId: string, data: Record<string, unknown>) =>
    request<{ trigger: any }>(`/api/workflows/${workflowId}/triggers/${triggerId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteWorkflowTrigger: (workflowId: string, triggerId: string) =>
    request<void>(`/api/workflows/${workflowId}/triggers/${triggerId}`, {
      method: "DELETE",
    }),

  // Webhooks (outbound notifications fired on task/workflow events)
  listWebhooks: () => request<{ webhooks: any[] }>("/api/webhooks"),

  getWebhook: (id: string) => request<{ webhook: any }>(`/api/webhooks/${id}`),

  createWebhook: (data: { url: string; events: string[]; secret?: string; description?: string }) =>
    request<{ webhook: any }>("/api/webhooks", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateWebhook: (
    id: string,
    data: {
      url?: string;
      events?: string[];
      secret?: string | null;
      description?: string | null;
      active?: boolean;
    },
  ) =>
    request<{ webhook: any }>(`/api/webhooks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteWebhook: (id: string) => request<void>(`/api/webhooks/${id}`, { method: "DELETE" }),

  testWebhook: (id: string, event?: string) =>
    request<{ delivery: any }>(`/api/webhooks/${id}/test`, {
      method: "POST",
      body: JSON.stringify(event ? { event } : {}),
    }),

  listWebhookDeliveries: (id: string, limit?: number) => {
    const qs = limit ? `?limit=${limit}` : "";
    return request<{ deliveries: any[] }>(`/api/webhooks/${id}/deliveries${qs}`);
  },

  // Connections (external service integrations for agents)
  listConnectionProviders: () => request<{ providers: any[] }>("/api/connection-providers"),

  listConnections: () => request<{ connections: any[] }>("/api/connections"),

  createConnection: (data: Record<string, unknown>) =>
    request<{ connection: any }>("/api/connections", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateConnection: (id: string, data: Record<string, unknown>) =>
    request<{ connection: any }>(`/api/connections/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteConnection: (id: string) => request<void>(`/api/connections/${id}`, { method: "DELETE" }),

  testConnection: (id: string) =>
    request<{ status: string; message: string }>(`/api/connections/${id}/test`, {
      method: "POST",
    }),

  createConnectionAssignment: (connectionId: string, data: Record<string, unknown>) =>
    request<{ assignment: any }>(`/api/connections/${connectionId}/assignments`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  listRepoConnections: (repoId: string) =>
    request<{ connections: any[] }>(`/api/repos/${repoId}/connections`),

  deleteConnectionAssignment: (id: string) =>
    request<void>(`/api/connection-assignments/${id}`, { method: "DELETE" }),

  // Activity feed
  getActivityFeed: (params?: {
    days?: number;
    type?: string;
    userId?: string;
    resourceType?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params) {
      for (const [key, val] of Object.entries(params)) {
        if (val != null && val !== "") qs.set(key, String(val));
      }
    }
    const query = qs.toString();
    return request<{
      items: Array<{
        id: string;
        type: "action" | "task_event" | "auth_event" | "infra_event";
        timestamp: string;
        actor?: { id: string; displayName: string; avatarUrl?: string | null } | null;
        action: string;
        resourceType: string;
        resourceId?: string | null;
        summary: string;
        details?: Record<string, unknown> | null;
      }>;
      total: number;
      stats: {
        actions: number;
        taskEvents: number;
        authEvents: number;
        infraEvents: number;
      };
    }>(`/api/activity${query ? `?${query}` : ""}`);
  },
};
