import { describe, it, expect, vi } from "vitest";
import { JiraTicketProvider } from "./jira.js";
import type { JiraProviderConfig } from "./jira.js";

vi.mock("@optio/shared/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@optio/shared/ssrf")>();
  return {
    ...actual,
    assertSsrfSafe: vi.fn(),
  };
});

vi.mock("jira.js", () => {
  return {
    Version3Client: vi.fn().mockImplementation(() => ({
      issueSearch: {
        searchForIssuesUsingJqlEnhancedSearch: vi.fn(),
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
    const searchForIssuesUsingJqlEnhancedSearch = vi.fn().mockResolvedValueOnce({
      issues,
    });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJqlEnhancedSearch },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(3);
    expect(searchForIssuesUsingJqlEnhancedSearch).toHaveBeenCalledTimes(1);
    expect(searchForIssuesUsingJqlEnhancedSearch).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 100 }),
    );
  });

  it("paginates across multiple pages using nextPageToken", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeJiraIssue(`TEST-${i + 1}`, i + 1));
    const page2 = Array.from({ length: 30 }, (_, i) => makeJiraIssue(`TEST-${i + 101}`, i + 101));

    const searchForIssuesUsingJqlEnhancedSearch = vi
      .fn()
      .mockResolvedValueOnce({
        issues: page1,
        nextPageToken: "page2token",
      })
      .mockResolvedValueOnce({
        issues: page2,
      });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJqlEnhancedSearch },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(130);
    expect(searchForIssuesUsingJqlEnhancedSearch).toHaveBeenCalledTimes(2);
    expect(searchForIssuesUsingJqlEnhancedSearch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ nextPageToken: undefined }),
    );
    expect(searchForIssuesUsingJqlEnhancedSearch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ nextPageToken: "page2token" }),
    );
  });

  it("respects maxPages limit", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => makeJiraIssue(`TEST-${i + 1}`, i + 1));
    const searchForIssuesUsingJqlEnhancedSearch = vi.fn().mockResolvedValue({
      issues: fullPage,
      nextPageToken: "nexttoken",
    });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJqlEnhancedSearch },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    const config: JiraProviderConfig = { ...baseConfig(), maxPages: 2 };
    const tickets = await provider.fetchActionableTickets(config);

    expect(searchForIssuesUsingJqlEnhancedSearch).toHaveBeenCalledTimes(2);
    expect(tickets).toHaveLength(200);
  });

  it("returns empty array when no issues match", async () => {
    const searchForIssuesUsingJqlEnhancedSearch = vi.fn().mockResolvedValueOnce({
      issues: [],
    });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJqlEnhancedSearch },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(0);
    expect(searchForIssuesUsingJqlEnhancedSearch).toHaveBeenCalledTimes(1);
  });

  it("passes project filter when projectKey is configured", async () => {
    const searchForIssuesUsingJqlEnhancedSearch = vi.fn().mockResolvedValueOnce({
      issues: [makeJiraIssue("DEV-1", 1)],
    });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJqlEnhancedSearch },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    const config: JiraProviderConfig = {
      ...baseConfig(),
      projectKey: "DEV",
    };
    await provider.fetchActionableTickets(config);

    expect(searchForIssuesUsingJqlEnhancedSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        jql: expect.stringContaining('project = "DEV"'),
      }),
    );
  });

  it("transforms JIRA issue fields to Ticket format correctly", async () => {
    const issue = makeJiraIssue("TEST-123", 1);
    const searchForIssuesUsingJqlEnhancedSearch = vi.fn().mockResolvedValueOnce({
      issues: [issue],
    });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJqlEnhancedSearch },
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
    expect(ticket.repo).toBeUndefined();
    expect(ticket.metadata).toMatchObject({
      key: "TEST-123",
      status: "To Do",
      priority: "Medium",
      projectKey: "TEST",
    });
  });

  it("includes attachments when present", async () => {
    const issue = makeJiraIssue("TEST-123", 1, true);
    const searchForIssuesUsingJqlEnhancedSearch = vi.fn().mockResolvedValueOnce({
      issues: [issue],
    });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJqlEnhancedSearch },
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

  it("trims whitespace from repo: label extraction", async () => {
    const issue = makeJiraIssue("TEST-1", 1);
    // Simulate a label like "repo: acme/backend" (space after colon)
    issue.fields.labels = ["optio", "repo: acme/backend"];
    const searchForIssuesUsingJqlEnhancedSearch = vi.fn().mockResolvedValueOnce({
      issues: [issue],
    });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJqlEnhancedSearch },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const provider = new JiraTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets[0].repo).toBe("acme/backend");
  });

  it("converts ADF description to plaintext", async () => {
    const issue = makeJiraIssue("TEST-123", 1);
    const searchForIssuesUsingJqlEnhancedSearch = vi.fn().mockResolvedValueOnce({
      issues: [issue],
    });

    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJqlEnhancedSearch },
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
