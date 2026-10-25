import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { GitHubApiError } from "../services/git-platform/github.js";

const mockLaunchPrReview = vi.fn();
const mockListOpenPrs = vi.fn();
vi.mock("../services/pr-review-service.js", () => ({
  launchPrReview: (...args: unknown[]) => mockLaunchPrReview(...args),
  listOpenPrs: (...args: unknown[]) => mockListOpenPrs(...args),
}));
vi.mock("../services/optio-action-service.js", () => ({
  logAction: vi.fn(() => Promise.resolve()),
}));
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { prReviewRoutes } from "./pr-reviews.js";

describe("GET /api/pull-requests", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildRouteTestApp(prReviewRoutes);
  });

  it("passes the repo, the search and the limit to the service", async () => {
    const row = {
      id: 12,
      number: 12,
      title: "Fix login",
      url: "https://gitlab.example/g/p/-/merge_requests/12",
      state: "open",
      author: "alice",
      headBranch: "bug/login",
      baseBranch: "main",
      updatedAt: "2024-01-01T00:00:00Z",
      repo: {
        id: "repo-1",
        fullName: "g/p",
        repoUrl: "https://gitlab.example/g/p",
        gitPlatform: "gitlab",
      },
    };
    mockListOpenPrs.mockResolvedValue([row]);

    const res = await app.inject({
      method: "GET",
      url: "/api/pull-requests?repoId=repo-1&q=login&limit=20",
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ pullRequests: [row] });
    expect(mockListOpenPrs).toHaveBeenCalledWith("ws-1", "repo-1", { search: "login", limit: 20 });
  });

  it("lists everything without a query", async () => {
    mockListOpenPrs.mockResolvedValue([]);
    const res = await app.inject({ method: "GET", url: "/api/pull-requests" });
    expect(res.statusCode).toBe(200);
    expect(mockListOpenPrs).toHaveBeenCalledWith("ws-1", undefined, {
      search: undefined,
      limit: undefined,
    });
  });

  it("rejects a limit over 100", async () => {
    const res = await app.inject({ method: "GET", url: "/api/pull-requests?limit=500" });
    expect(res.statusCode).toBe(400);
    expect(mockListOpenPrs).not.toHaveBeenCalled();
  });
});

describe("POST /api/pr-reviews", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildRouteTestApp(prReviewRoutes);
  });

  it("reports a GitHub failure in words, not GitHub's raw JSON", async () => {
    mockLaunchPrReview.mockRejectedValue(
      new GitHubApiError(
        401,
        JSON.stringify({
          message: "Bad credentials",
          documentation_url: "https://docs.github.com/rest",
          status: "401",
        }),
      ),
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/pr-reviews",
      payload: { prUrl: "https://github.com/acme/widgets/pull/7" },
    });

    // Optio's own status stays 400 (a 401 here would read as "not signed in
    // to Optio"); GitHub's status travels in the message.
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "GitHub API error 401: Bad credentials (see https://docs.github.com/rest)",
    });
  });

  it("passes other failures through unchanged", async () => {
    mockLaunchPrReview.mockRejectedValue(new Error("Could not parse PR URL"));

    const res = await app.inject({
      method: "POST",
      url: "/api/pr-reviews",
      payload: { prUrl: "not a url" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Could not parse PR URL" });
  });
});
