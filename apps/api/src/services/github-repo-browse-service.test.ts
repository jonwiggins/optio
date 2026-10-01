import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { browseGitHubRepos, resetRepoBrowseCache } from "./github-repo-browse-service.js";

const item = (name: string, description: string | null = null) => ({
  full_name: name,
  html_url: `https://github.com/${name}`,
  clone_url: `https://github.com/${name}.git`,
  default_branch: "main",
  private: false,
  description,
  pushed_at: "2026-01-01T00:00:00Z",
});

function response(body: unknown, next = false) {
  return {
    ok: true,
    json: async () => body,
    headers: new Headers(next ? { link: '<https://api.github.com/x?page=2>; rel="next"' } : {}),
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetRepoBrowseCache();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("browseGitHubRepos", () => {
  it("lists a PAT's own, collaborator and org repos one page at a time", async () => {
    fetchMock.mockResolvedValue(response([item("me/a"), item("org/b")], true));

    const res = await browseGitHubRepos("ghp_x", { page: 2, perPage: 2 });

    expect(res.repos.map((r) => r.fullName)).toEqual(["me/a", "org/b"]);
    expect(res.hasMore).toBe(true);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/user/repos?");
    expect(url).toContain("affiliation=owner,collaborator,organization_member");
    expect(url).toContain("per_page=2&page=2");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer ghp_x");
  });

  it("uses the installation endpoint for a GitHub App token", async () => {
    fetchMock.mockResolvedValue(response({ total_count: 1, repositories: [item("org/c")] }));

    const res = await browseGitHubRepos("ghs_install");

    expect(fetchMock.mock.calls[0][0]).toContain("/installation/repositories?");
    expect(res.repos.map((r) => r.fullName)).toEqual(["org/c"]);
    expect(res.hasMore).toBe(false);
  });

  it("searches across pages by name or description, then pages the matches", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => item(`org/repo-${i}`));
    page1[5] = item("org/payments-api");
    fetchMock
      .mockResolvedValueOnce(response(page1, true))
      .mockResolvedValueOnce(
        response([item("org/web", "Payments dashboard"), item("org/other")], false),
      );

    const first = await browseGitHubRepos("ghp_x", { q: "PAYMENTS", perPage: 1 });
    expect(first.repos.map((r) => r.fullName)).toEqual(["org/payments-api"]);
    expect(first.hasMore).toBe(true);

    // The next page of the same search comes from the cached scan.
    const second = await browseGitHubRepos("ghp_x", { q: "payments", page: 2, perPage: 1 });
    expect(second.repos.map((r) => r.fullName)).toEqual(["org/web"]);
    expect(second.hasMore).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces GitHub errors", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, headers: new Headers() });
    await expect(browseGitHubRepos("ghp_bad")).rejects.toThrow("GitHub returned 401");
  });
});
