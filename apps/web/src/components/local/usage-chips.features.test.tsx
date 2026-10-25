import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

const getUsage = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: { getUsage: (...args: unknown[]) => getUsage(...args) },
}));
vi.mock("sonner", () => ({ toast: { message: vi.fn() } }));
// The deployment's feature lists (default: everything); the restricted deployment offers no Codex.
let features = featuresFromEnv({});
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, gatewayOnly: features.modelAccess === "gateway", loaded: true }),
}));

import { SessionLimitsPills } from "./usage-chips";

const recentCodex = () => ({
  primary: {
    usedPercent: 42,
    windowMinutes: 300,
    resetsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
  },
  secondary: {
    usedPercent: 18,
    windowMinutes: 10080,
    resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  },
  planType: "pro",
  observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
});

const host = (codex: unknown) => ({ name: "MacBook-Pro", agentLimits: codex ? { codex } : null });
const pills = (el: HTMLElement) =>
  [...el.querySelectorAll("[data-usage-provider]")].map((n) =>
    n.getAttribute("data-usage-provider"),
  );

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  getUsage.mockReset();
  getUsage.mockResolvedValue({
    usage: {
      available: true,
      fiveHour: { utilization: 12, resetsAt: null },
      sevenDay: { utilization: 30, resetsAt: null },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  features = featuresFromEnv({});
});

describe("SessionLimitsPills under the restricted deployment", () => {
  it("never shows Codex's limits, even where a snapshot exists", async () => {
    features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
    const { container } = render(
      <SessionLimitsPills terminal={{ spec: { kind: "shell" } }} host={host(recentCodex())} />,
    );
    await waitFor(() => expect(pills(container)).toEqual(["claude"]));
  });
});
