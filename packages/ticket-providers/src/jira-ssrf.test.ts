import { describe, it, expect, vi, beforeEach } from "vitest";
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
  const common = () => ({
    issueComments: {
      addComment: vi.fn().mockResolvedValue({}),
      getComments: vi.fn().mockResolvedValue({ comments: [] }),
    },
    issues: {
      getTransitions: vi.fn().mockResolvedValue({ transitions: [] }),
      doTransition: vi.fn().mockResolvedValue({}),
    },
    serverInfo: { getServerInfo: vi.fn().mockResolvedValue({ version: "9.12.0" }) },
    myself: { getCurrentUser: vi.fn().mockResolvedValue({ displayName: "Optio Bot" }) },
  });
  return {
    Version3Client: vi.fn().mockImplementation(() => ({
      ...common(),
      issueSearch: {
        searchForIssuesUsingJqlEnhancedSearch: vi.fn().mockResolvedValue({ issues: [] }),
      },
    })),
    Version2Client: vi.fn().mockImplementation(() => ({
      ...common(),
      issueSearch: {
        searchForIssuesUsingJql: vi.fn().mockResolvedValue({ issues: [], total: 0 }),
      },
    })),
  };
});

import { Version2Client, Version3Client } from "jira.js";
import { assertSsrfSafe, SsrfError } from "@optio/shared/ssrf";

const mockAssertSsrfSafe = assertSsrfSafe as ReturnType<typeof vi.fn>;

function baseConfig(): JiraProviderConfig {
  return {
    baseUrl: "https://test.atlassian.net",
    email: "test@example.com",
    apiToken: "test-token",
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

beforeEach(() => {
  mockAssertSsrfSafe.mockReset();
  mockAssertSsrfSafe.mockResolvedValue(undefined);
  vi.mocked(Version2Client).mockClear();
  vi.mocked(Version3Client).mockClear();
});

describe("JiraTicketProvider SSRF protection", () => {
  it("calls assertSsrfSafe with baseUrl before fetching tickets", async () => {
    const provider = new JiraTicketProvider();
    await provider.fetchActionableTickets(baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalledWith("https://test.atlassian.net");
  });

  it("throws SsrfError when baseUrl resolves to private address", async () => {
    mockAssertSsrfSafe.mockRejectedValueOnce(
      new SsrfError("DNS resolved evil.example.com to private address 169.254.169.254"),
    );

    const provider = new JiraTicketProvider();
    const config: JiraProviderConfig = {
      ...baseConfig(),
      baseUrl: "http://evil.example.com",
    };

    await expect(provider.fetchActionableTickets(config)).rejects.toThrow(SsrfError);
  });

  it("calls assertSsrfSafe before fetching comments", async () => {
    const provider = new JiraTicketProvider();
    await provider.fetchTicketComments("TEST-123", baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalledWith("https://test.atlassian.net");
  });

  it("calls assertSsrfSafe before adding a comment", async () => {
    const provider = new JiraTicketProvider();
    await provider.addComment("TEST-123", "comment", baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalledWith("https://test.atlassian.net");
  });

  it("calls assertSsrfSafe before updating state", async () => {
    const provider = new JiraTicketProvider();
    await provider.updateState("TEST-123", "closed", baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalledWith("https://test.atlassian.net");
  });
});

// A self-hosted server is the case the guard exists for: the URL is a
// private host unless the deployment lists it in OPTIO_OUTBOUND_ALLOWED_HOSTS.
describe("JiraTicketProvider SSRF protection on Jira Server / Data Center", () => {
  it.each([
    ["fetchActionableTickets", (p: JiraTicketProvider) => p.fetchActionableTickets(serverConfig())],
    [
      "fetchTicketComments",
      (p: JiraTicketProvider) => p.fetchTicketComments("OPS-1", serverConfig()),
    ],
    ["addComment", (p: JiraTicketProvider) => p.addComment("OPS-1", "comment", serverConfig())],
    ["updateState", (p: JiraTicketProvider) => p.updateState("OPS-1", "closed", serverConfig())],
    ["testConnection", (p: JiraTicketProvider) => p.testConnection(serverConfig())],
  ])("vets the base URL (context path included) before %s", async (_name, call) => {
    await call(new JiraTicketProvider());

    expect(mockAssertSsrfSafe).toHaveBeenCalledWith("https://jira.example.com/jira");
    expect(Version2Client).toHaveBeenCalledTimes(1);
    expect(Version3Client).not.toHaveBeenCalled();
  });

  it.each([
    ["fetchActionableTickets", (p: JiraTicketProvider) => p.fetchActionableTickets(serverConfig())],
    [
      "fetchTicketComments",
      (p: JiraTicketProvider) => p.fetchTicketComments("OPS-1", serverConfig()),
    ],
    ["addComment", (p: JiraTicketProvider) => p.addComment("OPS-1", "comment", serverConfig())],
    ["updateState", (p: JiraTicketProvider) => p.updateState("OPS-1", "closed", serverConfig())],
  ])("throws SsrfError from %s and never builds a client", async (_name, call) => {
    mockAssertSsrfSafe.mockRejectedValueOnce(
      new SsrfError("blocked: jira.example.com resolves to a private address (10.0.0.5)"),
    );

    await expect(call(new JiraTicketProvider())).rejects.toThrow(SsrfError);
    expect(Version2Client).not.toHaveBeenCalled();
  });

  it("testConnection reports a blocked URL as a failed test", async () => {
    mockAssertSsrfSafe.mockRejectedValueOnce(
      new SsrfError(
        "blocked: jira.example.com resolves to a private address (10.0.0.5); set OPTIO_OUTBOUND_ALLOW_PRIVATE=true or list it in OPTIO_OUTBOUND_ALLOWED_HOSTS",
      ),
    );

    const result = await new JiraTicketProvider().testConnection(serverConfig());

    expect(result.ok).toBe(false);
    expect(result.error).toContain("OPTIO_OUTBOUND_ALLOWED_HOSTS");
    expect(Version2Client).not.toHaveBeenCalled();
  });
});
