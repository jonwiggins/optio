import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";

function aliases() {
  const config = { resolve: { alias: {}, extensionAlias: {} }, module: { noParse: [] } };
  nextConfig.webpack!(config, {} as never);
  return config.resolve.alias;
}

afterEach(() => vi.unstubAllEnvs());

describe("font build selection", () => {
  it("keeps the Google font module by default", () => {
    vi.stubEnv("OPTIO_OFFLINE_FONTS", "");
    expect(aliases()).toEqual({});
  });

  it("selects the vendored module only with the offline build flag", () => {
    vi.stubEnv("OPTIO_OFFLINE_FONTS", "1");
    expect(aliases()).toEqual({
      "@/app/fonts": expect.stringMatching(/src\/app\/fonts-local\.ts$/),
    });
  });

  it("keeps the normal module for other flag values", () => {
    vi.stubEnv("OPTIO_OFFLINE_FONTS", "0");
    expect(aliases()).toEqual({});
  });
});
