import { beforeEach, describe, expect, it, vi } from "vitest";

const redisStore = new Map<string, string>();
const mockRedis = {
  get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => {
    redisStore.set(key, value);
    return "OK";
  }),
};
vi.mock("./event-bus.js", () => ({ getRedisClient: () => mockRedis }));

const platform = {
  getPullRequest: vi.fn(),
  getCIChecks: vi.fn(),
  getReviews: vi.fn(),
  getIssue: vi.fn(),
};
const mockGetGitPlatformForRepo = vi.fn();
vi.mock("./git-token-service.js", () => ({
  getGitPlatformForRepo: (...args: unknown[]) => mockGetGitPlatformForRepo(...args),
}));

const providerRows: any[] = [];
vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => providerRows }) }),
  },
}));
vi.mock("../db/schema.js", () => ({ ticketProviders: { source: "source", enabled: "enabled" } }));
vi.mock("./secret-service.js", () => ({
  retrieveSecret: vi.fn(async () => JSON.stringify({ apiKey: "lin_x" })),
}));
const fetchTicketState = vi.fn();
vi.mock("@optio/ticket-providers", () => ({
  getTicketProvider: () => ({ fetchTicketState }),
}));
vi.mock("../logger.js", () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

import { getWorkLinkStatuses } from "./work-link-status-service.js";

const ctx = { userId: "u1", workspaceId: "ws1" };
const PR = "https://github.com/acme/app/pull/7";

describe("getWorkLinkStatuses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStore.clear();
    providerRows.length = 0;
    mockGetGitPlatformForRepo.mockResolvedValue({
      platform,
      ri: { platform: "github", owner: "acme", repo: "app" },
    });
  });

  it("reports an open PR with its CI and review, and caches it", async () => {
    platform.getPullRequest.mockResolvedValue({
      state: "open",
      merged: false,
      draft: false,
      headSha: "abc",
    });
    platform.getCIChecks.mockResolvedValue([
      { name: "ci", status: "completed", conclusion: "success" },
    ]);
    platform.getReviews.mockResolvedValue([{ author: "r", state: "APPROVED", body: "" }]);

    const first = await getWorkLinkStatuses([PR], ctx);
    expect(first).toEqual([{ url: PR, state: "open", checks: "passing", review: "approved" }]);
    expect(mockGetGitPlatformForRepo).toHaveBeenCalledWith("https://github.com/acme/app", {
      userId: "u1",
      workspaceId: "ws1",
    });
    expect(platform.getCIChecks).toHaveBeenCalledWith(expect.anything(), "abc");
    expect(mockRedis.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), "EX", 60);

    const again = await getWorkLinkStatuses([PR], ctx);
    expect(again).toEqual(first);
    expect(platform.getPullRequest).toHaveBeenCalledTimes(1);
  });

  it("skips CI / review for a merged PR and remembers it longer", async () => {
    platform.getPullRequest.mockResolvedValue({ state: "closed", merged: true, draft: false });
    expect(await getWorkLinkStatuses([PR], ctx)).toEqual([{ url: PR, state: "merged" }]);
    expect(platform.getCIChecks).not.toHaveBeenCalled();
    expect(mockRedis.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), "EX", 900);
  });

  it("calls a draft a draft", async () => {
    platform.getPullRequest.mockResolvedValue({
      state: "open",
      merged: false,
      draft: true,
      headSha: "s",
    });
    platform.getCIChecks.mockResolvedValue([]);
    platform.getReviews.mockResolvedValue([]);
    expect(await getWorkLinkStatuses([PR], ctx)).toEqual([
      { url: PR, state: "draft", checks: "none", review: "none" },
    ]);
  });

  it("resolves a bare ref through the issue endpoint, as a PR when it is one", async () => {
    const ref = "https://github.com/acme/app/issues/9";
    platform.getIssue.mockResolvedValue({ isPullRequest: true, state: "open" });
    platform.getPullRequest.mockResolvedValue({ state: "closed", merged: false, draft: false });
    expect(await getWorkLinkStatuses([ref], ctx)).toEqual([{ url: ref, state: "closed" }]);
    expect(platform.getPullRequest).toHaveBeenCalledWith(expect.anything(), 9);

    redisStore.clear();
    platform.getIssue.mockResolvedValue({ isPullRequest: false, state: "closed" });
    expect(await getWorkLinkStatuses([ref], ctx)).toEqual([{ url: ref, state: "done" }]);
  });

  it("answers null (cached briefly) when the host cannot be asked, and drops non-links", async () => {
    mockGetGitPlatformForRepo.mockRejectedValue(new Error("No GitHub token"));
    expect(await getWorkLinkStatuses([PR, "https://example.com/x"], ctx)).toEqual([
      { url: PR, state: null },
    ]);
    expect(mockRedis.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), "EX", 120);
  });

  it("asks the workspace's Linear provider for a ticket", async () => {
    providerRows.push({ id: "p1", source: "linear", enabled: true, config: {} });
    fetchTicketState.mockResolvedValue("in_progress");
    const url = "https://linear.app/acme/issue/ENG-12/slug";
    expect(await getWorkLinkStatuses([url], ctx)).toEqual([{ url, state: "in_progress" }]);
    expect(fetchTicketState).toHaveBeenCalledWith("ENG-12", { apiKey: "lin_x" });
  });

  it("only asks a Jira provider at the link's own site", async () => {
    providerRows.push({
      id: "p2",
      source: "jira",
      enabled: true,
      config: { baseUrl: "https://other.atlassian.net" },
    });
    fetchTicketState.mockResolvedValue("done");
    const url = "https://acme.atlassian.net/browse/OPS-3";
    expect(await getWorkLinkStatuses([url], ctx)).toEqual([{ url, state: null }]);
    expect(fetchTicketState).not.toHaveBeenCalled();
  });
});
