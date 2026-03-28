import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { detectRepoConfig } from "./repo-detect-service.js";

describe("repo-detect-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns base preset for non-GitHub URLs", async () => {
    const result = await detectRepoConfig("https://gitlab.com/o/r", "token");
    expect(result).toEqual({ imagePreset: "base", languages: [] });
  });

  it("returns base preset when API call fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result).toEqual({ imagePreset: "base", languages: [] });
  });

  it("detects node project", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { name: "package.json", type: "file" },
          { name: "README.md", type: "file" },
        ]),
    });

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.imagePreset).toBe("node");
    expect(result.languages).toContain("node");
    expect(result.testCommand).toBe("npm test");
  });

  it("detects rust project", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ name: "Cargo.toml", type: "file" }]),
    });

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.imagePreset).toBe("rust");
    expect(result.languages).toContain("rust");
    expect(result.testCommand).toBe("cargo test");
  });

  it("detects go project", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ name: "go.mod", type: "file" }]),
    });

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.imagePreset).toBe("go");
    expect(result.languages).toContain("go");
    expect(result.testCommand).toBe("go test ./...");
  });

  it("detects python project from pyproject.toml", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ name: "pyproject.toml", type: "file" }]),
    });

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.imagePreset).toBe("python");
    expect(result.languages).toContain("python");
    expect(result.testCommand).toBe("pytest");
  });

  it("detects python project from requirements.txt", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ name: "requirements.txt", type: "file" }]),
    });

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.imagePreset).toBe("python");
  });

  it("uses full preset for multi-language projects", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { name: "package.json", type: "file" },
          { name: "Cargo.toml", type: "file" },
        ]),
    });

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.imagePreset).toBe("full");
    expect(result.languages).toContain("node");
    expect(result.languages).toContain("rust");
  });

  it("sets first detected test command as the test command", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { name: "Cargo.toml", type: "file" },
          { name: "package.json", type: "file" },
        ]),
    });

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.testCommand).toBe("cargo test"); // Cargo.toml checked first
  });

  it("handles fetch exceptions gracefully", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result).toEqual({ imagePreset: "base", languages: [] });
  });

  it("sends correct authorization header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    globalThis.fetch = mockFetch;

    await detectRepoConfig("https://github.com/owner/repo", "my-token");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/contents/",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer my-token",
        }),
      }),
    );
  });
});
