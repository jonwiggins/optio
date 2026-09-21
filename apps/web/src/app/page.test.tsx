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

const feedRow = (key: string, status: string, extra: Record<string, unknown> = {}) => ({
  key,
  source: "repo-task",
  href: `/tasks/${key}`,
  name: key,
  when: "now",
  where: { target: "pod", detail: null },
  who: "claude-code",
  then: "exits",
  status,
  statusLabel: status,
  note: null,
  prUrl: null,
  lastActivity: null,
  recurring: false,
  spawned: false,
  ...extra,
});

vi.mock("@/hooks/use-work-feed", () => ({
  useWorkFeed: vi.fn(() => ({ rows: [], hosts: [], loading: false, refetch: vi.fn() })),
}));

import OverviewPage from "./page";
import { useDashboardData } from "@/hooks/use-dashboard-data";
import { useWorkFeed } from "@/hooks/use-work-feed";

describe("OverviewPage — failed-tasks banner removed", () => {
  afterEach(() => cleanup());

  it("does not render the 'failed today' banner even when tasks have failures", () => {
    vi.mocked(useDashboardData).mockReturnValue(
      makeDashboardData({
        taskStats: { total: 10, running: 0, failed: 5, needsAttention: 0 },
      }) as any,
    );

    render(<OverviewPage />);

    expect(screen.queryByText(/failed today/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ask Optio to help investigate/i)).not.toBeInTheDocument();
  });

  it("renders the Overview heading, the work board, and a New work button", () => {
    render(<OverviewPage />);

    expect(screen.getByText("Overview")).toBeInTheDocument();
    expect(screen.getByTestId("sessions-board")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /New work/ })).toHaveAttribute("href", "/work/new");
  });
});

describe("OverviewPage — section ordering", () => {
  afterEach(() => cleanup());

  it("renders Recent Tasks before Pods before Recent Activity", () => {
    render(<OverviewPage />);

    const recentTasks = screen.getByTestId("recent-tasks");
    const podsList = screen.getByTestId("pods-list");
    const recentActivity = screen.getByTestId("recent-activity");
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;

    expect(recentTasks.compareDocumentPosition(podsList) & FOLLOWING).toBeTruthy();
    expect(podsList.compareDocumentPosition(recentActivity) & FOLLOWING).toBeTruthy();
  });
});

describe("OverviewPage — the sessions feed drives the summary", () => {
  afterEach(() => cleanup());

  it("counts running / waiting / needs-you / recurring sessions in the subtitle", () => {
    vi.mocked(useWorkFeed).mockReturnValue({
      rows: [
        feedRow("a", "running"),
        feedRow("b", "needs_you"),
        feedRow("c", "waiting", { source: "local-terminal", then: "waits-for-me" }),
        feedRow("d", "scheduled", { source: "standalone", recurring: true }),
      ],
      hosts: [],
      loading: false,
      error: null,
      refetch: vi.fn(),
    } as any);

    render(<OverviewPage />);

    expect(screen.getByText(/1 running/)).toBeInTheDocument();
    expect(screen.getByText(/1 waiting for you/)).toBeInTheDocument();
    expect(screen.getByText(/1 needs you/)).toBeInTheDocument();
    expect(screen.getByText(/1 recurring/)).toBeInTheDocument();
    expect(screen.getByTestId("sessions-board")).toHaveTextContent("4");
  });
});

describe("OverviewPage — Needs you and the welcome hero", () => {
  afterEach(() => cleanup());

  const live = (id: string, attentionState: string) => ({
    id,
    title: id,
    dir: "/home/dev/optio",
    state: "running",
    attentionState,
    lastActivityAt: new Date().toISOString(),
  });

  it("shows Needs you when a local terminal waits", () => {
    vi.mocked(useDashboardData).mockReturnValue(
      makeDashboardData({
        localTerminals: [live("a", "working"), live("b", "needs_you")],
        localHosts: [{ id: "h", name: "mac", state: "online" }],
      }) as any,
    );

    render(<OverviewPage />);

    expect(screen.getByTestId("needs-you")).toBeInTheDocument();
  });

  it("skips the welcome hero when there are no repo tasks but a local terminal exists", () => {
    vi.mocked(useDashboardData).mockReturnValue(
      makeDashboardData({
        taskStats: { total: 0, running: 0, failed: 0, needsAttention: 0 },
        localTerminals: [live("a", "idle")],
        localHosts: [{ id: "h", name: "mac", state: "online" }],
      }) as any,
    );

    render(<OverviewPage />);

    expect(screen.queryByTestId("welcome-hero")).not.toBeInTheDocument();
    expect(screen.getByTestId("sessions-board")).toBeInTheDocument();
  });

  it("shows the welcome hero on a truly empty install", () => {
    vi.mocked(useDashboardData).mockReturnValue(
      makeDashboardData({
        taskStats: { total: 0, running: 0, failed: 0, needsAttention: 0 },
        localTerminals: [],
      }) as any,
    );

    render(<OverviewPage />);

    expect(screen.getByTestId("welcome-hero")).toBeInTheDocument();
  });
});
