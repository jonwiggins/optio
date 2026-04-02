import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitHubPlatform } from "./github.js";
import type { RepoIdentifier } from "@optio/shared";

const ri: RepoIdentifier = {
  platform: "github",
  host: "github.com",
  owner: "acme",
  repo: "widgets",
  apiBaseUrl: "https://api.github.com",
};

const mockFetch = vi.fn();

describe("GitHubPlatform", () => {
  let platform: GitHubPlatform;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    platform = new GitHubPlatform("ghp_test123");
    mockFetch.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockJsonResponse(data: any, ok = true, status = 200) {
    mockFetch.mockResolvedValueOnce({
      ok,
      status,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    });
  }

  it("has type github", () => {
    expect(platform.type).toBe("github");
  });

  describe("getPullRequest", () => {
    it("fetches PR and maps response", async () => {
      mockJsonResponse({
        number: 42,
        title: "Fix bug",
        body: "Fixes #1",
        state: "open",
        merged: false,
        mergeable: true,
        draft: false,
        head: { sha: "abc123" },
        base: { ref: "main" },
        html_url: "https://github.com/acme/widgets/pull/42",
        user: { login: "alice" },
        assignees: [],
        labels: [{ name: "bug" }],
        created_at: "2024-01-01",
        updated_at: "2024-01-02",
      });

      const pr = await platform.getPullRequest(ri, 42);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme/widgets/pulls/42",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer ghp_test123",
            "User-Agent": "Optio",
          }),
        }),
      );
      expect(pr.number).toBe(42);
      expect(pr.title).toBe("Fix bug");
      expect(pr.headSha).toBe("abc123");
      expect(pr.merged).toBe(false);
      expect(pr.labels).toEqual(["bug"]);
    });
  });

  describe("getCIChecks", () => {
    it("fetches check runs and maps response", async () => {
      mockJsonResponse({
        check_runs: [
          { name: "build", status: "completed", conclusion: "success" },
          { name: "lint", status: "in_progress", conclusion: null },
        ],
      });

      const checks = await platform.getCIChecks(ri, "abc123");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme/widgets/commits/abc123/check-runs",
        expect.any(Object),
      );
      expect(checks).toEqual([
        { name: "build", status: "completed", conclusion: "success" },
        { name: "lint", status: "in_progress", conclusion: null },
      ]);
    });
  });

  describe("getReviews", () => {
    it("fetches reviews and maps response", async () => {
      mockJsonResponse([
        { user: { login: "bob" }, state: "APPROVED", body: "LGTM" },
        { user: { login: "carol" }, state: "CHANGES_REQUESTED", body: "Fix tests" },
      ]);

      const reviews = await platform.getReviews(ri, 42);

      expect(reviews).toEqual([
        { author: "bob", state: "APPROVED", body: "LGTM" },
        { author: "carol", state: "CHANGES_REQUESTED", body: "Fix tests" },
      ]);
    });
  });

  describe("mergePullRequest", () => {
    it("sends PUT with merge method", async () => {
      mockJsonResponse({ merged: true });

      await platform.mergePullRequest(ri, 42, "squash");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.github.com/repos/acme/widgets/pulls/42/merge",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ merge_method: "squash" }),
        }),
      );
    });
  });

  describe("submitReview", () => {
    it("submits review with inline comments", async () => {
      mockJsonResponse({ html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-1" });

      const result = await platform.submitReview(ri, 42, {
        event: "REQUEST_CHANGES",
        body: "Please fix",
        comments: [{ path: "src/index.ts", line: 10, body: "Bug here" }],
      });

      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe("https://api.github.com/repos/acme/widgets/pulls/42/reviews");
      const payload = JSON.parse(call[1].body);
      expect(payload.event).toBe("REQUEST_CHANGES");
      expect(payload.comments).toHaveLength(1);
      expect(payload.comments[0].path).toBe("src/index.ts");
      expect(result.url).toContain("pullrequestreview");
    });
  });

  describe("listIssues", () => {
    it("fetches issues and maps response", async () => {
      mockJsonResponse([
        {
          id: 1,
          number: 10,
          title: "Bug",
          body: "broken",
          state: "open",
          html_url: "https://github.com/acme/widgets/issues/10",
          labels: [{ name: "bug" }],
          user: { login: "alice" },
          assignee: null,
          pull_request: undefined,
          created_at: "2024-01-01",
          updated_at: "2024-01-02",
        },
      ]);

      const issues = await platform.listIssues(ri, { state: "open" });

      expect(issues).toHaveLength(1);
      expect(issues[0].number).toBe(10);
      expect(issues[0].isPullRequest).toBe(false);
    });
  });

  describe("createLabel", () => {
    it("ignores 422 (already exists)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: () => Promise.resolve("already exists"),
      });

      await expect(
        platform.createLabel(ri, { name: "optio", color: "6d28d9" }),
      ).resolves.not.toThrow();
    });
  });

  describe("getRepoMetadata", () => {
    it("fetches repo metadata", async () => {
      mockJsonResponse({
        full_name: "acme/widgets",
        default_branch: "main",
        private: true,
      });

      const meta = await platform.getRepoMetadata(ri);

      expect(meta).toEqual({
        fullName: "acme/widgets",
        defaultBranch: "main",
        isPrivate: true,
      });
    });
  });

  describe("listRepoContents", () => {
    it("fetches repo contents", async () => {
      mockJsonResponse([
        { name: "package.json", type: "file" },
        { name: "src", type: "dir" },
      ]);

      const contents = await platform.listRepoContents(ri);

      expect(contents).toEqual([
        { name: "package.json", type: "file" },
        { name: "src", type: "dir" },
      ]);
    });
  });

  describe("error handling", () => {
    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ message: "Not Found" }),
        text: () => Promise.resolve("Not Found"),
      });

      await expect(platform.getPullRequest(ri, 999)).rejects.toThrow("GitHub API error 404");
    });
  });
});
