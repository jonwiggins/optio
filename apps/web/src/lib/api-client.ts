/**
 * All API requests are routed through the Next.js BFF proxy at /api/[...path].
 * The proxy reads the HttpOnly session cookie server-side and forwards it as a
 * Bearer token to the real API — the session token never touches client-side JS.
 */

import type {
  SecretRef,
  WorkEnvironmentEntry,
  UpdateConnectionInput,
  RepoConnection,
  ConnectionProvider,
  ConnectionAssignment,
  Connection,
  AgentCredential,
  AgentCredentialOptions,
  CreateAgentCredentialInput,
  VerifyAgentCredentialInput,
  VerifyAgentCredentialResult,
  CreateModelProviderInput,
  LocalTranscriptEntry,
  ModelProvider,
  PickableSecret,
  ResourceOwner,
  TaskPr,
  TriggerType,
  UpdateModelProviderInput,
  WorkFormDefaults,
  WorkCreated,
  WorkRow,
  WorkSource,
  WorkSpec,
  WorkEnvironmentOptions,
} from "@optio/shared";
import type { ConfigApplyResult, ConfigStatus, ExportedManifest } from "@optio/shared";

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
    throw Object.assign(new Error(body.error ?? `API error: ${res.status}`), {
      status: res.status,
      details: body.details as string | undefined,
    });
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

/** A repo / ticket provider whose issues could not be fetched (GET /api/issues). */
export interface IssueSourceError {
  source: string;
  name: string;
  repoId: string | null;
  status: number | null;
  message: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ApiKeyCreated {
  /** Raw token; shown once and never retrievable again. */
  token: string;
  tokenId: string;
  name: string;
  expiresAt: string | null;
}

/** What `GET /api/auth/sign-in` says about one provider (never a secret). */
export interface SignInProviderView {
  provider: "google" | "github" | "gitlab" | "oidc";
  displayName: string;
  configurable: boolean;
  enabled: boolean;
  source: "database" | "environment" | "none";
  clientId: string | null;
  hasClientSecret: boolean;
  allowedDomains: string[];
  callbackUrl: string;
  updatedAt: string | null;
}

export interface DeploymentAdmin {
  id: string;
  email: string;
  displayName: string;
  fromEnvironment: boolean;
}

export interface SignInConfig {
  /** Nobody can sign in yet (no provider configured anywhere). */
  bootstrap: boolean;
  canEdit: boolean;
  /** Signed in, no deployment admin exists: the setup token can claim the role. */
  canClaim: boolean;
  publicUrl: string | null;
  providers: SignInProviderView[];
  deploymentAdmins?: DeploymentAdmin[];
}

function setupTokenHeader(token?: string): Record<string, string> | undefined {
  return token ? { "X-Optio-Setup-Token": token } : undefined;
}

/** A secret as `GET /api/secrets` lists it: a name and whose it is, never a value. */
export interface VisibleSecret extends SecretRef {
  ownerUserId: string | null;
  ownerName: string | null;
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

  attachTaskPr: (id: string, url: string) =>
    request<{ pr: TaskPr }>(`/api/tasks/${id}/prs`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),

  removeTaskPr: (id: string, prId: string) =>
    request<{ primaryUrl: string | null }>(`/api/tasks/${id}/prs/${prId}`, { method: "DELETE" }),

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
  /**
   * Secret names (never values). `deployment: true` lists only the
   * deployment's own (identity tokens, Optio settings, git sign-in);
   * `false` leaves those out.
   */
  listSecrets: (scope?: string, opts?: { deployment?: boolean }) => {
    const qs = new URLSearchParams();
    if (scope) qs.set("scope", scope);
    if (opts?.deployment !== undefined) qs.set("deployment", opts.deployment ? "1" : "0");
    const q = qs.toString();
    return request<{ secrets: VisibleSecret[] }>(`/api/secrets${q ? `?${q}` : ""}`);
  },

  /** Pull a fresh Claude OAuth token from one of the caller's machines via its Optio Local daemon. */
  refreshClaudeTokenFromHost: (hostId: string) =>
    request<{ ok: true; hostId: string }>("/api/auth/claude-token/refresh-from-host", {
      method: "POST",
      body: JSON.stringify({ hostId }),
    }),

  createSecret: (data: { name: string; value: string; scope?: string }) =>
    request<{ name: string; scope: string; validation?: { valid: boolean; error?: string } }>(
      "/api/secrets",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    ),

  /** Secret names work can pick for its pod: the org's and the viewer's own (never values). */
  listPickableSecrets: () => request<{ secrets: PickableSecret[] }>("/api/secrets/pickable"),

  /** The New work form's remembered runtime + per-runtime agent options (`{}` when none). */
  getWorkDefaults: () => request<{ defaults: WorkFormDefaults }>("/api/me/work-defaults"),

