import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockPlatform = {
  type: "github",
  listRepoContents: vi.fn(),
};
const mockGetGitPlatformForRepo = vi.fn().mockResolvedValue({
  platform: mockPlatform,
  ri: {
    platform: "github",
    host: "github.com",
    owner: "owner",
    repo: "repo",
    apiBaseUrl: "https://api.github.com",
  },
});

vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: (...args: unknown[]) => mockGetGitPlatformForRepo(...args),
}));

import { detectRepoConfig } from "./repo-detect-service.js";

describe("repo-detect-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitPlatformForRepo.mockResolvedValue({
      platform: mockPlatform,
      ri: {
        platform: "github",
        host: "github.com",
        owner: "owner",
        repo: "repo",
        apiBaseUrl: "https://api.github.com",
      },
    });
  });

  it("returns base preset for unparseable URLs", async () => {
    const result = await detectRepoConfig("not-a-url", "token");
    expect(result).toEqual({ imagePreset: "base", languages: [] });
  });

  it("returns base preset when API call fails", async () => {
    mockPlatform.listRepoContents.mockRejectedValue(new Error("API error"));

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result).toEqual({ imagePreset: "base", languages: [] });
  });

  it("detects node project", async () => {
    mockPlatform.listRepoContents.mockResolvedValue([
      { name: "package.json", type: "file" },
      { name: "README.md", type: "file" },
    ]);

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.imagePreset).toBe("node");
    expect(result.languages).toContain("node");
    expect(result.testCommand).toBe("npm test");
  });

  it("detects rust project", async () => {
    mockPlatform.listRepoContents.mockResolvedValue([{ name: "Cargo.toml", type: "file" }]);

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.imagePreset).toBe("rust");
    expect(result.languages).toContain("rust");
    expect(result.testCommand).toBe("cargo test");
  });

  it("detects go project", async () => {
    mockPlatform.listRepoContents.mockResolvedValue([{ name: "go.mod", type: "file" }]);

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.imagePreset).toBe("go");
    expect(result.languages).toContain("go");
    expect(result.testCommand).toBe("go test ./...");
  });

  it("detects python project from pyproject.toml", async () => {
    mockPlatform.listRepoContents.mockResolvedValue([{ name: "pyproject.toml", type: "file" }]);

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.imagePreset).toBe("python");
    expect(result.languages).toContain("python");
    expect(result.testCommand).toBe("pytest");
  });

  it("detects python project from requirements.txt", async () => {
    mockPlatform.listRepoContents.mockResolvedValue([{ name: "requirements.txt", type: "file" }]);

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.imagePreset).toBe("python");
  });

  it("detects ruby project", async () => {
    mockPlatform.listRepoContents.mockResolvedValue([{ name: "Gemfile", type: "file" }]);

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.imagePreset).toBe("ruby");
    expect(result.languages).toContain("ruby");
    expect(result.testCommand).toBe("bundle exec rspec");
  });

  it("detects dart project", async () => {
    mockPlatform.listRepoContents.mockResolvedValue([{ name: "pubspec.yaml", type: "file" }]);

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.imagePreset).toBe("dart");
    expect(result.languages).toContain("dart");
    expect(result.testCommand).toBe("dart test");
  });

  it("uses full preset for multi-language projects", async () => {
    mockPlatform.listRepoContents.mockResolvedValue([
      { name: "package.json", type: "file" },
      { name: "Cargo.toml", type: "file" },
    ]);

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.imagePreset).toBe("full");
    expect(result.languages).toContain("node");
    expect(result.languages).toContain("rust");
  });

  it("sets first detected test command as the test command", async () => {
    mockPlatform.listRepoContents.mockResolvedValue([
      { name: "Cargo.toml", type: "file" },
      { name: "package.json", type: "file" },
    ]);

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result.testCommand).toBe("cargo test"); // Cargo.toml checked first
  });

  it("handles exceptions gracefully", async () => {
    mockGetGitPlatformForRepo.mockRejectedValue(new Error("Network error"));

    const result = await detectRepoConfig("https://github.com/owner/repo", "token");
    expect(result).toEqual({ imagePreset: "base", languages: [] });
  });

  it("works with GitLab repos", async () => {
    mockGetGitPlatformForRepo.mockResolvedValue({
      platform: mockPlatform,
      ri: {
        platform: "gitlab",
        host: "gitlab.com",
        owner: "owner",
        repo: "repo",
        apiBaseUrl: "https://gitlab.com/api/v4",
      },
    });
    mockPlatform.listRepoContents.mockResolvedValue([{ name: "package.json", type: "file" }]);

    const result = await detectRepoConfig("https://gitlab.com/owner/repo", "token");
    expect(result.imagePreset).toBe("node");
  });
});
