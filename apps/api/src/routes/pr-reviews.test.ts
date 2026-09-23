import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { GitHubApiError } from "../services/git-platform/github.js";

const mockLaunchPrReview = vi.fn();
vi.mock("../services/pr-review-service.js", () => ({
  launchPrReview: (...args: unknown[]) => mockLaunchPrReview(...args),
}));
vi.mock("../services/optio-action-service.js", () => ({
  logAction: vi.fn(() => Promise.resolve()),
}));
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { prReviewRoutes } from "./pr-reviews.js";

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
