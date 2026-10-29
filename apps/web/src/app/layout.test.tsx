import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FEATURE_SETTINGS } from "@optio/shared/features";

vi.mock("next/font/google", () => ({
  Sora: () => ({ variable: "font-sora" }),
  IBM_Plex_Mono: () => ({ variable: "font-ibm-mono" }),
}));
vi.mock("@/components/layout/layout-shell", () => ({
  LayoutShell: ({ children }: { children: React.ReactNode }) => children,
}));
import RootLayout from "./layout";

beforeEach(() => {
  for (const setting of FEATURE_SETTINGS) vi.stubEnv(setting, "");
  vi.stubEnv("PUBLIC_API_URL", "");
});
afterEach(() => vi.unstubAllEnvs());

const runtimeConfig = () => {
  const html = renderToStaticMarkup(<RootLayout>{null}</RootLayout>);
  return { html, config: JSON.parse(html.match(/window\.__OPTIO_CONFIG=(.*?)<\/script>/)![1]) };
};

describe("layout feature injection", () => {
  it("keeps the default runtime config identical to the existing public API URL config", () => {
    expect(runtimeConfig().config).toEqual({ publicApiUrl: "" });
  });

  it("injects independent restrictions for the first paint and escapes script delimiters", () => {
    vi.stubEnv("OPTIO_RUNTIMES", "opencode");
    vi.stubEnv("OPTIO_TRIGGERS", "manual");
    vi.stubEnv("PUBLIC_API_URL", "https://optio.example.com/</script>");
    const { html, config } = runtimeConfig();
    expect(config.features.runtimes).toEqual(["opencode"]);
    expect(config.features.gitPlatforms).toHaveLength(3);
    expect(config.features.triggers).toEqual(["manual"]);
    expect(config.publicApiUrl).toBe("https://optio.example.com/</script>");
    expect(html).toContain("\\u003c/script>");
  });
});
