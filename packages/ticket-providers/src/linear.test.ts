import { describe, it, expect, vi } from "vitest";
import { LinearTicketProvider } from "./linear.js";
import type { LinearProviderConfig } from "./linear.js";

// Mock Linear SDK
vi.mock("@linear/sdk", () => {
  return {
    LinearClient: vi.fn().mockImplementation(() => ({
      issues: vi.fn(),
    })),
  };
});

import { LinearClient } from "@linear/sdk";

function makeLinearIssue(id: string, num: number) {
  return {
    id,
    identifier: `ENG-${num}`,
    title: `Issue ${num}`,
    description: `Description ${num}`,
    url: `https://linear.app/team/issue/ENG-${num}`,
    priority: 1,
    createdAt: new Date("2025-01-01"),
  };
}

function baseConfig(): LinearProviderConfig {
  return { apiKey: "test-key" };
}

describe("LinearTicketProvider pagination", () => {
  it("fetches a single page when hasNextPage is false", async () => {
    const nodes = Array.from({ length: 3 }, (_, i) => makeLinearIssue(`id-${i}`, i + 1));
    const issuesFn = vi.fn().mockResolvedValueOnce({
      nodes,
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    vi.mocked(LinearClient).mockImplementation(
      () => ({ issues: issuesFn }) as unknown as InstanceType<typeof LinearClient>,
    );

    const provider = new LinearTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(3);
    expect(issuesFn).toHaveBeenCalledTimes(1);
  });

  it("paginates across multiple pages using endCursor", async () => {
    const page1Nodes = Array.from({ length: 50 }, (_, i) => makeLinearIssue(`id-${i}`, i + 1));
    const page2Nodes = Array.from({ length: 10 }, (_, i) =>
      makeLinearIssue(`id-${i + 50}`, i + 51),
    );

    const issuesFn = vi
      .fn()
      .mockResolvedValueOnce({
        nodes: page1Nodes,
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      })
      .mockResolvedValueOnce({
        nodes: page2Nodes,
        pageInfo: { hasNextPage: false, endCursor: null },
      });

    vi.mocked(LinearClient).mockImplementation(
      () => ({ issues: issuesFn }) as unknown as InstanceType<typeof LinearClient>,
    );

    const provider = new LinearTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(60);
    expect(issuesFn).toHaveBeenCalledTimes(2);
    // Second call should include the cursor
    expect(issuesFn).toHaveBeenNthCalledWith(2, expect.objectContaining({ after: "cursor-1" }));
  });

  it("respects maxPages limit", async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => makeLinearIssue(`id-${i}`, i + 1));

    const issuesFn = vi.fn().mockResolvedValue({
      nodes: fullPage,
      pageInfo: { hasNextPage: true, endCursor: "cursor-next" },
    });

    vi.mocked(LinearClient).mockImplementation(
      () => ({ issues: issuesFn }) as unknown as InstanceType<typeof LinearClient>,
    );

    const provider = new LinearTicketProvider();
    const config: LinearProviderConfig = { ...baseConfig(), maxPages: 3 };
    const tickets = await provider.fetchActionableTickets(config);

    expect(issuesFn).toHaveBeenCalledTimes(3);
    expect(tickets).toHaveLength(150);
  });

  it("returns empty when no issues match", async () => {
    const issuesFn = vi.fn().mockResolvedValueOnce({
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    vi.mocked(LinearClient).mockImplementation(
      () => ({ issues: issuesFn }) as unknown as InstanceType<typeof LinearClient>,
    );

    const provider = new LinearTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(0);
    expect(issuesFn).toHaveBeenCalledTimes(1);
  });

  it("passes team filter when teamId is configured", async () => {
    const issuesFn = vi.fn().mockResolvedValueOnce({
      nodes: [makeLinearIssue("id-1", 1)],
      pageInfo: { hasNextPage: false, endCursor: null },
    });

    vi.mocked(LinearClient).mockImplementation(
      () => ({ issues: issuesFn }) as unknown as InstanceType<typeof LinearClient>,
    );

    const provider = new LinearTicketProvider();
    const config: LinearProviderConfig = {
      ...baseConfig(),
      teamId: "team-123",
    };
    await provider.fetchActionableTickets(config);

    expect(issuesFn).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({
          team: { id: { eq: "team-123" } },
        }),
      }),
    );
  });
});
