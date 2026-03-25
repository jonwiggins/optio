import { describe, it, expect, vi } from "vitest";
import { GitHubTicketProvider } from "./github.js";
import type { GitHubProviderConfig } from "./github.js";

// Mock Octokit
vi.mock("@octokit/rest", () => {
  return {
    Octokit: vi.fn().mockImplementation(() => ({
      issues: {
        listForRepo: vi.fn(),
      },
    })),
  };
});

import { Octokit } from "@octokit/rest";

function makeIssue(number: number) {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    html_url: `https://github.com/owner/repo/issues/${number}`,
    labels: [{ name: "optio" }],
    assignee: { login: "user1" },
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    pull_request: undefined,
  };
}

function baseConfig(): GitHubProviderConfig {
  return { token: "test-token", owner: "owner", repo: "repo" };
}

describe("GitHubTicketProvider pagination", () => {
  it("fetches a single page when fewer than 100 issues", async () => {
    const issues = Array.from({ length: 3 }, (_, i) => makeIssue(i + 1));
    const listForRepo = vi.fn().mockResolvedValueOnce({
      data: issues,
      headers: { link: "" },
    });
    vi.mocked(Octokit).mockImplementation(
      () => ({ issues: { listForRepo } }) as unknown as InstanceType<typeof Octokit>,
    );

    const provider = new GitHubTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(3);
    expect(listForRepo).toHaveBeenCalledTimes(1);
    expect(listForRepo).toHaveBeenCalledWith(expect.objectContaining({ per_page: 100, page: 1 }));
  });

  it("paginates across multiple pages using Link header", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeIssue(i + 1));
    const page2 = Array.from({ length: 30 }, (_, i) => makeIssue(i + 101));

    const listForRepo = vi
      .fn()
      .mockResolvedValueOnce({
        data: page1,
        headers: {
          link: '<https://api.github.com/repos/owner/repo/issues?page=2>; rel="next"',
        },
      })
      .mockResolvedValueOnce({
        data: page2,
        headers: { link: "" },
      });

    vi.mocked(Octokit).mockImplementation(
      () => ({ issues: { listForRepo } }) as unknown as InstanceType<typeof Octokit>,
    );

    const provider = new GitHubTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(130);
    expect(listForRepo).toHaveBeenCalledTimes(2);
    expect(listForRepo).toHaveBeenNthCalledWith(1, expect.objectContaining({ page: 1 }));
    expect(listForRepo).toHaveBeenNthCalledWith(2, expect.objectContaining({ page: 2 }));
  });

  it("respects maxPages limit", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => makeIssue(i + 1));
    const listForRepo = vi.fn().mockResolvedValue({
      data: fullPage,
      headers: {
        link: '<https://api.github.com/repos/owner/repo/issues?page=2>; rel="next"',
      },
    });

    vi.mocked(Octokit).mockImplementation(
      () => ({ issues: { listForRepo } }) as unknown as InstanceType<typeof Octokit>,
    );

    const provider = new GitHubTicketProvider();
    const config: GitHubProviderConfig = { ...baseConfig(), maxPages: 2 };
    const tickets = await provider.fetchActionableTickets(config);

    expect(listForRepo).toHaveBeenCalledTimes(2);
    expect(tickets).toHaveLength(200);
  });

  it("stops when an empty page is returned", async () => {
    const listForRepo = vi.fn().mockResolvedValueOnce({
      data: [],
      headers: { link: "" },
    });

    vi.mocked(Octokit).mockImplementation(
      () => ({ issues: { listForRepo } }) as unknown as InstanceType<typeof Octokit>,
    );

    const provider = new GitHubTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(0);
    expect(listForRepo).toHaveBeenCalledTimes(1);
  });

  it("filters out pull requests", async () => {
    const issues = [
      makeIssue(1),
      { ...makeIssue(2), pull_request: { url: "https://..." } },
      makeIssue(3),
    ];
    const listForRepo = vi.fn().mockResolvedValueOnce({
      data: issues,
      headers: { link: "" },
    });

    vi.mocked(Octokit).mockImplementation(
      () => ({ issues: { listForRepo } }) as unknown as InstanceType<typeof Octokit>,
    );

    const provider = new GitHubTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(2);
    expect(tickets.map((t) => t.externalId)).toEqual(["1", "3"]);
  });
});
