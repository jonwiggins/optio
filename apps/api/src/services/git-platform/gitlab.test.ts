import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitLabPlatform } from "./gitlab.js";
import type { RepoIdentifier } from "@optio/shared";

const ri: RepoIdentifier = {
  platform: "gitlab",
  host: "gitlab.com",
  owner: "acme",
  repo: "widgets",
  apiBaseUrl: "https://gitlab.com/api/v4",
};

const projectId = encodeURIComponent("acme/widgets");
const mockFetch = vi.fn();

describe("GitLabPlatform", () => {
  let platform: GitLabPlatform;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;
    platform = new GitLabPlatform("glpat-test123");
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

  it("has type gitlab", () => {
    expect(platform.type).toBe("gitlab");
  });

  describe("getPullRequest", () => {
    it("fetches MR and maps to PullRequest", async () => {
      mockJsonResponse({
        iid: 7,
        title: "Add feature",
        description: "Implements X",
        state: "opened",
        draft: false,
        sha: "def456",
        diff_refs: { head_sha: "def456" },
        target_branch: "main",
        web_url: "https://gitlab.com/acme/widgets/-/merge_requests/7",
        author: { username: "alice" },
        assignees: [],
        labels: ["feature"],
        merge_status: "can_be_merged",
        created_at: "2024-01-01",
        updated_at: "2024-01-02",
      });

      const pr = await platform.getPullRequest(ri, 7);

      expect(mockFetch).toHaveBeenCalledWith(
        `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/7`,
        expect.objectContaining({
          headers: expect.objectContaining({
            "PRIVATE-TOKEN": "glpat-test123",
          }),
        }),
      );
      expect(pr.number).toBe(7);
      expect(pr.title).toBe("Add feature");
      expect(pr.body).toBe("Implements X");
      expect(pr.state).toBe("open");
      expect(pr.merged).toBe(false);
      expect(pr.mergeable).toBe(true);
      expect(pr.headSha).toBe("def456");
    });

    it("maps merged MR state correctly", async () => {
      mockJsonResponse({
        iid: 8,
        state: "merged",
        title: "",
        description: "",
        sha: "abc",
        target_branch: "main",
        web_url: "",
        author: { username: "bob" },
        merge_status: "can_be_merged",
        created_at: "",
        updated_at: "",
      });

      const pr = await platform.getPullRequest(ri, 8);
      expect(pr.state).toBe("closed");
      expect(pr.merged).toBe(true);
    });
  });

  describe("getCIChecks", () => {
    it("fetches pipelines then jobs", async () => {
      // First call: pipelines
      mockJsonResponse([{ id: 100 }]);
      // Second call: jobs
      mockJsonResponse([
        { name: "build", status: "success" },
        { name: "test", status: "failed" },
        { name: "deploy", status: "manual" },
      ]);

      const checks = await platform.getCIChecks(ri, "abc123");

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toContain(`/pipelines?sha=abc123`);
      expect(mockFetch.mock.calls[1][0]).toContain(`/pipelines/100/jobs`);
      expect(checks).toEqual([
        { name: "build", status: "completed", conclusion: "success" },
        { name: "test", status: "completed", conclusion: "failure" },
        { name: "deploy", status: "completed", conclusion: "skipped" },
      ]);
    });

    it("returns empty array when no pipelines", async () => {
      mockJsonResponse([]);
      const checks = await platform.getCIChecks(ri, "abc123");
      expect(checks).toEqual([]);
    });
  });

  describe("getReviews", () => {
    it("combines approvals and discussion notes", async () => {
      // Approvals
      mockJsonResponse({
        approved_by: [{ user: { username: "alice" } }],
      });
      // Notes
      mockJsonResponse([
        { author: { username: "bob" }, body: "Looks good", system: false },
        { author: { username: "system" }, body: "merged", system: true },
      ]);

      const reviews = await platform.getReviews(ri, 7);

      expect(reviews).toEqual([
        { author: "alice", state: "APPROVED", body: "" },
        { author: "bob", state: "COMMENTED", body: "Looks good" },
      ]);
    });
  });

  describe("mergePullRequest", () => {
    it("sends PUT with squash option", async () => {
      mockJsonResponse({ state: "merged" });

      await platform.mergePullRequest(ri, 7, "squash");

      const call = mockFetch.mock.calls[0];
      expect(call[0]).toBe(
        `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/7/merge`,
      );
      expect(call[1].method).toBe("PUT");
      const body = JSON.parse(call[1].body);
      expect(body.squash).toBe(true);
      expect(body.should_remove_source_branch).toBe(true);
    });
  });

  describe("submitReview", () => {
    it("approves and posts body as note", async () => {
      // Approve call
      mockJsonResponse({});
      // Note call
      mockJsonResponse({});

      const result = await platform.submitReview(ri, 7, {
        event: "APPROVE",
        body: "Ship it!",
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toContain("/approve");
      expect(mockFetch.mock.calls[1][0]).toContain("/notes");
      expect(result.url).toContain("merge_requests/7");
    });

    it("posts REQUEST_CHANGES with prefix", async () => {
      // Note call (no approve call for REQUEST_CHANGES)
      mockJsonResponse({});

      await platform.submitReview(ri, 7, {
        event: "REQUEST_CHANGES",
        body: "Fix tests",
      });

      const noteBody = JSON.parse(mockFetch.mock.calls[0][1].body).body;
      expect(noteBody).toContain("**Changes Requested:**");
      expect(noteBody).toContain("Fix tests");
    });
  });

  describe("listIssues", () => {
    it("maps GitLab issue fields", async () => {
      mockJsonResponse([
        {
          id: 1,
          iid: 10,
          title: "Bug",
          description: "broken",
          state: "opened",
          web_url: "https://gitlab.com/acme/widgets/-/issues/10",
          labels: ["bug"],
          author: { username: "alice" },
          assignee: null,
          created_at: "2024-01-01",
          updated_at: "2024-01-02",
        },
      ]);

      const issues = await platform.listIssues(ri, { state: "open" });

      expect(mockFetch.mock.calls[0][0]).toContain("state=opened");
      expect(issues).toHaveLength(1);
      expect(issues[0].number).toBe(10);
      expect(issues[0].state).toBe("open");
      expect(issues[0].body).toBe("broken");
      expect(issues[0].isPullRequest).toBe(false);
    });
  });

  describe("closeIssue", () => {
    it("sends PUT with state_event close", async () => {
      mockJsonResponse({});

      await platform.closeIssue(ri, 10);

      const call = mockFetch.mock.calls[0];
      expect(call[1].method).toBe("PUT");
      const body = JSON.parse(call[1].body);
      expect(body.state_event).toBe("close");
    });
  });

  describe("createLabel", () => {
    it("ignores 409 (already exists)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: () => Promise.resolve("already exists"),
      });

      await expect(
        platform.createLabel(ri, { name: "optio", color: "6d28d9" }),
      ).resolves.not.toThrow();
    });

    it("prepends # to color", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      });

      await platform.createLabel(ri, { name: "optio", color: "6d28d9" });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.color).toBe("#6d28d9");
    });
  });

  describe("getRepoMetadata", () => {
    it("maps GitLab project fields", async () => {
      mockJsonResponse({
        path_with_namespace: "acme/widgets",
        default_branch: "develop",
        visibility: "private",
      });

      const meta = await platform.getRepoMetadata(ri);

      expect(meta).toEqual({
        fullName: "acme/widgets",
        defaultBranch: "develop",
        isPrivate: true,
      });
    });

    it("detects public visibility", async () => {
      mockJsonResponse({
        path_with_namespace: "acme/widgets",
        default_branch: "main",
        visibility: "public",
      });

      const meta = await platform.getRepoMetadata(ri);
      expect(meta.isPrivate).toBe(false);
    });
  });

  describe("listRepoContents", () => {
    it("uses repository/tree endpoint", async () => {
      mockJsonResponse([
        { name: "README.md", type: "blob" },
        { name: "src", type: "tree" },
      ]);

      const contents = await platform.listRepoContents(ri);

      expect(mockFetch.mock.calls[0][0]).toContain("/repository/tree");
      expect(contents).toEqual([
        { name: "README.md", type: "file" },
        { name: "src", type: "dir" },
      ]);
    });
  });

  describe("error handling", () => {
    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve("Not Found"),
      });

      await expect(platform.getPullRequest(ri, 999)).rejects.toThrow("GitLab API error 404");
    });
  });
});
