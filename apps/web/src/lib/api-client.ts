const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...opts?.headers,
    },
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
  }) =>
    request<{ task: any }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  cancelTask: (id: string) => request<{ task: any }>(`/api/tasks/${id}/cancel`, { method: "POST" }),

  retryTask: (id: string) => request<{ task: any }>(`/api/tasks/${id}/retry`, { method: "POST" }),

  resumeTask: (id: string, prompt?: string) =>
    request<{ task: any }>(`/api/tasks/${id}/resume`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    }),

  getTaskLogs: (id: string, params?: { limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.offset) qs.set("offset", String(params.offset));
    const query = qs.toString();
    return request<{ logs: any[] }>(`/api/tasks/${id}/logs${query ? `?${query}` : ""}`);
  },

  getTaskEvents: (id: string) => request<{ events: any[] }>(`/api/tasks/${id}/events`),

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

  getReviewDefault: () =>
    request<{ template: string }>("/api/prompt-templates/review-default"),

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
};
