import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { featuresFromEnv } from "@optio/shared/features";

vi.mock("@/lib/api-client", () => ({ api: { getFeatures: vi.fn() } }));
import { api } from "@/lib/api-client";
import { useFeaturesStore } from "./use-features";

beforeEach(() => {
  delete (window as any).__OPTIO_CONFIG;
  vi.mocked(api.getFeatures).mockReset();
  useFeaturesStore.getState().reset();
});
afterEach(() => {
  delete (window as any).__OPTIO_CONFIG;
});

describe("useFeatures store", () => {
  it("offers everything before fetching when nothing was injected", () => {
    expect(useFeaturesStore.getState().features).toEqual(featuresFromEnv({}));
    expect(useFeaturesStore.getState().loaded).toBe(false);
  });

  it("uses injected restrictions synchronously and retains them when signed out", async () => {
    const features = featuresFromEnv({ OPTIO_RUNTIMES: "opencode", OPTIO_MODEL_ACCESS: "gateway" });
    (window as any).__OPTIO_CONFIG = { features };
    useFeaturesStore.getState().reset();
    expect(useFeaturesStore.getState().features).toEqual(features);
    vi.mocked(api.getFeatures).mockRejectedValue(new Error("Unauthorized"));
    await useFeaturesStore.getState().load();
    expect(useFeaturesStore.getState()).toMatchObject({ features, loaded: true });
  });

  it("shares a single request and uses the API's independent lists and switches", async () => {
    const features = featuresFromEnv({
      OPTIO_GIT_PLATFORMS: "codecommit",
      OPTIO_AGENT_POLICY_DEFAULTS: "true",
    });
    vi.mocked(api.getFeatures).mockResolvedValue(features);
    await Promise.all([useFeaturesStore.getState().load(), useFeaturesStore.getState().load()]);
    expect(api.getFeatures).toHaveBeenCalledTimes(1);
    expect(useFeaturesStore.getState()).toMatchObject({ features, loaded: true });
    expect(features.modelAccess).toBe("any");
  });
});
