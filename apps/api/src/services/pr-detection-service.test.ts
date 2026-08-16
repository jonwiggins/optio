import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseOwnerRepo,
  checkExistingPr,
  verifyTaskPr,
  resolveDetectedPrUrl,
} from "./pr-detection-service.js";

// Mock git-token-service
const mockPlatform = {
  type: "github",
  listOpenPullRequests: vi.fn(),
};
const mockGetGitPlatformForRepo = vi.fn();

vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: (...args: unknown[]) => mockGetGitPlatformForRepo(...args),
}));

// Mock logger
vi.mock("../logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

describe("parseOwnerRepo", () => {
  it("parses HTTPS GitHub URL", () => {
    expect(parseOwnerRepo("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses lowercase normalized URL", () => {
    expect(parseOwnerRepo("https://github.com/myorg/myrepo")).toEqual({
      owner: "myorg",
      repo: "myrepo",
    });
  });

  it("parses GitLab URL", () => {
    expect(parseOwnerRepo("https://gitlab.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("returns null for empty string", () => {
    expect(parseOwnerRepo("")).toBeNull();
  });

  it("handles URLs with trailing path segments", () => {
    const result = parseOwnerRepo("https://github.com/owner/repo/tree/main");
    expect(result).toEqual({ owner: "owner", repo: "repo" });
  });
});

describe("checkExistingPr", () => {
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

  it("returns PR when an open PR exists for the task branch", async () => {
    mockPlatform.listOpenPullRequests.mockResolvedValue([
      {
        url: "https://github.com/owner/repo/pull/42",
        number: 42,
        state: "open",
        title: "",
        body: "",
        merged: false,
        mergeable: true,
        draft: false,
        headSha: "abc",
        baseBranch: "main",
        author: "",
        assignees: [],
        labels: [],
        createdAt: "",
        updatedAt: "",
      },
    ]);

    const result = await checkExistingPr("https://github.com/owner/repo", "task-123", null);

    expect(result).toEqual({
      url: "https://github.com/owner/repo/pull/42",
      number: 42,
      state: "open",
    });

    expect(mockPlatform.listOpenPullRequests).toHaveBeenCalledWith(expect.any(Object), {
      branch: "optio/task-task-123",
    });
  });

  it("returns null when no PR exists", async () => {
    mockPlatform.listOpenPullRequests.mockResolvedValue([]);

    const result = await checkExistingPr("https://github.com/owner/repo", "task-456", null);

    expect(result).toBeNull();
  });

  it("returns null when no git token is available", async () => {
    mockGetGitPlatformForRepo.mockRejectedValue(new Error("No token"));

    const result = await checkExistingPr("https://github.com/owner/repo", "task-789", null);

    expect(result).toBeNull();
  });

  it("returns null when platform API returns an error", async () => {
    mockPlatform.listOpenPullRequests.mockRejectedValue(new Error("API error"));

    const result = await checkExistingPr("https://github.com/owner/repo", "task-err", null);

    expect(result).toBeNull();
  });

  it("works for GitLab repo URLs", async () => {
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
    mockPlatform.listOpenPullRequests.mockResolvedValue([]);

    const result = await checkExistingPr("https://gitlab.com/owner/repo", "task-gl", null);

    expect(result).toBeNull();
    expect(mockGetGitPlatformForRepo).toHaveBeenCalled();
  });

  it("returns null when fetch throws a network error", async () => {
    mockPlatform.listOpenPullRequests.mockRejectedValue(new Error("Network error"));

    const result = await checkExistingPr("https://github.com/owner/repo", "task-net", null);

    expect(result).toBeNull();
  });

  it("uses server context for token resolution", async () => {
    mockPlatform.listOpenPullRequests.mockResolvedValue([]);

    await checkExistingPr("https://github.com/owner/repo", "task-ws", "workspace-42");

    expect(mockGetGitPlatformForRepo).toHaveBeenCalledWith("https://github.com/owner/repo", {
      server: true,
    });
  });
});

function makePr(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://github.com/owner/repo/pull/42",
    number: 42,
    state: "open",
    title: "",
    body: "",
    merged: false,
    mergeable: true,
    draft: false,
    headSha: "abc",
    baseBranch: "main",
    author: "",
    assignees: [],
    labels: [],
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("verifyTaskPr", () => {
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

  it("returns verified when an open PR exists for the task branch", async () => {
    mockPlatform.listOpenPullRequests.mockResolvedValue([makePr()]);

    const result = await verifyTaskPr("https://github.com/owner/repo", "task-123", null);

    expect(result).toEqual({
      status: "verified",
      pr: { url: "https://github.com/owner/repo/pull/42", number: 42, state: "open" },
    });
    expect(mockPlatform.listOpenPullRequests).toHaveBeenCalledWith(expect.any(Object), {
      branch: "optio/task-task-123",
    });
  });

  it("returns no_pr when the platform reports no open PR for the branch", async () => {
    mockPlatform.listOpenPullRequests.mockResolvedValue([]);

    const result = await verifyTaskPr("https://github.com/owner/repo", "task-456", null);

    expect(result).toEqual({ status: "no_pr" });
  });

  it("returns unavailable when no git token is available", async () => {
    mockGetGitPlatformForRepo.mockRejectedValue(new Error("No token"));

    const result = await verifyTaskPr("https://github.com/owner/repo", "task-789", null);

    expect(result).toEqual({ status: "unavailable", reason: "no_git_token" });
  });

  it("returns unavailable when the platform API errors", async () => {
    mockPlatform.listOpenPullRequests.mockRejectedValue(new Error("API error"));

    const result = await verifyTaskPr("https://github.com/owner/repo", "task-err", null);

    expect(result).toEqual({ status: "unavailable", reason: "platform_lookup_failed" });
  });

  it("returns unavailable for unparseable repo URLs", async () => {
    const result = await verifyTaskPr("", "task-bad", null);

    expect(result).toEqual({ status: "unavailable", reason: "unparseable_repo_url" });
    expect(mockGetGitPlatformForRepo).not.toHaveBeenCalled();
  });
});

describe("resolveDetectedPrUrl", () => {
  // Issue #531: a /pull/N URL echoed from the prompt must not be treated as
  // the task's opened PR when the platform says no PR exists for the branch.
  it("rejects a prompt-echoed URL when the platform reports no PR", () => {
    const scraped = "https://github.com/owner/repo/pull/5678";

    const result = resolveDetectedPrUrl(scraped, { status: "no_pr" });

    expect(result.url).toBeUndefined();
    expect(result.rejectedUrl).toBe(scraped);
  });

  it("accepts a genuine PR whose head is the task branch", () => {
    const result = resolveDetectedPrUrl("https://github.com/owner/repo/pull/99", {
      status: "verified",
      pr: { url: "https://github.com/owner/repo/pull/99", number: 99, state: "open" },
    });

    expect(result.url).toBe("https://github.com/owner/repo/pull/99");
    expect(result.rejectedUrl).toBeUndefined();
  });

  it("prefers the canonical platform URL over a differing scraped URL", () => {
    const result = resolveDetectedPrUrl("https://github.com/owner/repo/pull/5678", {
      status: "verified",
      pr: { url: "https://github.com/owner/repo/pull/100", number: 100, state: "open" },
    });

    expect(result.url).toBe("https://github.com/owner/repo/pull/100");
  });

  it("falls back to the scraped URL when verification is unavailable", () => {
    const scraped = "https://github.com/owner/repo/pull/7";

    const result = resolveDetectedPrUrl(scraped, {
      status: "unavailable",
      reason: "no_git_token",
    });

    expect(result.url).toBe(scraped);
    expect(result.rejectedUrl).toBeUndefined();
  });

  it("verified result applies even when no URL was scraped (API-only detection)", () => {
    const result = resolveDetectedPrUrl(undefined, {
      status: "verified",
      pr: { url: "https://github.com/owner/repo/pull/3", number: 3, state: "open" },
    });

    expect(result.url).toBe("https://github.com/owner/repo/pull/3");
  });
});
