import { featuresFromEnv } from "@optio/shared/features";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

// Where the Overview puts the getting-started checklist (getting-started.tsx):
// nowhere unless a deployment admin turned the guide on.
const mocks = vi.hoisted(() => ({
  authDisabled: false,
  onboarding: false,
  total: 10,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({
    features: featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
    gatewayOnly: true,
    loaded: true,
  }),
}));
vi.mock("@/hooks/use-page-title", () => ({ usePageTitle: vi.fn() }));
vi.mock("@/hooks/use-current-user", () => ({
  useCurrentUser: () => ({ authDisabled: mocks.authDisabled, canMutate: true }),
}));
vi.mock("@/hooks/use-deployment-switches", () => ({
  useDeploymentSwitches: () => ({
    teams: false,
    mergeConfirmation: false,
    onboarding: mocks.onboarding,
    loaded: true,
  }),
}));
vi.mock("@/components/update-banner", () => ({ UpdateBanner: () => null }));
vi.mock("@/components/dashboard/getting-started", () => ({
  GettingStarted: () => <div data-testid="checklist" />,
}));
vi.mock("@/components/dashboard", () => ({
  UsagePanel: () => null,
  ClusterSummary: () => null,
  RecentActivity: () => null,
  PodsList: () => null,
  // The hero renders the checklist it's handed in place of its steps.
  WelcomeHero: ({ checklist }: { checklist?: (onShowing: (s: boolean) => void) => ReactNode }) => (
    <div data-testid="welcome-hero">
      {checklist ? checklist(() => {}) : <span>static steps</span>}
    </div>
  ),
  AgentComparison: () => null,
  RecentRuns: () => null,
  WorkBoard: () => null,
  LimitsPanel: () => null,
  GatewayLimitsPanel: () => null,
  collectProviderLimits: () => [],
  NeedsYou: () => null,
  collectNeedsYou: () => [],
}));
vi.mock("@/hooks/use-dashboard-data", () => ({
  useDashboardData: () => ({
    taskStats: { total: mocks.total, running: 0, failed: 0, needsAttention: 0 },
    recentTasks: [],
    repoCount: 1,
    cluster: { pods: [], events: [], repoPods: [] },
    loading: false,
    usage: null,
    metricsAvailable: false,
    metricsHistory: [],
    refresh: vi.fn(),
    refreshUsage: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-work-feed", () => ({
  useWorkFeed: () => ({ rows: [], loading: false, refetch: vi.fn() }),
}));

import OverviewPage from "./page";

afterEach(() => {
  cleanup();
  mocks.authDisabled = false;
  mocks.onboarding = false;
  mocks.total = 10;
});

describe("Overview: the getting-started checklist, off (the default)", () => {
  it("isn't on the Overview for someone with work", () => {
    render(<OverviewPage />);
    expect(screen.queryByTestId("checklist")).not.toBeInTheDocument();
  });

  it("leaves the welcome its static steps on a first run", () => {
    mocks.total = 0;
    render(<OverviewPage />);
    expect(screen.getByTestId("welcome-hero")).toBeInTheDocument();
    expect(screen.getByText("static steps")).toBeInTheDocument();
    expect(screen.queryByTestId("checklist")).not.toBeInTheDocument();
  });
});

describe("Overview: the getting-started checklist, on", () => {
  beforeEach(() => {
    mocks.onboarding = true;
  });

  it("sits on the Overview for someone with work", () => {
    render(<OverviewPage />);
    expect(screen.getByTestId("checklist")).toBeInTheDocument();
    expect(screen.queryByTestId("welcome-hero")).not.toBeInTheDocument();
  });

  it("takes the welcome's static steps' place on a first run", () => {
    mocks.total = 0;
    render(<OverviewPage />);
    const hero = screen.getByTestId("welcome-hero");
    expect(hero).toContainElement(screen.getByTestId("checklist"));
    expect(screen.queryByText("static steps")).not.toBeInTheDocument();
  });

  it("with sign-in off, the welcome keeps its static steps", () => {
    mocks.total = 0;
    mocks.authDisabled = true;
    render(<OverviewPage />);
    expect(screen.getByText("static steps")).toBeInTheDocument();
    expect(screen.queryByTestId("checklist")).not.toBeInTheDocument();
  });
});
