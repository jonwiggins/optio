import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// The Overview's usage meters by deployment: the Claude.ai windows by default
// (page.test.tsx), the model gateway's budgets with OPTIO_MODEL_ACCESS=gateway.
// Stub hooks and heavy dependencies so the page renders in jsdom.
let features = featuresFromEnv({});
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, gatewayOnly: features.modelAccess === "gateway", loaded: true }),
}));

vi.mock("@/hooks/use-page-title", () => ({
  usePageTitle: vi.fn(),
}));

vi.mock("@/hooks/use-optio-chat", () => ({
  useOptioChatStore: () => ({
    setPrefillInput: vi.fn(),
    open: vi.fn(),
  }),
}));

vi.mock("@/components/update-banner", () => ({
  UpdateBanner: () => null,
}));

// Stub every dashboard sub-component to a simple placeholder.
vi.mock("@/components/dashboard", () => ({
  UsagePanel: () => null,
  ClusterSummary: () => null,
  RecentActivity: () => <div data-testid="recent-activity" />,
  PodsList: () => <div data-testid="pods-list" />,
  WelcomeHero: () => <div data-testid="welcome-hero" />,
  AgentComparison: () => null,
  RecentRuns: () => <div data-testid="recent-tasks" />,
  WorkBoard: ({ rows }: { rows: unknown[] }) => (
    <div data-testid="sessions-board">{rows.length}</div>
  ),
  LimitsPanel: ({ providers }: { providers: unknown[] }) =>
    providers.length > 0 ? <div data-testid="limits" /> : null,
  GatewayLimitsPanel: () => <div data-testid="gateway-limits" />,
  collectProviderLimits: (usage: any) => (usage?.available ? [{ key: "claude" }] : []),
  NeedsYou: ({ items }: { items: unknown[] }) =>
    items.length > 0 ? <div data-testid="needs-you" /> : null,
  collectNeedsYou: (locals: any[], tasks: any[]) => [
    ...locals.filter((t) => t.attentionState === "needs_you"),
    ...tasks,
  ],
}));

const makeDashboardData = (overrides: Record<string, unknown> = {}) => ({
  taskStats: { total: 10, running: 1, failed: 3, needsAttention: 0 },
  recentTasks: [],
  repoCount: 2,
  cluster: { pods: [], events: [], repoPods: [] },
  loading: false,
  usage: null,
  metricsAvailable: false,
  metricsHistory: [],
  refresh: vi.fn(),
  refreshUsage: vi.fn(),
  ...overrides,
});

vi.mock("@/hooks/use-dashboard-data", () => ({
  useDashboardData: vi.fn(() => makeDashboardData()),
}));

vi.mock("@/hooks/use-work-feed", () => ({
  useWorkFeed: vi.fn(() => ({ rows: [], hosts: [], loading: false, refetch: vi.fn() })),
}));

import OverviewPage from "./page";
import { useDashboardData } from "@/hooks/use-dashboard-data";

describe("OverviewPage's usage meters", () => {
  afterEach(() => {
    cleanup();
    features = featuresFromEnv({});
  });

  it("shows the Claude.ai windows under the default deployment", () => {
    vi.mocked(useDashboardData).mockReturnValue(
      makeDashboardData({ usage: { available: true } }) as any,
    );
    render(<OverviewPage />);
    expect(screen.getByTestId("limits")).toBeInTheDocument();
    expect(screen.queryByTestId("gateway-limits")).not.toBeInTheDocument();
  });

  it("meters the gateway's budgets instead of the Claude.ai windows", () => {
    features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
    vi.mocked(useDashboardData).mockReturnValue(
      makeDashboardData({ usage: { available: true, authFailures: { claude: true } } }) as any,
    );
    render(<OverviewPage />);
    expect(screen.getByTestId("gateway-limits")).toBeInTheDocument();
    expect(screen.queryByTestId("limits")).not.toBeInTheDocument();
  });
});
