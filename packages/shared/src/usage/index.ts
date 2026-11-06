/** Usage is independent of whether a runtime can report a dollar estimate. */
export interface UsageMetrics {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: string | null;
  reportedCostUsd: string | null;
  estimatedCostUsd: string | null;
  runs: number;
  completedRuns: number;
  unpricedRuns: number;
  unmeasuredRuns: number;
  historicalRuns: number;
  retryCostUsd: string;
}
export interface UsageEntry extends UsageMetrics {
  id: string;
  kind: "person" | "work";
  name: string;
  avatarUrl: string | null;
  runtime?: string | null;
  triggerType?: string | null;
  triggerSource?: string | null;
  rank: number;
  changePercent: number | null;
  trend: number[];
}
export interface UsageBudget {
  id: string;
  name: string;
  subjectKind: "organization" | "person" | "work";
  subjectId: string | null;
  tokenLimit: number | null;
  costLimit: string | null;
  action: "notify" | "pause_new";
  enabled: boolean;
  usedTokens: number;
  usedCostUsd: string;
  fraction: number;
}
export interface UsageQuery {
  days?: number;
  kind?: "all" | "person" | "work";
  sort?: "tokens" | "cost" | "runs";
  page?: number;
  q?: string;
  subjectId?: string;
  model?: string;
  repoUrl?: string;
}
export interface UsageResponse {
  start: string;
  end: string;
  summary: UsageMetrics;
  previous: UsageMetrics;
  daily: Array<{ date: string; tokens: number; costUsd: string | null }>;
  leaderboard: UsageEntry[];
  totalEntries: number;
  page: number;
  pageSize: number;
  models: Array<{ model: string; tokens: number; costUsd: string | null; runs: number }>;
  budgets: UsageBudget[];
  canManageBudgets: boolean;
  canInspect: boolean;
  activity: Array<{
    id: string;
    name: string;
    href: string;
    tokens: number;
    costUsd: string | null;
    model: string | null;
    lastUsed: string;
  }>;
}
export interface SaveUsageBudget {
  name: string;
  subjectKind: UsageBudget["subjectKind"];
  subjectId?: string | null;
  tokenLimit?: number | null;
  costLimit?: string | null;
  action: UsageBudget["action"];
  enabled?: boolean;
}
