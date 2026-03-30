import { describe, it, expect, vi } from "vitest";
import { JiraTicketProvider } from "./jira.js";
import type { JiraProviderConfig } from "./jira.js";

vi.mock("jira.js", () => {
  return {
    Version3Client: vi.fn().mockImplementation(() => ({
      issueSearch: {
        searchForIssuesUsingJql: vi.fn(),
      },
      issueComments: {
        addComment: vi.fn(),
      },
      issues: {
        getTransitions: vi.fn(),
        doTransition: vi.fn(),
      },
    })),
  };
});

import { Version3Client } from "jira.js";

function makeJiraIssue(key: string, num: number, withAttachments = false) {
  const issue: any = {
    key,
    fields: {
      summary: `Issue ${num}`,
      description: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: `Description ${num}` }],
          },
        ],
      },
      status: { name: "To Do" },
      priority: { name: "Medium" },
      assignee: { displayName: "Test User" },
      created: "2025-01-01T00:00:00Z",
      updated: "2025-01-01T00:00:00Z",
      labels: ["optio"],
      project: { key: "TEST" },
    },
  };

  if (withAttachments) {
    issue.fields.attachment = [
      {
        filename: "screenshot.png",
        content: "https://jira.example.com/attachment/123/screenshot.png",
        mimeType: "image/png",
      },
      {
        filename: "log.txt",
        content: "https://jira.example.com/attachment/124/log.txt",
        mimeType: "text/plain",
      },
    ];
  }

  return issue;
}

function baseConfig(): JiraProviderConfig {
  return {
    baseUrl: "https://test.atlassian.net",
    email: "test@example.com",
    apiToken: "test-token",
  };
}

describe("JiraTicketProvider pagination", () => {
  it("fetches a single page when fewer than page size", async () => {
    const issues = Array.from({ length: 3 }, (_, i) => makeJiraIssue(`TEST-${i + 1}`, i + 1));
    const searchForIssuesUsingJql = vi.fn().mockResolvedValueOnce({
      issues,
      total: 3,
    });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJql },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(3);
    expect(searchForIssuesUsingJql).toHaveBeenCalledTimes(1);
    expect(searchForIssuesUsingJql).toHaveBeenCalledWith(
      expect.objectContaining({ startAt: 0, maxResults: 100 }),
    );
  });

  it("paginates across multiple pages using startAt offset", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeJiraIssue(`TEST-${i + 1}`, i + 1));
    const page2 = Array.from({ length: 30 }, (_, i) => makeJiraIssue(`TEST-${i + 101}`, i + 101));

    const searchForIssuesUsingJql = vi
      .fn()
      .mockResolvedValueOnce({
        issues: page1,
        total: 130,
      })
      .mockResolvedValueOnce({
        issues: page2,
        total: 130,
      });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJql },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(130);
    expect(searchForIssuesUsingJql).toHaveBeenCalledTimes(2);
    expect(searchForIssuesUsingJql).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ startAt: 0 }),
    );
    expect(searchForIssuesUsingJql).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startAt: 100 }),
    );
  });

  it("respects maxPages limit", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => makeJiraIssue(`TEST-${i + 1}`, i + 1));
    const searchForIssuesUsingJql = vi.fn().mockResolvedValue({
      issues: fullPage,
      total: 500,
    });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJql },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    const config: JiraProviderConfig = { ...baseConfig(), maxPages: 2 };
    const tickets = await provider.fetchActionableTickets(config);

    expect(searchForIssuesUsingJql).toHaveBeenCalledTimes(2);
    expect(tickets).toHaveLength(200);
  });

  it("returns empty array when no issues match", async () => {
    const searchForIssuesUsingJql = vi.fn().mockResolvedValueOnce({
      issues: [],
      total: 0,
    });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJql },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(0);
    expect(searchForIssuesUsingJql).toHaveBeenCalledTimes(1);
  });

  it("passes project filter when projectKey is configured", async () => {
    const searchForIssuesUsingJql = vi.fn().mockResolvedValueOnce({
      issues: [makeJiraIssue("DEV-1", 1)],
      total: 1,
    });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJql },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    const config: JiraProviderConfig = {
      ...baseConfig(),
      projectKey: "DEV",
    };
    await provider.fetchActionableTickets(config);

    expect(searchForIssuesUsingJql).toHaveBeenCalledWith(
      expect.objectContaining({
        jql: expect.stringContaining('project = "DEV"'),
      }),
    );
  });

  it("transforms JIRA issue fields to Ticket format correctly", async () => {
    const issue = makeJiraIssue("TEST-123", 1);
    const searchForIssuesUsingJql = vi.fn().mockResolvedValueOnce({
      issues: [issue],
      total: 1,
    });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJql },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(1);
    const ticket = tickets[0];
    expect(ticket.externalId).toBe("TEST-123");
    expect(ticket.source).toBe("jira");
    expect(ticket.title).toBe("Issue 1");
    expect(ticket.body).toBe("Description 1\n");
    expect(ticket.url).toBe("https://test.atlassian.net/browse/TEST-123");
    expect(ticket.labels).toEqual(["optio"]);
    expect(ticket.assignee).toBe("Test User");
    expect(ticket.repo).toBe("TEST");
    expect(ticket.metadata).toMatchObject({
      key: "TEST-123",
      status: "To Do",
      priority: "Medium",
      projectKey: "TEST",
    });
  });

  it("includes attachments when present", async () => {
    const issue = makeJiraIssue("TEST-123", 1, true);
    const searchForIssuesUsingJql = vi.fn().mockResolvedValueOnce({
      issues: [issue],
      total: 1,
    });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJql },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets[0].attachments).toHaveLength(2);
    expect(tickets[0].attachments).toEqual([
      {
        filename: "screenshot.png",
        url: "https://jira.example.com/attachment/123/screenshot.png",
        mimeType: "image/png",
      },
      {
        filename: "log.txt",
        url: "https://jira.example.com/attachment/124/log.txt",
        mimeType: "text/plain",
      },
    ]);
  });

  it("converts ADF description to plaintext", async () => {
    const issue = makeJiraIssue("TEST-123", 1);
    const searchForIssuesUsingJql = vi.fn().mockResolvedValueOnce({
      issues: [issue],
      total: 1,
    });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJql },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(typeof tickets[0].body).toBe("string");
    expect(tickets[0].body).toBe("Description 1\n");
  });
});