  /** Merge into the remembered settings: `runtime` replaces; each runtime's options replace its own. */
  putWorkDefaults: (data: WorkFormDefaults) =>
    request<{ defaults: WorkFormDefaults }>("/api/me/work-defaults", {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // Agent credentials: how the agent signs in (its keys and tokens, Bedrock providers)
  listAgentCredentials: (agentType: string, owner: "workspace" | "me") =>
    request<AgentCredentialOptions>(
      `/api/agents/credentials?agentType=${encodeURIComponent(agentType)}&owner=${owner}`,
    ),

  /** Stores a sign-in secret for the agent; the value is never returned. */
  createAgentCredential: (data: CreateAgentCredentialInput) =>
    request<{ credential: AgentCredential }>("/api/agents/credentials", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  /** Checks a value against the service without storing it. */
  verifyAgentCredential: (data: VerifyAgentCredentialInput) =>
    request<VerifyAgentCredentialResult>("/api/agents/credentials/verify", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Model providers (Amazon Bedrock for Claude Code / Codex)
  listModelProviders: () => request<{ providers: ModelProvider[] }>("/api/model-providers"),

  createModelProvider: (data: CreateModelProviderInput) =>
    request<{ provider: ModelProvider }>("/api/model-providers", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateModelProvider: (id: string, data: UpdateModelProviderInput) =>
    request<{ provider: ModelProvider }>(`/api/model-providers/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteModelProvider: (id: string) =>
    request<void>(`/api/model-providers/${id}`, { method: "DELETE" }),

  /** `userId` (admins only, with `scope: "user"`): delete someone else's private secret. */
  deleteSecret: (name: string, scope?: string, userId?: string) => {
    const params = new URLSearchParams();
    if (scope) params.set("scope", scope);
    if (userId) params.set("userId", userId);
    const qs = params.toString();
    return request<void>(`/api/secrets/${name}${qs ? `?${qs}` : ""}`, { method: "DELETE" });
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

  reEnableTicketProvider: (id: string) =>
    request<{ provider: any }>(`/api/tickets/providers/${id}/re-enable`, { method: "PATCH" }),

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

  /** GitHub repos the server's stored credentials can reach (the Add repository picker). */
  browseGitHubRepos: (params: { q?: string; page?: number; perPage?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.page) qs.set("page", String(params.page));
    if (params.perPage) qs.set("perPage", String(params.perPage));
    const query = qs.toString();
    return request<{
      repos: Array<{
        fullName: string;
        cloneUrl: string;
        htmlUrl: string;
        defaultBranch: string;
        isPrivate: boolean;
        description: string | null;
        pushedAt: string | null;
      }>;
      page: number;
      perPage: number;
      hasMore: boolean;
      truncated?: boolean;
      error?: string;
    }>(`/api/repos/github/accessible${query ? `?${query}` : ""}`);
  },

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

  validateAwsCredentials: (creds: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    region: string;
  }) =>
    request<{ valid: boolean; error?: string; user?: { login: string; name: string } }>(
      "/api/setup/validate/aws-credentials",
      { method: "POST", body: JSON.stringify(creds) },
    ),

  listCodecommitRepos: (creds: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    region: string;
  }) =>
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
    }>("/api/setup/repos/codecommit", {
      method: "POST",
      body: JSON.stringify(creds),
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
      subscription: {
        available: boolean;
        expiresAt?: string;
        error?: string;
        expired?: boolean;
        lastValidated?: string | null;
      };
    }>("/api/auth/status"),

  refreshAuth: () =>
    request<{
      subscription: { available: boolean; expiresAt?: string; error?: string };
    }>("/api/auth/refresh", { method: "POST" }),

  getUsage: (opts?: { fresh?: boolean }) =>
    request<{
      usage: {
        available: boolean;
        hasRecentAuthFailure?: boolean;
        authFailures?: { claude: boolean; github: boolean };
        fiveHour?: { utilization: number | null; resetsAt: string | null };
        sevenDay?: { utilization: number | null; resetsAt: string | null };
        sevenDaySonnet?: { utilization: number | null; resetsAt: string | null };
        sevenDayOpus?: { utilization: number | null; resetsAt: string | null };
        /** Per-model 7-day limits (e.g. Fable) — a model can be capped while the account-wide 7-day is fine. */
        sevenDayModels?: Array<{
          model: string;
          utilization: number | null;
          resetsAt: string | null;
          severity: string | null;
        }>;
        extraUsage?: {
          isEnabled: boolean;
          monthlyLimit: number | null;
          usedCredits: number | null;
          utilization: number | null;
        };
        error?: string;
      };
    }>(`/api/auth/usage${opts?.fresh ? "?fresh=1" : ""}`),

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
    return request<{ issues: any[]; errors?: IssueSourceError[] }>(
      `/api/issues${query ? `?${query}` : ""}`,
    );
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
        /** The page the row opens (a task, a Job run, a session, an agent, a review). */
        href: string;
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
        href: string;
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
      /** Nobody can sign in yet: the setup wizard's Sign-in step configures the first provider. */
      setupRequired?: boolean;
    }>("/api/auth/providers"),

  // Sign-in configuration (Settings → Sign-in, the setup wizard's Sign-in step).
  // `setupToken` is sent while nobody can sign in yet (or no deployment admin exists).
  getSignInConfig: (setupToken?: string) =>
    request<SignInConfig>("/api/auth/sign-in", { headers: setupTokenHeader(setupToken) }),
  saveSignInProvider: (
    provider: string,
    data: {
      clientId: string;
      clientSecret?: string;
      allowedDomains?: string[];
      enabled?: boolean;
      displayName?: string | null;
      organizationName?: string;
    },
    setupToken?: string,
  ) =>
    request<{ provider: SignInProviderView; bootstrap: boolean }>(`/api/auth/sign-in/${provider}`, {
      method: "PUT",
      body: JSON.stringify(data),
      headers: setupTokenHeader(setupToken),
    }),
  deleteSignInProvider: (provider: string) =>
    request<void>(`/api/auth/sign-in/${provider}`, { method: "DELETE" }),
  listDeploymentAdmins: () => request<{ admins: DeploymentAdmin[] }>("/api/auth/deployment-admins"),
  addDeploymentAdmin: (email: string) =>
    request<{ admin: DeploymentAdmin }>("/api/auth/deployment-admins", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  removeDeploymentAdmin: (id: string) =>
    request<void>(`/api/auth/deployment-admins/${id}`, { method: "DELETE" }),
  claimDeploymentAdmin: (setupToken: string) =>
    request<{ ok: boolean }>("/api/auth/deployment-admins/claim", {
      method: "POST",
      headers: setupTokenHeader(setupToken),
    }),

  getGitHubAppStatus: () =>
    request<{ configured: boolean; appId?: string; installationId?: string }>(
      "/api/github-app/status",
    ),

  getSessionRecovery: (kind: "pod" | "local", id: string) =>
    request<{
      state: "live" | "reconnecting" | "resumable" | "lost" | "ended";
      message: string;
      automaticReplay: false;
    }>(`/api/session-recovery/${kind}/${id}`),
  createSessionShare: (kind: "pod" | "local", id: string) =>
    request<{ id: string; expiresAt: string; path: string }>(`/api/session-shares/${kind}/${id}`, {
      method: "POST",
      body: JSON.stringify({ hours: 24 }),
    }),
  listSessionShares: (kind: "pod" | "local", id: string) =>
    request<{ shares: Array<{ id: string; expiresAt: string; revokedAt: string | null }> }>(
      `/api/session-shares/${kind}/${id}`,
    ),
  revokeSessionShare: (kind: "pod" | "local", id: string, shareId: string) =>
    request(`/api/session-shares/${kind}/${id}/${shareId}`, { method: "DELETE" }),
  redeemSessionShare: (token: string) =>
    request<{ kind: "pod" | "local"; targetId: string }>("/api/session-shares/redeem", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),

  getCurrentUser: () =>
    request<{
      user: {
        id: string;
        provider: string;
        email: string;
        displayName: string;
        /** Provider handle (GitHub login / GitLab username); null when unknown. */
        username?: string | null;
        avatarUrl: string | null;
        workspaceId: string | null;
        workspaceRole: string | null;
        /** May change how everyone signs in (Settings → Sign-in). */
        deploymentAdmin?: boolean;
      };
      authDisabled: boolean;
    }>("/api/auth/me"),

  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  // Users
  lookupUserByEmail: (email: string) =>
    request<{
      user: {
        id: string;
        email: string;
        displayName: string;
        avatarUrl: string | null;
      };
    }>(`/api/users/lookup?email=${encodeURIComponent(email)}`),

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

  createSession: (data: { repoUrl: string; title?: string }) =>
    request<{ session: any }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  endSession: (id: string) =>
    request<{ session: any }>(`/api/sessions/${id}/end`, { method: "POST" }),

  getSessionChat: (sessionId: string, params?: { limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set("limit", String(params.limit));
    const query = qs.toString();
    return request<{ events: any[] }>(`/api/sessions/${sessionId}/chat${query ? `?${query}` : ""}`);
  },

  getSessionPrs: (sessionId: string) => request<{ prs: any[] }>(`/api/sessions/${sessionId}/prs`),

  addSessionPr: (sessionId: string, data: { prUrl: string; prNumber: number }) =>
    request<{ pr: any }>(`/api/sessions/${sessionId}/prs`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getWsToken: () => request<{ token: string }>("/api/auth/ws-token"),

  // Personal access tokens (API keys)
  listApiKeys: () => request<{ keys: ApiKeySummary[] }>("/api/auth/api-keys"),
  createApiKey: (data: { name?: string; expiresAt?: string }) =>
    request<ApiKeyCreated>("/api/auth/api-keys", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  revokeApiKey: (id: string) =>
    request<{ ok: boolean }>(`/api/auth/api-keys/${id}`, { method: "DELETE" }),

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
        /** Email domains whose people join on sign-in. */
        autoJoinDomains?: string[];
        autoJoinRole?: "member" | "viewer" | "admin";
        /** Pods get only the secrets a piece of work picks. */
        restrictPodSecrets?: boolean;
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
    /** `me` makes it the caller's private one; the organization's (default) is shared. */
    owner?: "workspace" | "me";
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
    /** `me` makes it the caller's private one; the organization's (default) is shared. */
    owner?: "workspace" | "me";
    description?: string;
    prompt: string;
    repoUrl?: string;
    layout?: "commands" | "skill-dir";
    files?: Array<{ relativePath: string; content: string }>;
    agentTypes?: string[];
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

  // Installed (marketplace-sourced) Skills — Phase 2 of issue #497
  listInstalledSkills: (scope?: string) => {
    const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
    return request<{ skills: any[] }>(`/api/installed-skills${qs}`);
  },
  getInstalledSkill: (id: string) => request<{ skill: any }>(`/api/installed-skills/${id}`),
  createInstalledSkill: (data: {
    name: string;
    /** `me` makes it the caller's private one; the organization's (default) is shared. */
    owner?: "workspace" | "me";
    description?: string;
    sourceUrl: string;
    ref?: string;
    subpath?: string;
    repoUrl?: string;
    agentTypes?: string[];
    enabled?: boolean;
  }) =>
    request<{ skill: any }>("/api/installed-skills", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateInstalledSkill: (id: string, data: Record<string, unknown>) =>
    request<{ skill: any }>(`/api/installed-skills/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteInstalledSkill: (id: string) =>
    request<void>(`/api/installed-skills/${id}`, { method: "DELETE" }),
  syncInstalledSkill: (id: string) =>
    request<{ skill: any }>(`/api/installed-skills/${id}/sync`, {
      method: "POST",
    }),

  // PR Reviews — canonical endpoints live under /api/pr-reviews.
  listPullRequests: (params?: { repoId?: string }) => {
    const qs = new URLSearchParams();
    if (params?.repoId) qs.set("repoId", params.repoId);
    const query = qs.toString();
    return request<{ pullRequests: any[] }>(`/api/pull-requests${query ? `?${query}` : ""}`);
  },

  createPrReview: (data: { prUrl: string }) =>
    request<{ review: any; run?: any }>("/api/pr-reviews", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getPrReview: (id: string) => request<{ review: any }>(`/api/pr-reviews/${id}`),

  listPrReviewRuns: (id: string) => request<{ runs: any[] }>(`/api/pr-reviews/${id}/runs`),

  updatePrReview: (
    id: string,
    data: {
      summary?: string | null;
      verdict?: "approve" | "request_changes" | "comment" | null;
      fileComments?: Array<{ path: string; line?: number; side?: string; body: string }> | null;
    },
  ) =>
    request<{ review: any }>(`/api/pr-reviews/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  submitPrReview: (id: string) =>
    request<{ review: any; reviewUrl?: string }>(`/api/pr-reviews/${id}/submit`, {
      method: "POST",
    }),

  reReviewPr: (id: string) =>
    request<{ review: any; run: any }>(`/api/pr-reviews/${id}/re-review`, {
      method: "POST",
    }),

  cancelPrReview: (id: string) =>
    request<{ ok: boolean }>(`/api/pr-reviews/${id}/cancel`, { method: "POST" }),

  listPrReviewLogs: (id: string, runId?: string) => {
    const q = runId ? `?runId=${encodeURIComponent(runId)}` : "";
    return request<{ logs: any[]; runId?: string }>(`/api/pr-reviews/${id}/logs${q}`);
  },

  listPrReviewChat: (id: string) =>
    request<{
      messages: Array<{
        id: string;
        prReviewId: string;
        runId: string | null;
        role: "user" | "assistant";
        content: string;
        createdAt: string;
      }>;
    }>(`/api/pr-reviews/${id}/chat`),

  postPrReviewChat: (id: string, message: string) =>
    request<{ runId: string; prReviewId: string }>(`/api/pr-reviews/${id}/chat`, {
      method: "POST",
      body: JSON.stringify({ message }),
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
    defaultReviewAgentType?: string | null;
    defaultReviewModel?: string | null;
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
  listWorkflows: () => request<{ workflows: any[] }>("/api/jobs"),

  getJobStats: () =>
    request<{
      stats: {
        total: number;
        queued: number;
        running: number;
        failed: number;
        completed: number;
      };
    }>("/api/jobs/stats"),

  getPersistentAgentStats: () =>
    request<{
      stats: {
        total: number;
        idle: number;
        queued: number;
        running: number;
        paused: number;
        failed: number;
        archived: number;
      };
    }>("/api/persistent-agents/stats"),

  getSessionStats: () =>
    request<{
      stats: {
        total: number;
        active: number;
        ended: number;
      };
    }>("/api/sessions/stats"),

  getWorkflow: (id: string) => request<{ workflow: any }>(`/api/jobs/${id}`),

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
    maxPodInstances?: number;
    maxAgentsPerPod?: number;
    enabled?: boolean;
    environmentSpec?: Record<string, unknown>;
    paramsSchema?: Record<string, unknown>;
    runTarget?: "cluster" | "local";
    localHostId?: string | null;
    localDir?: string | null;
    localSessionMode?: "headless" | "interactive" | null;
  }) =>
    request<{ workflow: any }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateWorkflow: (id: string, data: Record<string, unknown>) =>
    request<{ workflow: any }>(`/api/jobs/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteWorkflow: (id: string) => request<void>(`/api/jobs/${id}`, { method: "DELETE" }),

  cloneWorkflow: (id: string) =>
    request<{ workflow: any }>(`/api/jobs/${id}/clone`, { method: "POST" }),

  runWorkflow: (workflowId: string, params?: Record<string, unknown> | null) =>
    request<{ run: any }>(`/api/jobs/${workflowId}/runs`, {
      method: "POST",
      body: JSON.stringify({ params: params ?? null }),
    }),

  listWorkflowRuns: (workflowId: string, limit?: number) => {
    const qs = limit ? `?limit=${limit}` : "";
    return request<{ runs: any[] }>(`/api/jobs/${workflowId}/runs${qs}`);
  },

  getWorkflowRun: (id: string) => request<{ run: any }>(`/api/workflow-runs/${id}`),

  // Workflow Triggers
  listWorkflowTriggers: (workflowId: string) =>
    request<{ triggers: any[] }>(`/api/jobs/${workflowId}/triggers`),

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
      type: TriggerType;
      config?: Record<string, unknown>;
      paramMapping?: Record<string, unknown>;
      enabled?: boolean;
    },
  ) =>
    request<{ trigger: any }>(`/api/jobs/${workflowId}/triggers`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateWorkflowTrigger: (workflowId: string, triggerId: string, data: Record<string, unknown>) =>
    request<{ trigger: any }>(`/api/jobs/${workflowId}/triggers/${triggerId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteWorkflowTrigger: (workflowId: string, triggerId: string) =>
    request<void>(`/api/jobs/${workflowId}/triggers/${triggerId}`, {
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
  listConnectionProviders: () =>
    request<{ providers: ConnectionProvider[] }>("/api/connection-providers"),

  listConnections: () => request<{ connections: Connection[] }>("/api/connections"),

  getConnection: (id: string) => request<{ connection: Connection }>(`/api/connections/${id}`),

  /**
   * Everything work can be connected to — provider connections, bare
   * secrets, hand-written MCP servers — as one list (`kind` says which).
   */
  listConnectionCatalog: () =>
    request<{ entries: WorkEnvironmentEntry[] }>("/api/connections/catalog"),

  createConnection: (data: {
    name: string;
    providerSlug?: string;
    providerId?: string;
    config?: Record<string, unknown>;
    owner?: "workspace" | "me";
    enabled?: boolean;
    assignments?: Array<{ repoId?: string | null; agentTypes?: string[]; permission?: string }>;
  }) =>
    request<{ connection: Connection }>("/api/connections", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  /** Merges `config` (a blank secret keeps its value, null clears it); `assignments` replaces them. */
  updateConnection: (id: string, data: UpdateConnectionInput) =>
    request<{ connection: Connection }>(`/api/connections/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteConnection: (id: string) => request<void>(`/api/connections/${id}`, { method: "DELETE" }),

  /** Runs the provider's health check and records the outcome on the connection. */
  testConnection: (id: string) =>
    request<{ connection: Connection }>(`/api/connections/${id}/test`, {
      method: "POST",
    }),

  listConnectionAssignments: (connectionId: string) =>
    request<{ assignments: ConnectionAssignment[] }>(
      `/api/connections/${connectionId}/assignments`,
    ),

  createConnectionAssignment: (connectionId: string, data: Record<string, unknown>) =>
    request<{ assignment: ConnectionAssignment }>(`/api/connections/${connectionId}/assignments`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  listRepoConnections: (repoId: string) =>
    request<{ connections: RepoConnection[] }>(`/api/repos/${repoId}/connections`),

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

  // ── Work: every kind of work as one resource ──

  /** The Work list: every kind of work the caller can see, needs-you first. */
  listWork: () => request<{ rows: WorkRow[] }>("/api/work"),

  /** Any piece of work by id, whatever its kind (a definition comes back as its stored row). */
  getWork: (id: string) =>
    request<{ source: WorkSource; row: WorkRow; work: Record<string, any> }>(`/api/work/${id}`),

  /**
   * Create work from its five attributes; the server derives the kind. A 409's
   * `details` says what was taken (`name_taken`, `webhook_path_taken`).
   */
  createWork: (spec: WorkSpec) =>
    request<WorkCreated>("/api/work", { method: "POST", body: JSON.stringify(spec) }),

  /** Save a definition from its attributes (its kind is fixed; its trigger follows When). */
  updateWork: (id: string, spec: WorkSpec) =>
    request<WorkCreated>(`/api/work/${id}`, { method: "PATCH", body: JSON.stringify(spec) }),

  /** The triggers of a definition or a persistent agent. */
  listWorkTriggers: (id: string) => request<{ triggers: any[] }>(`/api/work/${id}/triggers`),
  /** Change one of a definition's triggers (its config, or enabled). */
  updateWorkTrigger: (id: string, triggerId: string, data: Record<string, unknown>) =>
    request<{ trigger: any }>(`/api/work/${id}/triggers/${triggerId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  /**
   * What pod work's agent could get — connections, MCP servers, skills, each
   * marked when the repo / workspace gives it by default — and the repo's own
   * setup commands and PR settings, for the Where section's Environment.
   */
  getWorkEnvironment: (q: {
    repoUrl?: string | null;
    agentType: string;
    owner: "workspace" | "me";
  }) => {
    const params = new URLSearchParams({ agentType: q.agentType, owner: q.owner });
    if (q.repoUrl) params.set("repoUrl", q.repoUrl);
    return request<WorkEnvironmentOptions>(`/api/work/environment?${params}`);
  },

  // ── Unified Tasks (polymorphic over repo-task | repo-blueprint | standalone) ──

  /**
   * List tasks, polymorphic. Without a `type`, returns repo-tasks in the
   * existing enriched shape (back-compat). With a `type`, returns the
   * requested kind tagged with a `type` field per row.
   */
  listTasksUnified: (opts?: {
    type?: "repo-task" | "repo-blueprint" | "standalone" | "all";
    state?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (opts?.type) qs.set("type", opts.type);
    if (opts?.state) qs.set("state", opts.state);
    if (opts?.limit) qs.set("limit", String(opts.limit));
    if (opts?.offset) qs.set("offset", String(opts.offset));
    const query = qs.toString();
    return request<{ tasks: any[]; limit: number; offset: number; total?: number }>(
      `/api/tasks${query ? `?${query}` : ""}`,
    );
  },

  /** List runs under a Task (blueprint/standalone only). */
  listTaskRuns: (id: string) => request<{ runs: any[] }>(`/api/tasks/${id}/runs`),

  // ── Task Configs (legacy — prefer unified /api/tasks endpoints above) ─────

  getTaskConfig: (id: string) => request<{ taskConfig: any }>(`/api/task-configs/${id}`),

  updateTaskConfig: (
    id: string,
    data: Partial<{
      name: string;
      description: string | null;
      title: string;
      prompt: string;
      promptTemplateId: string | null;
      repoUrl: string;
      repoBranch: string;
      agentType: string | null;
      /** Per-run agent parameters (model, effort, …); null = the repo's defaults. */
      agentOptions: Record<string, string | boolean> | null;
      maxRetries: number;
      priority: number;
      enabled: boolean;
      runTarget: "cluster" | "local";
      localHostId: string | null;
      localDir: string | null;
      localSessionMode: "headless" | "interactive" | null;
      owner: ResourceOwner;
      podSecrets: string[] | null;
      /** PR follow-through for spawned tasks; null = the repo's settings. */
      autoResume: boolean | null;
      autoMerge: boolean | null;
    }>,
  ) =>
    request<{ taskConfig: any }>(`/api/task-configs/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteTaskConfig: (id: string) => request<null>(`/api/task-configs/${id}`, { method: "DELETE" }),

  runTaskConfig: (id: string) =>
    request<{ taskId: string }>(`/api/task-configs/${id}/run`, { method: "POST" }),

  listTaskConfigTriggers: (id: string) =>
    request<{ triggers: any[] }>(`/api/task-configs/${id}/triggers`),

  createTaskConfigTrigger: (
    id: string,
    data: {
      type: TriggerType;
      config?: Record<string, unknown>;
      paramMapping?: Record<string, unknown>;
      enabled?: boolean;
    },
  ) =>
    request<{ trigger: any }>(`/api/task-configs/${id}/triggers`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateTaskConfigTrigger: (
    id: string,
    triggerId: string,
    data: Partial<{
      config: Record<string, unknown>;
      paramMapping: Record<string, unknown>;
      enabled: boolean;
    }>,
  ) =>
    request<{ trigger: any }>(`/api/task-configs/${id}/triggers/${triggerId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteTaskConfigTrigger: (id: string, triggerId: string) =>
    request<null>(`/api/task-configs/${id}/triggers/${triggerId}`, { method: "DELETE" }),

  // ── Named templates (prompt | review | job | task) ────────────────────────

  listTemplates: (kind?: string) => {
    const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
    return request<{ templates: any[] }>(`/api/prompt-templates${qs}`);
  },

  createNamedTemplate: (data: {
    name: string;
    /** `me` makes it the caller's private one; the organization's (default) is shared. */
    owner?: "workspace" | "me";
    template: string;
    kind?: "prompt" | "review" | "job" | "task";
    description?: string;
    paramsSchema?: Record<string, unknown>;
    defaultAgentType?: string;
  }) =>
    request<{ template: any }>("/api/prompt-templates/named", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateNamedTemplate: (
    id: string,
    data: Partial<{
      name: string;
      template: string;
      kind: "prompt" | "review" | "job" | "task";
      description: string | null;
      paramsSchema: Record<string, unknown> | null;
      defaultAgentType: string | null;
    }>,
  ) =>
    request<{ template: any }>(`/api/prompt-templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteNamedTemplate: (id: string) =>
    request<null>(`/api/prompt-templates/${id}`, { method: "DELETE" }),

  previewTemplate: (id: string, params: Record<string, unknown>) =>
    request<{ rendered: string }>(`/api/prompt-templates/${id}/preview`, {
      method: "POST",
      body: JSON.stringify({ params }),
    }),

  // Agent Options — per-provider model & runtime-option catalog
  /**
   * `hostId`: a run on that machine — Codex's models as that machine's Codex
   * lists them (otherwise the freshest list any of your machines reported).
   */
  getAgentProviderOptions: (provider: string, opts?: { refresh?: boolean; hostId?: string }) => {
    const params = new URLSearchParams();
    if (opts?.refresh) params.set("refresh", "true");
    if (opts?.hostId) params.set("hostId", opts.hostId);
    const qs = params.size ? `?${params}` : "";
    return request<{
      provider: string;
      source: "baseline" | "live";
      cached: boolean;
      refreshedAt: number | null;
      error?: string;
      /** Where a machine-reported list came from ("Codex on MacBook-Pro"). */
      liveFrom?: string;
      catalog: unknown;
    }>(`/api/agents/${provider}/options${qs}`);
  },

  refreshAgentProviderOptions: (provider: string) =>
    request<{
      provider: string;
      source: "baseline" | "live";
      cached: boolean;
      refreshedAt: number | null;
      error?: string;
      catalog: unknown;
    }>(`/api/agents/${provider}/options/refresh`, { method: "POST" }),

  // ── Persistent Agents ──────────────────────────────────────────────────
  listPersistentAgents: () => request<{ agents: any[] }>(`/api/persistent-agents`),

  getPersistentAgent: (id: string) =>
    request<{ agent: any; inbox: { pending: number; oldest: string | null } }>(
      `/api/persistent-agents/${id}`,
    ),

  deletePersistentAgent: (id: string) =>
    request<undefined>(`/api/persistent-agents/${id}`, { method: "DELETE" }),

  sendPersistentAgentMessage: (
    id: string,
    body: string,
    opts?: { broadcasted?: boolean; senderName?: string },
  ) =>
    request<{ ok: boolean }>(`/api/persistent-agents/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({ body, ...opts }),
    }),

  listPersistentAgentMessages: (id: string, limit?: number) => {
    const qs = limit ? `?limit=${limit}` : "";
    return request<{ messages: any[] }>(`/api/persistent-agents/${id}/messages${qs}`);
  },

  listPersistentAgentTurns: (id: string, limit?: number) => {
    const qs = limit ? `?limit=${limit}` : "";
    return request<{ turns: any[] }>(`/api/persistent-agents/${id}/turns${qs}`);
  },

  getPersistentAgentTurn: (id: string, turnId: string) =>
    request<{ turn: any; logs: any[] }>(`/api/persistent-agents/${id}/turns/${turnId}`),

  controlPersistentAgent: (id: string, intent: "pause" | "resume" | "archive" | "restart") =>
    request<{ ok: boolean; intent: string }>(`/api/persistent-agents/${id}/control`, {
      method: "POST",
      body: JSON.stringify({ intent }),
    }),

  // ── Optio Local (terminals on the user's own machines) ─────────────────

  listLocalHosts: () => request<{ hosts: any[] }>("/api/local/hosts"),

  deleteLocalHost: (id: string) => request<{}>(`/api/local/hosts/${id}`, { method: "DELETE" }),

  /**
   * Add a directory (absolute, or under ~) to a machine's allowlist — its
   * daemon does what `optio local add` would there. `path` in the answer is
   * the directory as the machine resolved it.
   */
  refreshLocalHostLimits: (hostId: string) =>
    request<{ limits: any }>(`/api/local/hosts/${hostId}/limits/refresh`, { method: "POST" }),

  addLocalHostDir: (hostId: string, path: string) =>
    request<{ host: any; path: string }>(`/api/local/hosts/${hostId}/dirs`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),

  /** Take a directory off a machine's allowlist (`optio local remove` there). */
  removeLocalHostDir: (hostId: string, path: string) =>
    request<{ host: any; path: string }>(
      `/api/local/hosts/${hostId}/dirs?path=${encodeURIComponent(path)}`,
      { method: "DELETE" },
    ),

  /** One computer registered twice (its hostname changed): fold `id` (offline) into `intoHostId`. */
  mergeLocalHost: (id: string, intoHostId: string) =>
    request<{
      host: any;
      moved: { terminals: number; automations: number; runLocations: number };
    }>(`/api/local/hosts/${id}/merge`, {
      method: "POST",
      body: JSON.stringify({ intoHostId }),
    }),

  listLocalTerminals: (params?: { hostId?: string; state?: string }) => {
    const qs = new URLSearchParams();
    if (params?.hostId) qs.set("hostId", params.hostId);
    if (params?.state) qs.set("state", params.state);
    const query = qs.toString();
    return request<{ terminals: any[] }>(`/api/local/terminals${query ? `?${query}` : ""}`);
  },

  getLocalTerminal: (id: string) => request<{ terminal: any }>(`/api/local/terminals/${id}`),

  /** The session's conversation (prompts, replies, tool calls); `after` = only entries past that seq. */
  getLocalTerminalTranscript: (id: string, params?: { after?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (params?.after) qs.set("after", String(params.after));
    if (params?.limit) qs.set("limit", String(params.limit));
    const query = qs.toString();
    return request<{ entries: LocalTranscriptEntry[]; complete: boolean; backfilling?: boolean }>(
      `/api/local/terminals/${id}/transcript${query ? `?${query}` : ""}`,
    );
  },

  listRecentRuns: (limit = 12) =>
    request<{
      runs: Array<{
        id: string;
        kind: "task" | "job-run" | "agent-turn";
        title: string;
        state: string;
        parentId: string | null;
        href: string;
        where: string | null;
        detail: string | null;
        agentType: string | null;
        costUsd: string | null;
        at: string;
        startedAt: string | null;
        endedAt: string | null;
      }>;
    }>(`/api/runs/recent?limit=${limit}`),

  updateLocalTerminal: (id: string, data: { title: string }) =>
    request<{ terminal: any }>(`/api/local/terminals/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  createLocalTerminal: (data: {
    hostId: string;
    dir?: string;
    title?: string;
    spec?:
      | { kind: "shell" }
      | { kind: "command"; command: string }
      | {
          kind: "agent";
          agent: string;
          prompt?: string;
          model?: string;
          /** Claude Code `--effort` / Codex reasoning effort. */
          effort?: string;
          /** Claude Code's `--permission-mode` (the daemon's default is auto); Codex: bypassPermissions = `--yolo`. */
          permissionMode?: "auto" | "bypassPermissions" | "default";
          baseBranch?: string;
        };
    /** Agent spawns: `{ modelProvider }` picks a model provider (Bedrock). */
    agentOptions?: Record<string, string | boolean>;
    ticket?: {
      repoId: string;
      issueNumber: number;
      title: string;
      body?: string;
      agentType?: string;
    };
  }) =>
    request<{ terminal: any }>("/api/local/terminals", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  startLocalTerminal: (id: string) =>
    request<{ terminal: any }>(`/api/local/terminals/${id}/start`, { method: "POST" }),

  killLocalTerminal: (id: string, signal?: "SIGTERM" | "SIGINT" | "SIGKILL" | "SIGHUP") =>
    request<{}>(`/api/local/terminals/${id}/kill`, {
      method: "POST",
      body: JSON.stringify(signal ? { signal } : {}),
    }),

  deleteLocalTerminal: (id: string) =>
    request<{}>(`/api/local/terminals/${id}`, { method: "DELETE" }),

  /** Write to a running terminal's stdin (REST; 409 unless it's running). */
  sendLocalTerminalInput: (id: string, data: string) =>
    request<{}>(`/api/local/terminals/${id}/input`, {
      method: "POST",
      body: JSON.stringify({ data }),
    }),

  /** Open an exited agent session again as a fresh interactive terminal. */
  /** `reused`: a resume of this session that hasn't ended, returned instead of a second one. */
  resumeLocalTerminal: (id: string) =>
    request<{ terminal: any; reused?: boolean }>(`/api/local/terminals/${id}/resume`, {
      method: "POST",
      body: "{}",
    }),

  listLocalBlueprints: () => request<{ blueprints: any[] }>("/api/local/blueprints"),

  getLocalBlueprint: (id: string) => request<{ blueprint: any }>(`/api/local/blueprints/${id}`),

  createLocalBlueprint: (data: {
    name: string;
    description?: string;
    hostId?: string;
    dir?: string;
    repoUrl?: string;
    /** Agent spawns work on a new branch off this base and open a PR; unset = the dir as it is. */
    baseBranch?: string | null;
    commandTemplate: string;
    /** `{{param}}` template each spawned terminal is titled from; null = the name. */
    runTitle?: string | null;
    /** Saved prompt (Prompts library) rendered as the agent prompt instead of commandTemplate. */
    promptTemplateId?: string | null;
    /** Run the rendered template as this agent's prompt; null = raw shell command. */
    agent?: "claude-code" | "codex" | "cursor" | "gemini" | "opencode" | null;
    spawnMode?: "auto" | "hold";
    /** Agent spawns: stay open for chat (default) or exit when the turn is done. */
    sessionMode?: "interactive" | "headless";
    /** Agent spawns: model, effort, permission mode (keyed like the catalog); null = the machine's own. */
    agentOptions?: Record<string, string | boolean> | null;
  }) =>
    request<{ blueprint: any }>("/api/local/blueprints", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateLocalBlueprint: (
    id: string,
    data: Partial<{
      name: string;
      description: string | null;
      hostId: string | null;
      dir: string | null;
      repoUrl: string | null;
      /** Agent spawns work on a new branch off this base and open a PR; null = the dir as it is. */
      baseBranch: string | null;
      commandTemplate: string;
      runTitle: string | null;
      /** Saved prompt (Prompts library) rendered as the agent prompt instead of commandTemplate. */
      promptTemplateId: string | null;
      /** Run the rendered template as this agent's prompt; null = raw shell command. */
      agent: "claude-code" | "codex" | "cursor" | "gemini" | "opencode" | null;
      spawnMode: "auto" | "hold";
      sessionMode: "interactive" | "headless";
      agentOptions: Record<string, string | boolean> | null;
      enabled: boolean;
    }>,
  ) =>
    request<{ blueprint: any }>(`/api/local/blueprints/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteLocalBlueprint: (id: string) =>
    request<{}>(`/api/local/blueprints/${id}`, { method: "DELETE" }),

  spawnLocalBlueprint: (id: string, params?: Record<string, unknown>) =>
    request<{ terminal: any }>(`/api/local/blueprints/${id}/spawn`, {
      method: "POST",
      body: JSON.stringify({ params: params ?? {} }),
    }),

  listLocalBlueprintTriggers: (id: string) =>
    request<{ triggers: any[] }>(`/api/local/blueprints/${id}/triggers`),

  createLocalBlueprintTrigger: (
    id: string,
    data: {
      type: TriggerType;
      config?: Record<string, unknown>;
      paramMapping?: Record<string, unknown>;
      enabled?: boolean;
    },
  ) =>
    request<{ trigger: any }>(`/api/local/blueprints/${id}/triggers`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  updateLocalBlueprintTrigger: (
    id: string,
    triggerId: string,
    data: { config?: Record<string, unknown>; enabled?: boolean },
  ) =>
    request<{ trigger: any }>(`/api/local/blueprints/${id}/triggers/${triggerId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  deleteLocalBlueprintTrigger: (id: string, triggerId: string) =>
    request<{}>(`/api/local/blueprints/${id}/triggers/${triggerId}`, { method: "DELETE" }),

  // Config as code (docs/config-as-code.md)
  getConfigStatus: () => request<ConfigStatus>("/api/config/status"),
  syncConfigSource: (dryRun = false) =>
    request<ConfigApplyResult>(`/api/config/source/sync${dryRun ? "?dryRun=true" : ""}`, {
      method: "POST",
    }),
  applyConfig: (manifests: Array<{ path: string; document: unknown }>, dryRun = false) =>
    request<ConfigApplyResult>("/api/config/apply", {
      method: "POST",
      body: JSON.stringify({ manifests, dryRun }),
    }),
  exportConfig: (kind?: string, id?: string) => {
    const qs = new URLSearchParams();
    if (kind) qs.set("kind", kind);
    if (id) qs.set("id", id);
    const query = qs.toString();
    return request<{ manifests: ExportedManifest[] }>(
      `/api/config/export${query ? `?${query}` : ""}`,
    );
  },
  /** The browser URL that downloads the export (one resource, or everything) as YAML. */
  configExportUrl: (kind?: string, id?: string) => {
    const qs = new URLSearchParams({ download: "1" });
    if (kind) qs.set("kind", kind);
    if (id) qs.set("id", id);
    return `/api/config/export.yaml?${qs.toString()}`;
  },
  detachConfigObject: (objectId: string) =>
    request<void>(`/api/config/objects/${objectId}/detach`, { method: "POST" }),
};
