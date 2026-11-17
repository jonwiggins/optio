import { describe, expect, it, vi } from "vitest";
import type { RepoIdentifier } from "@optio/shared";
import { fetchGitHubPrFacts, githubGraphqlUrl, mapGitHubPrNode } from "./github-pr-facts.js";
import { mapDetailedMergeStatus, mapGitLabMr } from "./gitlab-pr-facts.js";

const gh: RepoIdentifier = {
  platform: "github",
  host: "github.com",
  owner: "acme",
  repo: "app",
  apiBaseUrl: "https://api.github.com",
};

function ghNode(over: Record<string, unknown> = {}) {
  return {
    number: 12,
    title: "Add the widget",
    url: "https://github.com/acme/app/pull/12",
    isDraft: false,
    createdAt: "2026-10-30T10:00:00Z",
    updatedAt: "2026-11-01T10:00:00Z",
    body: "Closes #3. cc @kim, not `@code`",
    additions: 40,
    deletions: 2,
    author: { login: "jon" },
    headRefName: "widget",
    baseRefName: "main",
    headRefOid: "deadbeef",
    isCrossRepository: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "CHANGES_REQUESTED",
    assignees: { nodes: [{ login: "jon" }] },
    reviewRequests: {
      nodes: [
        { requestedReviewer: { __typename: "User", login: "lee" } },
        { requestedReviewer: { __typename: "Team", combinedSlug: "acme/web" } },
      ],
    },
    latestReviews: {
      nodes: [
        {
          author: { login: "kim" },
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-10-31T09:00:00Z",
        },
        { author: { login: "sam" }, state: "PENDING", submittedAt: null },
      ],
    },
    reviewThreads: {
      nodes: [
        {
          isResolved: false,
          path: "src/a.ts",
          comments: {
            nodes: [
              { author: { login: "kim" }, createdAt: "2026-10-31T09:00:00Z" },
              { author: { login: "jon" }, createdAt: "2026-10-31T10:00:00Z" },
              { author: { login: "kim" }, createdAt: "2026-10-31T11:00:00Z" },
            ],
          },
        },
        { isResolved: true, path: null, comments: { nodes: [] } },
      ],
    },
    comments: {
      nodes: [{ author: null, createdAt: "2026-10-31T12:00:00Z", body: "@jon ping" }],
    },
    commits: {
      nodes: [
        {
          commit: {
            committedDate: "2026-10-30T12:00:00Z",
            statusCheckRollup: {
              state: "PENDING",
              contexts: {
                nodes: [
                  {
                    __typename: "CheckRun",
                    name: "lint",
                    status: "COMPLETED",
                    conclusion: "FAILURE",
                  },
                  { __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null },
                  { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" },
                  {
                    __typename: "CheckRun",
                    name: "ok",
                    status: "COMPLETED",
                    conclusion: "SUCCESS",
                  },
                ],
              },
            },
          },
        },
      ],
    },
    ...over,
  };
}

describe("mapGitHubPrNode", () => {
  it("maps everything the panel reads", () => {
    const f = mapGitHubPrNode(ghNode(), gh);
    expect(f).toMatchObject({
      number: 12,
      platform: "github",
      repoFullName: "acme/app",
      author: "jon",
      headBranch: "widget",
      lastPushAt: "2026-10-30T12:00:00Z",
      // a failure while others still run is already red
      checks: "failing",
      failingChecks: ["lint", "ci/legacy"],
      mergeState: "blocked",
      reviewDecision: "changes_requested",
      requestedReviewers: ["lee"],
      requestedTeams: ["acme/web"],
      assignees: ["jon"],
      bodyMentions: ["kim"],
      additions: 40,
    });
    expect(f.reviews).toEqual([
      { author: "kim", state: "changes_requested", submittedAt: "2026-10-31T09:00:00Z" },
    ]);
    expect(f.threads).toEqual([
      {
        resolved: false,
        participants: ["kim", "jon"],
        lastAuthor: "kim",
        lastAt: "2026-10-31T11:00:00Z",
        path: "src/a.ts",
      },
    ]);
    expect(f.comments).toEqual([
      { author: "ghost", at: "2026-10-31T12:00:00Z", mentions: ["jon"] },
    ]);
  });

  it("reads merge state", () => {
    const m = (mergeable: string, mergeStateStatus: string) =>
      mapGitHubPrNode(ghNode({ mergeable, mergeStateStatus }), gh).mergeState;
    expect(m("CONFLICTING", "DIRTY")).toBe("conflict");
    expect(m("MERGEABLE", "BEHIND")).toBe("behind");
    expect(m("MERGEABLE", "CLEAN")).toBe("clean");
    expect(m("MERGEABLE", "UNSTABLE")).toBe("clean");
    expect(m("UNKNOWN", "UNKNOWN")).toBe("unknown");
  });

  it("no rollup → no checks", () => {
    const f = mapGitHubPrNode(
      ghNode({ commits: { nodes: [{ commit: { committedDate: null } }] } }),
      gh,
    );
    expect(f.checks).toBe("none");
    expect(f.failingChecks).toEqual([]);
  });
});

describe("fetchGitHubPrFacts", () => {
  it("posts to the GraphQL endpoint and follows pages", async () => {
    const page = (nodes: unknown[], hasNextPage: boolean) =>
      new Response(
        JSON.stringify({
          data: {
            repository: { pullRequests: { pageInfo: { hasNextPage, endCursor: "c1" }, nodes } },
          },
        }),
        { status: 200 },
      );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(page([ghNode()], true))
      .mockResolvedValueOnce(page([ghNode({ number: 13 })], false));
    const facts = await fetchGitHubPrFacts(gh, "tok", { fetchImpl: fetchImpl as typeof fetch });
    expect(facts.map((f) => f.number)).toEqual([12, 13]);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.github.com/graphql");
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).variables.after).toBe("c1");
  });

  it("throws on GraphQL errors and HTTP errors", async () => {
    const errs = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: "Could not resolve to a Repository" }] }), {
        status: 200,
      }),
    );
    await expect(fetchGitHubPrFacts(gh, "t", { fetchImpl: errs as typeof fetch })).rejects.toThrow(
      /Could not resolve/,
    );
    const denied = vi
      .fn()
      .mockResolvedValue(new Response('{"message":"Bad credentials"}', { status: 401 }));
    await expect(
      fetchGitHubPrFacts(gh, "t", { fetchImpl: denied as typeof fetch }),
    ).rejects.toThrow(/401: Bad credentials/);
  });

  it("GitHub Enterprise has its GraphQL under /api/graphql", () => {
    expect(githubGraphqlUrl("https://ghe.acme.io/api/v3")).toBe("https://ghe.acme.io/api/graphql");
    expect(githubGraphqlUrl("https://api.github.com/")).toBe("https://api.github.com/graphql");
  });
});

