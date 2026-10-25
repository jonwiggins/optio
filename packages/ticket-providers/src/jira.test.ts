import { describe, it, expect, vi, beforeEach } from "vitest";
import { Agent as HttpsAgent } from "node:https";
import { JiraTicketProvider, resolveJiraAuth, jiraConfigProblem } from "./jira.js";
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
    Version2Client: vi.fn().mockImplementation(() => ({
      issueSearch: {
        searchForIssuesUsingJql: vi.fn(),
      },
      issueComments: {
        addComment: vi.fn(),
        getComments: vi.fn(),
      },
      issues: {
        getTransitions: vi.fn(),
        doTransition: vi.fn(),
      },
    })),
  };
});

import { Version2Client, Version3Client } from "jira.js";
import { assertSsrfSafe } from "@optio/shared/ssrf";

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

// ── Jira Server / Data Center ───────────────────────────────────────────────

/** A v2 search hit: string description, and a Server may leave fields out. */
function makeServerIssue(key: string, num: number, extra: Record<string, unknown> = {}) {
  return {
    key,
    fields: {
      summary: `Server issue ${num}`,
      description: `Plain description ${num}`,
      status: { name: "Open" },
      labels: ["optio"],
      project: { key: "OPS" },
      ...extra,
    },
  };
}

function serverConfig(): JiraProviderConfig {
  return {
    baseUrl: "https://jira.example.com/jira",
    deployment: "server",
    authType: "pat",
    apiToken: "pat-token",
  };
}

/** Installs a Version2Client whose methods are the given mocks; returns them. */
function mockServerClient(members: Record<string, unknown>) {
  vi.mocked(Version2Client).mockImplementation(
    () => members as unknown as InstanceType<typeof Version2Client>,
  );
  return members;
}

describe("Jira deployment and auth resolution", () => {
  it("defaults to cloud + basic when an email is set and no authType", () => {
    expect(resolveJiraAuth({ email: "a@b.example" })).toEqual({
      deployment: "cloud",
      authType: "basic",
    });
  });

  it("defaults to server + pat without an email", () => {
    expect(resolveJiraAuth({})).toEqual({ deployment: "server", authType: "pat" });
  });

  it("treats an explicit authType as a server unless deployment says cloud", () => {
    expect(resolveJiraAuth({ email: "a@b.example", authType: "pat" })).toEqual({
      deployment: "server",
      authType: "pat",
    });
    expect(resolveJiraAuth({ deployment: "server", authType: "basic" })).toEqual({
      deployment: "server",
      authType: "basic",
    });
    expect(resolveJiraAuth({ deployment: "cloud" })).toEqual({
      deployment: "cloud",
      authType: "basic",
    });
  });
});

describe("Jira config validation", () => {
  it("names a missing baseUrl", () => {
    expect(jiraConfigProblem({ email: "a@b.example", apiToken: "t" })).toMatchObject({
      field: "baseUrl",
    });
  });

  it("requires email and apiToken on cloud", () => {
    expect(
      jiraConfigProblem({ baseUrl: "https://x.atlassian.net", deployment: "cloud" }),
    ).toMatchObject({
      field: "email",
      message: expect.stringContaining("email"),
    });
    expect(
      jiraConfigProblem({ baseUrl: "https://x.atlassian.net", email: "a@b.example" }),
    ).toMatchObject({ field: "apiToken" });
  });

  it("rejects a PAT on cloud", () => {
    expect(
      jiraConfigProblem({
        baseUrl: "https://x.atlassian.net",
        deployment: "cloud",
        authType: "pat",
        email: "a@b.example",
        apiToken: "t",
      }),
    ).toMatchObject({ field: "authType", message: expect.stringContaining('"pat"') });
  });

  it("requires only baseUrl and apiToken for a server PAT", () => {
    expect(jiraConfigProblem({ baseUrl: "https://jira.example.com" })).toMatchObject({
      field: "apiToken",
      message: expect.stringContaining("personal access token"),
    });
    expect(jiraConfigProblem({ baseUrl: "https://jira.example.com", apiToken: "pat" })).toBeNull();
  });

  it("requires username and apiToken for server basic auth", () => {
    const base = {
      baseUrl: "https://jira.example.com",
      deployment: "server" as const,
      authType: "basic" as const,
    };
    expect(jiraConfigProblem({ ...base, apiToken: "pw" })).toMatchObject({ field: "username" });
    expect(jiraConfigProblem({ ...base, username: "svc-optio" })).toMatchObject({
      field: "apiToken",
      message: expect.stringContaining("password"),
    });
    expect(jiraConfigProblem({ ...base, username: "svc-optio", apiToken: "pw" })).toBeNull();
  });

  it("throws the named problem from every provider method", async () => {
    const provider = new JiraTicketProvider();
    const config = {
      baseUrl: "https://jira.example.com",
      deployment: "server",
      authType: "basic",
      apiToken: "pw",
    };
    await expect(provider.fetchActionableTickets(config)).rejects.toThrow(/username/);
    await expect(provider.fetchTicketComments("OPS-1", config)).rejects.toThrow(/username/);
    await expect(provider.addComment("OPS-1", "x", config)).rejects.toThrow(/username/);
    await expect(provider.updateState("OPS-1", "closed", config)).rejects.toThrow(/username/);
  });
});

