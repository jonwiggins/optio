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
      OPTIO_TRIGGERS: "manual",
    });
    expect(features?.runtimes).toEqual(["claude-code", "opencode"]);
    expect(features?.gitPlatforms).toEqual(["github", "gitlab", "codecommit"]);
    expect(features?.triggers).toEqual(["manual"]);
  });

  it("narrows one list without changing the others", () => {
    const { features } = featuresConfig({ OPTIO_GIT_PLATFORMS: "gitlab" });
    expect(features?.gitPlatforms).toEqual(["gitlab"]);
  });
});