describe("mapGitLabMr", () => {
  const gl: RepoIdentifier = {
    ...gh,
    platform: "gitlab",
    host: "gitlab.com",
    apiBaseUrl: "https://gitlab.com/api/v4",
  };
  const mr = {
    iid: 4,
    title: "Draft: speed up",
    web_url: "https://gitlab.com/acme/app/-/merge_requests/4",
    author: { username: "jon" },
    draft: true,
    created_at: "2026-10-30T10:00:00Z",
    updated_at: "2026-11-01T10:00:00Z",
    source_branch: "speed",
    target_branch: "main",
    sha: "abc",
    source_project_id: 1,
    target_project_id: 1,
    head_pipeline: { id: 9, status: "failed" },
    detailed_merge_status: "need_rebase",
    description: "for @kim",
    assignees: [{ username: "jon" }],
  };

  it("maps reviewers, discussions and the pipeline", () => {
    const f = mapGitLabMr(mr, gl, {
      reviewers: [
        { user: { username: "kim" }, state: "requested_changes" },
        { user: { username: "lee" }, state: "unreviewed" },
      ],
      discussions: [
        {
          notes: [
            {
              author: { username: "kim" },
              created_at: "2026-10-31T09:00:00Z",
              resolvable: true,
              resolved: false,
              position: { new_path: "a.rb" },
            },
            {
              author: { username: "jon" },
              created_at: "2026-10-31T10:00:00Z",
              resolvable: true,
              resolved: false,
            },
          ],
        },
        {
          notes: [
            {
              author: { username: "lee" },
              created_at: "2026-10-31T11:00:00Z",
              body: "@jon thoughts?",
            },
          ],
        },
        {
          notes: [
            { system: true, author: { username: "jon" }, created_at: "2026-10-31T11:00:00Z" },
          ],
        },
      ],
      lastCommitAt: "2026-10-30T12:00:00Z",
      failingChecks: ["rspec"],
    });
    expect(f).toMatchObject({
      platform: "gitlab",
      draft: true,
      checks: "failing",
      failingChecks: ["rspec"],
      mergeState: "behind",
      reviewDecision: "changes_requested",
      requestedReviewers: ["lee"],
      bodyMentions: ["kim"],
      lastPushAt: "2026-10-30T12:00:00Z",
    });
    expect(f.reviews).toEqual([
      { author: "kim", state: "changes_requested", submittedAt: "2026-10-31T09:00:00Z" },
    ]);
    expect(f.threads).toEqual([
      {
        resolved: false,
        participants: ["kim", "jon"],
        lastAuthor: "jon",
        lastAt: "2026-10-31T10:00:00Z",
        path: "a.rb",
      },
    ]);
    expect(f.comments).toEqual([{ author: "lee", at: "2026-10-31T11:00:00Z", mentions: ["jon"] }]);
  });

  it("reads detailed_merge_status", () => {
    expect(mapDetailedMergeStatus("conflict")).toBe("conflict");
    expect(mapDetailedMergeStatus("mergeable", true)).toBe("conflict");
    expect(mapDetailedMergeStatus("need_rebase")).toBe("behind");
    expect(mapDetailedMergeStatus("discussions_not_resolved")).toBe("blocked");
    expect(mapDetailedMergeStatus("mergeable")).toBe("clean");
    expect(mapDetailedMergeStatus("checking")).toBe("unknown");
  });
});