describe("JiraTicketProvider addComment", () => {
  it("adds a comment to an issue", async () => {
    const addComment = vi.fn().mockResolvedValueOnce({});

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueComments: { addComment },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    await provider.addComment("TEST-123", "This is a comment", baseConfig());

    expect(addComment).toHaveBeenCalledWith({
      issueIdOrKey: "TEST-123",
      comment: expect.objectContaining({
        type: "doc",
        version: 1,
        content: expect.arrayContaining([
          expect.objectContaining({
            type: "paragraph",
          }),
        ]),
      }),
    });
  });
});

describe("JiraTicketProvider updateState", () => {
  it("transitions issue to closed state using configurable status name", async () => {
    const getTransitions = vi.fn().mockResolvedValueOnce({
      transitions: [
        { id: "1", to: { name: "To Do" } },
        { id: "2", to: { name: "Done" } },
        { id: "3", to: { name: "In Progress" } },
      ],
    });
    const doTransition = vi.fn().mockResolvedValueOnce({});

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issues: { getTransitions, doTransition },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    await provider.updateState("TEST-123", "closed", baseConfig());

    expect(getTransitions).toHaveBeenCalledWith({ issueIdOrKey: "TEST-123" });
    expect(doTransition).toHaveBeenCalledWith({
      issueIdOrKey: "TEST-123",
      transition: { id: "2" },
    });
  });

  it("uses custom done status name when configured", async () => {
    const getTransitions = vi.fn().mockResolvedValueOnce({
      transitions: [
        { id: "1", to: { name: "To Do" } },
        { id: "2", to: { name: "Complete" } },
      ],
    });
    const doTransition = vi.fn().mockResolvedValueOnce({});

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issues: { getTransitions, doTransition },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    const config: JiraProviderConfig = {
      ...baseConfig(),
      doneStatusName: "Complete",
    };
    await provider.updateState("TEST-123", "closed", config);

    expect(doTransition).toHaveBeenCalledWith({
      issueIdOrKey: "TEST-123",
      transition: { id: "2" },
    });
  });

  it("gracefully handles when target transition is not available", async () => {
    const getTransitions = vi.fn().mockResolvedValueOnce({
      transitions: [{ id: "1", to: { name: "In Progress" } }],
    });
    const doTransition = vi.fn();

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issues: { getTransitions, doTransition },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    await provider.updateState("TEST-123", "closed", baseConfig());

    expect(getTransitions).toHaveBeenCalled();
    expect(doTransition).not.toHaveBeenCalled();
  });
});
