import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_CONNECTION_PROVIDERS,
  ALL_GIT_PLATFORMS,
  ALL_RUNTIMES,
  ALL_TICKET_SOURCES,
  ALL_TRIGGERS,
  FEATURE_SETTINGS,
  currentFeatures,
} from "@optio/shared";
import { receiverFor } from "./services/feature-guard.js";

beforeEach(() => {
  for (const name of FEATURE_SETTINGS) vi.stubEnv(name, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("feature-list default parity", () => {
  it("preserves every upstream runtime, platform, trigger, source and connection", () => {
    expect(currentFeatures()).toEqual({
      runtimes: [...ALL_RUNTIMES],
      gitPlatforms: [...ALL_GIT_PLATFORMS],
      triggers: [...ALL_TRIGGERS],
      ticketSources: [...ALL_TICKET_SOURCES],
      connectionProviders: [...ALL_CONNECTION_PROVIDERS],
      // OPTIO_MODEL_ACCESS unset: every way of reaching models, as upstream.
      modelAccess: "any",
    });
    expect(currentFeatures().runtimes).toContain("pi");
    expect(currentFeatures().runtimes).toHaveLength(8);
  });
  it("registers every upstream trigger receiver", () => {
    for (const trigger of ALL_TRIGGERS) {
      const app = { post: vi.fn() };
      expect(receiverFor(app, trigger)).toBe(app);
    }
  });
});
