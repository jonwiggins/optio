import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const listLocalHosts = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    createSecret: vi.fn(),
    listLocalHosts: (...args: unknown[]) => listLocalHosts(...args),
    refreshClaudeTokenFromHost: vi.fn(),
  },
}));

// The banner shows under the default deployment (token-refresh-banner.test.tsx);
// a gateway-only deployment has no Claude OAuth token to refresh.
let features = featuresFromEnv({});
vi.mock("@/hooks/use-features", () => ({
  useFeatures: () => ({ features, gatewayOnly: features.modelAccess === "gateway", loaded: true }),
}));

import { TokenRefreshBanner } from "./token-refresh-banner";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  features = featuresFromEnv({});
});

describe("TokenRefreshBanner under the restricted deployment", () => {
  it("stays quiet: there is no Claude OAuth token in a gateway-only deployment", async () => {
    features = featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" });
    listLocalHosts.mockResolvedValue({ hosts: [] });
    const { container } = render(<TokenRefreshBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});
