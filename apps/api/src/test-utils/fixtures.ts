/**
 * Shared test fixtures matching the canonical domain schemas.
 *
 * When a route attaches a response schema via `schema.response[200]`,
 * the type-provider serializer validates the actual reply body against
 * that schema. Tests that mock service methods must return objects that
 * match the schema or the serializer throws. Keeping full, realistic
 * mocks in one place avoids scattering duplicates across every test
 * file and makes it obvious when a new schema field needs to be added.
 *
 * Each fixture is a "factory" — spread it and override only the fields
 * that matter for a given test:
 *
 *     mockGetTask.mockResolvedValue({ ...mockTask, state: "failed" });
 */

export const mockTask = {
  id: "task-1",
  title: "Fix bug",
  prompt: "Fix the bug",
  repoUrl: "https://github.com/org/repo",
  repoBranch: "main",
  state: "running",
  agentType: "claude-code",
  containerId: null,
  sessionId: null,
  prUrl: null,
  prNumber: null,
  prState: null,
  prChecksStatus: null,
  prReviewStatus: null,
  prReviewComments: null,
  resultSummary: null,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  modelUsed: null,
  errorMessage: null,
  ticketSource: null,
  ticketExternalId: null,
  metadata: null,
  retryCount: 0,
  maxRetries: 3,
  priority: 100,
  parentTaskId: null,
  taskType: "coding",
  subtaskOrder: 0,
  blocksParent: false,
  worktreeState: null,
  lastPodId: null,
  workflowRunId: null,
  createdBy: null,
  ignoreOffPeak: false,
  lastActivityAt: null,
  activitySubstate: "active",
  workspaceId: "ws-1",
  lastMessageAt: null,
  createdAt: new Date("2026-04-11T12:00:00Z"),
  updatedAt: new Date("2026-04-11T12:00:00Z"),
  startedAt: null,
  completedAt: null,
} as const;

export const mockTaskEvent = {
  id: "ev-1",
  taskId: "task-1",
  fromState: "pending",
  toState: "queued",
  trigger: "task_submitted",
  message: null,
  userId: "user-1",
  createdAt: new Date("2026-04-11T12:00:00Z"),
};

export const mockLogEntry = {
  id: "log-1",
  taskId: "task-1",
  stream: "stdout",
  content: "hello",
  logType: "text",
  metadata: null,
  workflowRunId: null,
  timestamp: new Date("2026-04-11T12:00:00Z"),
};

export const mockTaskComment = {
  id: "comment-1",
  taskId: "task-1",
  userId: "user-1",
  content: "Looks good!",
  createdAt: new Date("2026-04-11T12:00:00Z"),
  updatedAt: new Date("2026-04-11T12:00:00Z"),
  user: {
    id: "user-1",
    displayName: "Test User",
    avatarUrl: null,
  },
};

export const mockTaskMessage = {
  id: "msg-1",
  taskId: "task-1",
  userId: "user-1",
  content: "Try again please",
  mode: "soft",
  workspaceId: "ws-1",
  createdAt: new Date("2026-04-11T12:00:00Z"),
  deliveredAt: null,
  ackedAt: null,
  deliveryError: null,
  user: {
    id: "user-1",
    displayName: "Test User",
    avatarUrl: null,
  },
};

export const mockWorkflow = {
  id: "wf-1",
  name: "Deploy",
  description: null,
  promptTemplate: "Deploy {{env}}",
  agentRuntime: "claude-code",
  model: null,
  maxTurns: null,
  budgetUsd: null,
  maxConcurrent: 1,
  maxRetries: 0,
  warmPoolSize: 0,
  maxPodInstances: 1,
  maxAgentsPerPod: 2,
  enabled: true,
  environmentSpec: null,
  paramsSchema: null,
  workspaceId: "ws-1",
  createdBy: "user-1",
  createdAt: new Date("2026-04-11T12:00:00Z"),
  updatedAt: new Date("2026-04-11T12:00:00Z"),
};

export const mockWorkflowRun = {
  id: "run-1",
  workflowId: "wf-1",
  triggerId: null,
  state: "queued",
  params: null,
  output: null,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  modelUsed: null,
  errorMessage: null,
  sessionId: null,
  podName: null,
  retryCount: 0,
  startedAt: null,
  finishedAt: null,
  createdAt: new Date("2026-04-11T12:00:00Z"),
  updatedAt: new Date("2026-04-11T12:00:00Z"),
};

export const mockWorkflowTrigger = {
  id: "trg-1",
  workflowId: "wf-1",
  targetType: "job",
  targetId: "wf-1",
  type: "manual",
  config: {},
  paramMapping: null,
  enabled: true,
  lastFiredAt: null,
  nextFireAt: null,
  createdAt: new Date("2026-04-11T12:00:00Z"),
  updatedAt: new Date("2026-04-11T12:00:00Z"),
};

export const mockInteractiveSession = {
  id: "session-1",
  repoUrl: "https://github.com/org/repo",
  userId: "user-1",
  worktreePath: "/repo-worktrees/session-1",
  branch: "main",
  state: "active",
  podId: null,
  costUsd: null,
  workspaceId: "ws-1",
  createdAt: new Date("2026-04-11T12:00:00Z"),
  endedAt: null,
};

export const mockSchedule = {
  id: "sch-1",
  name: "Nightly build",
  description: null,
  cronExpression: "0 0 * * *",
  enabled: true,
  taskConfig: {
    title: "Nightly",
    prompt: "Build",
    repoUrl: "https://github.com/org/repo",
    agentType: "claude-code",
  },
  workspaceId: "ws-1",
  createdBy: "user-1",
  nextRunAt: null,
  lastRunAt: null,
  createdAt: new Date("2026-04-11T12:00:00Z"),
  updatedAt: new Date("2026-04-11T12:00:00Z"),
};