describe("JiraTicketProvider on Jira Server / Data Center", () => {
  beforeEach(() => {
    vi.mocked(Version2Client).mockClear();
    vi.mocked(Version3Client).mockClear();
  });

  it("uses the v2 client with the PAT as a bearer token", async () => {
    const { issueSearch } = mockServerClient({
      issueSearch: {
        searchForIssuesUsingJql: vi.fn().mockResolvedValueOnce({ issues: [], total: 0 }),
      },
    }) as any;

    await new JiraTicketProvider().fetchActionableTickets(serverConfig());

    expect(Version3Client).not.toHaveBeenCalled();
    expect(Version2Client).toHaveBeenCalledTimes(1);
    const options = vi.mocked(Version2Client).mock.calls[0][0];
    expect(options).toEqual({
      host: "https://jira.example.com/jira",
      // jira.js sends an oauth2 access token as `Authorization: Bearer <token>`
      authentication: { oauth2: { accessToken: "pat-token" } },
    });
    expect(options).not.toHaveProperty("baseRequestConfig");
    expect(issueSearch.searchForIssuesUsingJql).toHaveBeenCalledTimes(1);
  });

  it("sends username + password as basic auth on a server", async () => {
    mockServerClient({
      issueSearch: {
        searchForIssuesUsingJql: vi.fn().mockResolvedValueOnce({ issues: [], total: 0 }),
      },
    });

    await new JiraTicketProvider().fetchActionableTickets({
      baseUrl: "https://jira.example.com",
      deployment: "server",
      authType: "basic",
      username: "svc-optio",
      apiToken: "hunter2",
    });

    expect(vi.mocked(Version2Client).mock.calls[0][0]).toMatchObject({
      authentication: { basic: { email: "svc-optio", apiToken: "hunter2" } },
    });
  });

  it("infers a server from a config with a token and no email", async () => {
    mockServerClient({
      issueSearch: {
        searchForIssuesUsingJql: vi.fn().mockResolvedValueOnce({ issues: [], total: 0 }),
      },
    });

    await new JiraTicketProvider().fetchActionableTickets({
      baseUrl: "https://jira.example.com",
      apiToken: "pat-token",
    });

    expect(Version2Client).toHaveBeenCalledTimes(1);
    expect(Version3Client).not.toHaveBeenCalled();
  });

  it("keeps cloud on the v3 client with no baseRequestConfig", async () => {
    const searchForIssuesUsingJqlEnhancedSearch = vi.fn().mockResolvedValueOnce({ issues: [] });
    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJqlEnhancedSearch },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    await new JiraTicketProvider().fetchActionableTickets(baseConfig());

    expect(Version2Client).not.toHaveBeenCalled();
    expect(vi.mocked(Version3Client).mock.calls[0][0]).toEqual({
      host: "https://test.atlassian.net",
      authentication: { basic: { email: "test@example.com", apiToken: "test-token" } },
    });
  });

  it("passes caPem to axios as an https agent", async () => {
    mockServerClient({
      issueSearch: {
        searchForIssuesUsingJql: vi.fn().mockResolvedValueOnce({ issues: [], total: 0 }),
      },
    });

    await new JiraTicketProvider().fetchActionableTickets({
      ...serverConfig(),
      caPem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    });

    const options = vi.mocked(Version2Client).mock.calls[0][0] as any;
    expect(options.baseRequestConfig.httpsAgent).toBeInstanceOf(HttpsAgent);
  });

  it("pages a v2 search by startAt until total is reached", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeServerIssue(`OPS-${i + 1}`, i + 1));
    const page2 = Array.from({ length: 30 }, (_, i) => makeServerIssue(`OPS-${i + 101}`, i + 101));
    const searchForIssuesUsingJql = vi
      .fn()
      .mockResolvedValueOnce({ issues: page1, startAt: 0, maxResults: 100, total: 130 })
      .mockResolvedValueOnce({ issues: page2, startAt: 100, maxResults: 100, total: 130 });
    mockServerClient({ issueSearch: { searchForIssuesUsingJql } });

    const tickets = await new JiraTicketProvider().fetchActionableTickets(serverConfig());

    expect(tickets).toHaveLength(130);
    expect(searchForIssuesUsingJql).toHaveBeenCalledTimes(2);
    expect(searchForIssuesUsingJql).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ startAt: 0, maxResults: 100 }),
    );
    expect(searchForIssuesUsingJql).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startAt: 100, maxResults: 100 }),
    );
    expect(searchForIssuesUsingJql.mock.calls[0][0].fields).toContain("labels");
  });

  it("stops a v2 search at maxPages", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => makeServerIssue(`OPS-${i + 1}`, i + 1));
    const searchForIssuesUsingJql = vi
      .fn()
      .mockResolvedValue({ issues: fullPage, maxResults: 100, total: 1000 });
    mockServerClient({ issueSearch: { searchForIssuesUsingJql } });

    const tickets = await new JiraTicketProvider().fetchActionableTickets({
      ...serverConfig(),
      maxPages: 2,
    });

    expect(searchForIssuesUsingJql).toHaveBeenCalledTimes(2);
    expect(tickets).toHaveLength(200);
  });

  it("treats a short page as the last one when total is missing", async () => {
    const searchForIssuesUsingJql = vi
      .fn()
      .mockResolvedValueOnce({ issues: [makeServerIssue("OPS-1", 1)] });
    mockServerClient({ issueSearch: { searchForIssuesUsingJql } });

    const tickets = await new JiraTicketProvider().fetchActionableTickets(serverConfig());

    expect(tickets).toHaveLength(1);
    expect(searchForIssuesUsingJql).toHaveBeenCalledTimes(1);
  });

  it("excludes the Done status category and ANDs the extra jql on a server", async () => {
    const searchForIssuesUsingJql = vi.fn().mockResolvedValueOnce({ issues: [], total: 0 });
    mockServerClient({ issueSearch: { searchForIssuesUsingJql } });

    await new JiraTicketProvider().fetchActionableTickets({
      ...serverConfig(),
      projectKey: "OPS",
      jql: " issuetype = Bug ",
    });

    expect(searchForIssuesUsingJql.mock.calls[0][0].jql).toBe(
      'labels = "optio" AND statusCategory != Done AND project = "OPS" AND (issuetype = Bug)',
    );
  });

  it("ANDs the extra jql on cloud without touching its status clause", async () => {
    const searchForIssuesUsingJqlEnhancedSearch = vi.fn().mockResolvedValueOnce({ issues: [] });
    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          issueSearch: { searchForIssuesUsingJqlEnhancedSearch },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    await new JiraTicketProvider().fetchActionableTickets({
      ...baseConfig(),
      jql: "issuetype = Bug",
    });

    expect(searchForIssuesUsingJqlEnhancedSearch.mock.calls[0][0].jql).toBe(
      'labels = "optio" AND status != Done AND status != Closed AND (issuetype = Bug)',
    );
  });

  it("builds ticket URLs under the context path and keeps string descriptions", async () => {
    const issue = makeServerIssue("OPS-7", 7, {
      assignee: { name: "jdoe", displayName: "Jane Doe" },
      priority: { name: "High" },
      labels: ["optio", "repo:acme/backend"],
    });
    mockServerClient({
      issueSearch: {
        searchForIssuesUsingJql: vi.fn().mockResolvedValueOnce({ issues: [issue], total: 1 }),
      },
    });

    const tickets = await new JiraTicketProvider().fetchActionableTickets({
      ...serverConfig(),
      baseUrl: "https://jira.example.com/jira/",
    });

    expect(vi.mocked(Version2Client).mock.calls[0][0].host).toBe("https://jira.example.com/jira");
    expect(tickets[0]).toMatchObject({
      externalId: "OPS-7",
      title: "Server issue 7",
      body: "Plain description 7",
      url: "https://jira.example.com/jira/browse/OPS-7",
      assignee: "Jane Doe",
      repo: "acme/backend",
      metadata: { status: "Open", priority: "High", projectKey: "OPS" },
    });
  });

  it("copes with a server issue that has no labels, assignee or priority", async () => {
    const issue = makeServerIssue("OPS-8", 8);
    delete (issue.fields as any).labels;
    mockServerClient({
      issueSearch: {
        searchForIssuesUsingJql: vi.fn().mockResolvedValueOnce({ issues: [issue], total: 1 }),
      },
    });

    const [ticket] = await new JiraTicketProvider().fetchActionableTickets(serverConfig());

    expect(ticket.labels).toEqual([]);
    expect(ticket.repo).toBeUndefined();
    expect(ticket.assignee).toBeUndefined();
    expect(ticket.metadata.priority).toBeUndefined();
  });

  it("reads v2 comments whose body is a string", async () => {
    const getComments = vi.fn().mockResolvedValueOnce({
      comments: [
        {
          author: { displayName: "Jane Doe" },
          body: "h2. Plain *wiki* body",
          created: "2026-01-01T00:00:00Z",
        },
        { body: "no author" },
      ],
    });
    mockServerClient({ issueComments: { getComments } });

    const comments = await new JiraTicketProvider().fetchTicketComments("OPS-1", serverConfig());

    expect(getComments).toHaveBeenCalledWith({
      issueIdOrKey: "OPS-1",
      maxResults: 30,
      orderBy: "-created",
    });
    expect(comments).toEqual([
      { author: "Jane Doe", body: "h2. Plain *wiki* body", createdAt: "2026-01-01T00:00:00Z" },
      { author: "unknown", body: "no author", createdAt: "" },
    ]);
  });

  it("adds a plain-string comment through the v2 client", async () => {
    const addComment = vi.fn().mockResolvedValueOnce({});
    mockServerClient({ issueComments: { addComment } });

    await new JiraTicketProvider().addComment("OPS-1", "Optio is on it", serverConfig());

    // jira.js' v2 wrapper serialises `comment` as the request's `body` string.
    expect(addComment).toHaveBeenCalledWith({ issueIdOrKey: "OPS-1", comment: "Optio is on it" });
    expect(Version3Client).not.toHaveBeenCalled();
  });

  it("transitions through the v2 client using the configured done status", async () => {
    const getTransitions = vi.fn().mockResolvedValueOnce({
      transitions: [
        { id: "11", to: { name: "In Progress" } },
        { id: "31", to: { name: "Resolved" } },
      ],
    });
    const doTransition = vi.fn().mockResolvedValueOnce({});
    mockServerClient({ issues: { getTransitions, doTransition } });

    await new JiraTicketProvider().updateState("OPS-1", "closed", {
      ...serverConfig(),
      doneStatusName: "Resolved",
    });

    expect(doTransition).toHaveBeenCalledWith({ issueIdOrKey: "OPS-1", transition: { id: "31" } });
  });
});

