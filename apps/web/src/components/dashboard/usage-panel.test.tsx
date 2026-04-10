import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// The banner uses toast + api.createSecret internally; stub both so tests
// don't pull in real network calls.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/api-client", () => ({
  api: { createSecret: vi.fn() },
}));

vi.mock("@optio/shared", () => ({
  // getOffPeakInfo is called from the happy-path render; return a stable stub.
  getOffPeakInfo: () => ({ promoActive: false, isOffPeak: false }),
}));

import { UsagePanel } from "./usage-panel";
import type { UsageData } from "./types";

const makeUsage = (overrides: Partial<UsageData> = {}): UsageData => ({
  available: true,
  fiveHour: { utilization: 25, resetsAt: null },
  sevenDay: { utilization: 12, resetsAt: null },
  ...overrides,
});

describe("UsagePanel → TokenRefreshBanner trigger", () => {
  afterEach(() => cleanup());

  it("shows the banner when usage endpoint returns a 401 auth error", () => {
    render(<UsagePanel usage={{ available: false, error: "Usage API returned 401" }} />);
    expect(screen.getByText(/OAuth token expired/i)).toBeInTheDocument();
  });

  it("shows the banner when usage is reachable but task logs recorded recent auth failures", () => {
    // This is the bug we're fixing: usage is 429 (rate limited) on its own
    // endpoint, so `available` stays false/true ambiguously, but the backend
    // surfaces `hasRecentAuthFailure` from the task_logs table.
    render(
      <UsagePanel
        usage={{ available: false, error: "Usage API returned 429", hasRecentAuthFailure: true }}
      />,
    );
    expect(screen.getByText(/OAuth token expired/i)).toBeInTheDocument();
  });

  it("shows the banner when usage IS available but tasks are still 401ing", () => {
    // Edge case: token has enough scope for the usage endpoint but not the
    // messages endpoint. Usage meters would render successfully, yet tasks
    // still fail. We prefer the banner in this case — the user needs to act.
    render(<UsagePanel usage={makeUsage({ hasRecentAuthFailure: true })} />);
    expect(screen.getByText(/OAuth token expired/i)).toBeInTheDocument();
  });

  it("hides the banner when usage is 429 and no recent auth failures", () => {
    const { container } = render(
      <UsagePanel usage={{ available: false, error: "Usage API returned 429" }} />,
    );
    expect(screen.queryByText(/OAuth token expired/i)).not.toBeInTheDocument();
    // Panel returns null in this case
    expect(container.firstChild).toBeNull();
  });

  it("renders the usage meters normally when everything is healthy", () => {
    render(<UsagePanel usage={makeUsage()} />);
    expect(screen.getByText(/Claude Max Usage/i)).toBeInTheDocument();
    expect(screen.queryByText(/OAuth token expired/i)).not.toBeInTheDocument();
  });
});

describe("UsagePanel → per-token-type banners", () => {
  afterEach(() => cleanup());

  it("shows only the Claude banner when authFailures.claude is true", () => {
    render(<UsagePanel usage={makeUsage({ authFailures: { claude: true, github: false } })} />);
    expect(screen.getByText(/OAuth token expired/i)).toBeInTheDocument();
    expect(screen.queryByText(/GitHub token invalid/i)).not.toBeInTheDocument();
  });

  it("shows only the GitHub banner when authFailures.github is true", () => {
    render(<UsagePanel usage={makeUsage({ authFailures: { claude: false, github: true } })} />);
    expect(screen.queryByText(/OAuth token expired/i)).not.toBeInTheDocument();
    expect(screen.getByText(/GitHub token invalid/i)).toBeInTheDocument();
  });

  it("shows both banners simultaneously when both tokens are bad", () => {
    render(<UsagePanel usage={makeUsage({ authFailures: { claude: true, github: true } })} />);
    expect(screen.getByText(/OAuth token expired/i)).toBeInTheDocument();
    expect(screen.getByText(/GitHub token invalid/i)).toBeInTheDocument();
  });

  it("shows no banners when both tokens are valid", () => {
    render(<UsagePanel usage={makeUsage({ authFailures: { claude: false, github: false } })} />);
    expect(screen.queryByText(/OAuth token expired/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/GitHub token invalid/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Claude Max Usage/i)).toBeInTheDocument();
  });

  it("GitHub banner includes descriptive text about ticket sync and PR watching", () => {
    render(<UsagePanel usage={makeUsage({ authFailures: { claude: false, github: true } })} />);
    expect(screen.getByText(/ticket sync and PR watching are failing/i)).toBeInTheDocument();
  });
});
