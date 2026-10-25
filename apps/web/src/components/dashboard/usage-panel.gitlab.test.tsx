import { featuresFromEnv } from "@optio/shared/features";
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

// The token banners show under the default deployment (a gateway-only one hides them).
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features: featuresFromEnv({}), gatewayOnly: false, loaded: true }),
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

describe("UsagePanel → a GitLab token's banner", () => {
  afterEach(() => cleanup());

  it("a refused GitLab token shows GitLab's banner, not GitHub's", () => {
    render(
      <UsagePanel
        usage={makeUsage({ authFailures: { claude: false, github: false, gitlab: true } })}
      />,
    );
    expect(screen.getByText(/GitLab token invalid/i)).toBeInTheDocument();
    expect(screen.queryByText(/GitHub token invalid/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Paste GitLab token here/i)).toBeInTheDocument();
  });
});