describe("JiraTicketProvider testConnection", () => {
  beforeEach(() => {
    vi.mocked(Version2Client).mockClear();
    vi.mocked(Version3Client).mockClear();
    vi.mocked(assertSsrfSafe).mockReset();
  });

  it("reports the server and the account the PAT belongs to", async () => {
    const getServerInfo = vi.fn().mockResolvedValueOnce({
      serverTitle: "Corp Jira",
      version: "9.12.4",
      deploymentType: "Server",
    });
    const getCurrentUser = vi
      .fn()
      .mockResolvedValueOnce({ name: "svc-optio", displayName: "Optio Bot" });
    mockServerClient({ serverInfo: { getServerInfo }, myself: { getCurrentUser } });

    const result = await new JiraTicketProvider().testConnection(serverConfig());

    expect(result).toEqual({
      ok: true,
      serverTitle: "Corp Jira",
      version: "9.12.4",
      deploymentType: "Server",
      user: "Optio Bot",
    });
    expect(assertSsrfSafe).toHaveBeenCalledWith("https://jira.example.com/jira");
  });

  it("works on cloud through the v3 client", async () => {
    vi.mocked(Version3Client).mockImplementation(
      () =>
        ({
          serverInfo: {
            getServerInfo: vi
              .fn()
              .mockResolvedValue({ deploymentType: "Cloud", version: "1001.0.0" }),
          },
          myself: { getCurrentUser: vi.fn().mockResolvedValue({ displayName: "Cloud User" }) },
        }) as unknown as InstanceType<typeof Version3Client>,
    );

    const result = await new JiraTicketProvider().testConnection(baseConfig());

    expect(result).toMatchObject({ ok: true, deploymentType: "Cloud", user: "Cloud User" });
    expect(Version2Client).not.toHaveBeenCalled();
  });

  it("returns the named config problem without building a client", async () => {
    const result = await new JiraTicketProvider().testConnection({
      baseUrl: "https://jira.example.com",
      deployment: "server",
      authType: "basic",
      apiToken: "pw",
    });

    expect(result).toEqual({ ok: false, error: expect.stringContaining("username") });
    expect(Version2Client).not.toHaveBeenCalled();
  });

  it("reports a blocked URL instead of throwing", async () => {
    vi.mocked(assertSsrfSafe).mockRejectedValueOnce(
      new Error("blocked: jira.example.com resolves to a private address (10.0.0.5)"),
    );

    const result = await new JiraTicketProvider().testConnection(serverConfig());

    expect(result).toEqual({ ok: false, error: expect.stringContaining("private address") });
    expect(Version2Client).not.toHaveBeenCalled();
  });

  it("explains a 401 without echoing the response", async () => {
    const err = Object.assign(new Error("Request failed with status code 401"), {
      status: 401,
      statusText: "Unauthorized",
      response: { data: "<html>secret-ish page</html>" },
    });
    mockServerClient({
      serverInfo: { getServerInfo: vi.fn().mockResolvedValue({ version: "9.4.0" }) },
      myself: { getCurrentUser: vi.fn().mockRejectedValue(err) },
    });

    const result = await new JiraTicketProvider().testConnection(serverConfig());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/401/);
    expect(result.error).not.toContain("secret-ish");
  });

  it("points at the CA for a certificate the API does not trust", async () => {
    const err = Object.assign(new Error("unable to verify the first certificate"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    mockServerClient({
      serverInfo: { getServerInfo: vi.fn().mockRejectedValue(err) },
      myself: { getCurrentUser: vi.fn() },
    });

    const result = await new JiraTicketProvider().testConnection(serverConfig());

    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/UNABLE_TO_VERIFY_LEAF_SIGNATURE.*caPem.*NODE_EXTRA_CA_CERTS/),
    });
  });

  it("names a 404 as a base URL / context path problem and keeps socket codes", async () => {
    const notFound = Object.assign(new Error("Request failed with status code 404"), {
      status: 404,
    });
    mockServerClient({
      serverInfo: { getServerInfo: vi.fn().mockRejectedValue(notFound) },
      myself: { getCurrentUser: vi.fn() },
    });
    expect((await new JiraTicketProvider().testConnection(serverConfig())).error).toMatch(
      /404.*context path/,
    );

    const refused = Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:8080"), {
      code: "ECONNREFUSED",
    });
    mockServerClient({
      serverInfo: { getServerInfo: vi.fn().mockRejectedValue(refused) },
      myself: { getCurrentUser: vi.fn() },
    });
    expect((await new JiraTicketProvider().testConnection(serverConfig())).error).toBe(
      "ECONNREFUSED: connect ECONNREFUSED 10.1.2.3:8080",
    );
  });
});
