import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("next.config.ts security headers", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function loadConfig() {
    const mod = await import("../next.config.js");
    const { headers } = mod.default;
    if (!headers) throw new Error("next.config.ts exports no headers()");
    return { ...mod.default, headers };
  }

  it("exports a headers function", async () => {
    const config = await loadConfig();
    expect(typeof config.headers).toBe("function");
  });

  it("returns headers for all routes", async () => {
    const config = await loadConfig();
    const result = await config.headers();
    expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ source: "/(.*)" })]));
  });

  describe("always-present headers", () => {
    it("includes X-Content-Type-Options: nosniff", async () => {
      const config = await loadConfig();
      const result = await config.headers();
      const headers = result[0].headers;
      expect(headers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "X-Content-Type-Options",
            value: "nosniff",
          }),
        ]),
      );
    });

    it("includes X-Frame-Options: DENY", async () => {
      const config = await loadConfig();
      const result = await config.headers();
      const headers = result[0].headers;
      expect(headers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "X-Frame-Options",
            value: "DENY",
          }),
        ]),
      );
    });

    it("includes Referrer-Policy: strict-origin-when-cross-origin", async () => {
      const config = await loadConfig();
      const result = await config.headers();
      const headers = result[0].headers;
      expect(headers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          }),
        ]),
      );
    });

    it("allows same-origin dictation while restricting other sensitive APIs", async () => {
      const config = await loadConfig();
      const result = await config.headers();
      const headers = result[0].headers;
      expect(headers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "Permissions-Policy",
            value: "camera=(), microphone=(self), geolocation=()",
          }),
        ]),
      );
    });

    it("includes Content-Security-Policy-Report-Only", async () => {
      const config = await loadConfig();
      const result = await config.headers();
      const headers = result[0].headers;
      const cspHeader = headers.find(
        (h: { key: string }) => h.key === "Content-Security-Policy-Report-Only",
      );
      expect(cspHeader).toBeDefined();
      expect(cspHeader?.value).toContain("default-src 'self'");
      expect(cspHeader?.value).toContain("script-src 'self' 'unsafe-inline'");
      expect(cspHeader?.value).toContain("style-src 'self' 'unsafe-inline'");
      expect(cspHeader?.value).toContain("connect-src 'self' wss: ws:");
      expect(cspHeader?.value).toContain("img-src 'self' data: https:");
      expect(cspHeader?.value).toContain("font-src 'self' data:");
      expect(cspHeader?.value).toContain("frame-ancestors 'none'");
    });
  });

  describe("production-only headers", () => {
    it("includes HSTS in production", async () => {
      vi.stubEnv("NODE_ENV", "production");
      const config = await loadConfig();
      const result = await config.headers();
      const headers = result[0].headers;
      expect(headers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains; preload",
          }),
        ]),
      );
    });

    it("does not include HSTS in development", async () => {
      vi.stubEnv("NODE_ENV", "development");
      const config = await loadConfig();
      const result = await config.headers();
      const headers = result[0].headers;
      const hsts = headers.find((h: { key: string }) => h.key === "Strict-Transport-Security");
      expect(hsts).toBeUndefined();
    });
  });

  it("preserves existing config properties", async () => {
    const config = await loadConfig();
    expect(config.output).toBe("standalone");
    expect(config.transpilePackages).toContain("@optio/shared");
    expect(typeof config.webpack).toBe("function");
  });
});
