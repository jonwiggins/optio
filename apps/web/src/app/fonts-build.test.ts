import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";

function replacements() {
  class Replacement {
    constructor(
      readonly resourceRegExp: RegExp,
      readonly replace: (data: { createData?: { resource?: string } }) => void,
    ) {}
  }
  const config = { plugins: [] as Replacement[], resolve: {}, module: {} };
  nextConfig.webpack!(config, { webpack: { NormalModuleReplacementPlugin: Replacement } } as never);
  return config.plugins;
}

afterEach(() => vi.unstubAllEnvs());

describe("font build selection", () => {
  it("keeps the Google font module by default", () => {
    vi.stubEnv("OPTIO_OFFLINE_FONTS", "");
    expect(replacements()).toEqual([]);
  });

  it("replaces the resolved font module only with the offline build flag", () => {
    vi.stubEnv("OPTIO_OFFLINE_FONTS", "1");
    const plugins = replacements();
    expect(plugins).toHaveLength(1);
    const data = { createData: { resource: "/repo/apps/web/src/app/fonts.ts" } };
    expect(plugins[0].resourceRegExp.test(data.createData.resource)).toBe(true);
    plugins[0].replace(data);
    expect(data.createData.resource).toBe("/repo/apps/web/src/app/fonts-local.ts");
    plugins[0].replace({});
  });

  it("keeps the normal module for other flag values", () => {
    vi.stubEnv("OPTIO_OFFLINE_FONTS", "0");
    expect(replacements()).toEqual([]);
  });
});
