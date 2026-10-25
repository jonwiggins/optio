import { describe, expect, it } from "vitest";
import { featuresConfig } from "./features-config";

describe("featuresConfig (the layout's window.__OPTIO_CONFIG.features)", () => {
  it("adds nothing when the env sets no feature setting: the existing config", () => {
    expect(featuresConfig({})).toEqual({});
    expect(
      featuresConfig({ PUBLIC_API_URL: "https://optio.example.com", OPTIO_RUNTIMES: "" }),
    ).toEqual({});
  });

  it("adds the features the env describes once one is set", () => {
    const { features } = featuresConfig({
      OPTIO_RUNTIMES: "claude-code,opencode",
      OPTIO_MODEL_ACCESS: "gateway",
    });
    expect(features?.runtimes).toEqual(["claude-code", "opencode"]);
    expect(features?.gitPlatforms).toEqual(["github", "gitlab", "codecommit"]);
    expect(features?.modelAccess).toBe("gateway");
    expect(features?.agentPolicyDefaults).toBe(false);
  });

  it("fills the lists from the minimal preset", () => {
    const { features } = featuresConfig({ OPTIO_FEATURE_PRESET: "minimal" });
    expect(features?.gitPlatforms).toEqual(["gitlab"]);
  });
});
