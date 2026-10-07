import { afterEach, describe, expect, it, vi } from "vitest";
import { getCallbackUrl, publicApiOrigin } from "./provider.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getCallbackUrl", () => {
  it("prefers PUBLIC_API_URL when the API has an origin of its own", () => {
    vi.stubEnv("PUBLIC_API_URL", "http://localhost:30400");
    vi.stubEnv("PUBLIC_URL", "https://optio.example.com");
    expect(getCallbackUrl("github")).toBe("http://localhost:30400/api/auth/github/callback");
  });

  it.each([
    ["https://api.example.com", "https://api.example.com"],
    ["https://api.example.com/", "https://api.example.com"],
    ["https://api.example.com/api", "https://api.example.com"],
    ["https://api.example.com/api/", "https://api.example.com"],
    ["https://api.example.com/API", "https://api.example.com"],
  ])("treats PUBLIC_API_URL=%s as the origin %s", (given, origin) => {
    vi.stubEnv("PUBLIC_API_URL", given);
    expect(publicApiOrigin()).toBe(origin);
    expect(getCallbackUrl("oidc")).toBe(`${origin}/api/auth/oidc/callback`);
  });

  it("falls back to PUBLIC_URL when web and API share one origin", () => {
    vi.stubEnv("PUBLIC_API_URL", "");
    vi.stubEnv("PUBLIC_URL", "https://optio.example.com/");
    expect(getCallbackUrl("google")).toBe("https://optio.example.com/api/auth/google/callback");
  });

  it("falls back to the API's own port with neither set", () => {
    vi.stubEnv("PUBLIC_API_URL", "");
    vi.stubEnv("PUBLIC_URL", "");
    vi.stubEnv("API_PORT", "4567");
    expect(getCallbackUrl("gitlab")).toBe("http://localhost:4567/api/auth/gitlab/callback");
  });
});
