import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// Stub hooks and heavy dependencies so the page renders in jsdom.
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
  PipelineStatsBar: () => <div data-testid="pipeline-stats" />,
  UsagePanel: () => null,
  ClusterSummary: () => null,
  ActiveSessions: () => null,
  RecentTasks: () => <div data-testid="recent-tasks" />,
  RecentActivity: () => <div data-testid="recent-activity" />,
  PodsList: () => <div data-testid="pods-list" />,
  WelcomeHero: () => <div data-testid="welcome-hero" />,
  PerformanceSummary: () => null,
  AgentComparison: () => null,
  FailureInsights: () => null,
}));

const makeDashboardData = (overrides: Record<string, unknown> = {}) => ({
  taskStats: { total: 10, running: 1, failed: 3, needsAttention: 0 },
  recentTasks: [],
  repoCount: 2,
  cluster: { pods: [], events: [], repoPods: [] },
  loading: false,
  activeSessions: [],
  activeSessionCount: 0,
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

import OverviewPage from "./page";
import { useDashboardData } from "@/hooks/use-dashboard-data";

describe("OverviewPage — failed-tasks banner removed", () => {
  afterEach(() => cleanup());

  it("does not render the 'failed today' banner even when tasks have failures", () => {
    vi.mocked(useDashboardData).mockReturnValue(
      makeDashboardData({
        taskStats: { total: 10, running: 0, failed: 5, needsAttention: 0 },
      }) as any,
    );

    render(<OverviewPage />);

    // The old banner text should not appear anywhere.
    expect(screen.queryByText(/failed today/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ask Optio to help investigate/i)).not.toBeInTheDocument();
  });

  it("does not render the 'failed today' banner when failed count is 1", () => {
    vi.mocked(useDashboardData).mockReturnValue(
      makeDashboardData({
        taskStats: { total: 5, running: 0, failed: 1, needsAttention: 0 },
      }) as any,
    );

    render(<OverviewPage />);

    expect(screen.queryByText(/failed today/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ask Optio to help investigate/i)).not.toBeInTheDocument();
  });

  it("still renders the Overview heading and pipeline stats", () => {
    render(<OverviewPage />);

    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-stats")).toBeInTheDocument();
  });
});

describe("OverviewPage — section ordering", () => {
  afterEach(() => cleanup());

  it("renders Recent Tasks before Pods before Recent Activity", () => {
    render(<OverviewPage />);

    const recentTasks = screen.getByTestId("recent-tasks");
    const podsList = screen.getByTestId("pods-list");
    const recentActivity = screen.getByTestId("recent-activity");

    // compareDocumentPosition bit 4 (DOCUMENT_POSITION_FOLLOWING) means the
    // argument node comes after the reference node in document order.
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;

    // Recent Tasks should come before Pods
    expect(recentTasks.compareDocumentPosition(podsList) & FOLLOWING).toBeTruthy();
    // Pods should come before Recent Activity
    expect(podsList.compareDocumentPosition(recentActivity) & FOLLOWING).toBeTruthy();
    // Recent Tasks should come before Recent Activity
    expect(recentTasks.compareDocumentPosition(recentActivity) & FOLLOWING).toBeTruthy();
  });
});
