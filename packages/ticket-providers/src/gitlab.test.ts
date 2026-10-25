import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitLabTicketProvider } from "./gitlab.js";
import type { GitLabProviderConfig } from "./gitlab.js";

vi.mock("@optio/shared/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@optio/shared/ssrf")>();
  return {
    ...actual,
    assertSsrfSafe: vi.fn(),
  };
});

import { assertSsrfSafe, SsrfError } from "@optio/shared/ssrf";

const mockAssertSsrfSafe = assertSsrfSafe as ReturnType<typeof vi.fn>;

function baseConfig(): GitLabProviderConfig {
  return {
    token: "glpat-test-token",
    projectPath: "group/project",
    host: "gitlab.com",
  };
}

beforeEach(() => {
  mockAssertSsrfSafe.mockReset();
  mockAssertSsrfSafe.mockResolvedValue(undefined);
  vi.restoreAllMocks();
});

describe("GitLabTicketProvider sign-in", () => {
  it("sends the token as Authorization: Bearer, which takes every GitLab token kind", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "x-total-pages": "1" },
      }),
    );

    await new GitLabTicketProvider().fetchActionableTickets(baseConfig());

    const headers = new Headers(fetchSpy.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer glpat-test-token");
    expect(headers.get("private-token")).toBeNull();
    fetchSpy.mockRestore();
  });
});

describe("GitLabTicketProvider SSRF protection", () => {
  it("calls assertSsrfSafe before fetching issues", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "x-total-pages": "1" },
      }),
    );

    const provider = new GitLabTicketProvider();
    await provider.fetchActionableTickets(baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalled();
    const calledUrl = mockAssertSsrfSafe.mock.calls[0][0] as string;
    expect(calledUrl).toContain("https://gitlab.com/api/v4");
    fetchSpy.mockRestore();
  });

  it("throws SsrfError when host resolves to private address", async () => {
    mockAssertSsrfSafe.mockRejectedValueOnce(
      new SsrfError("DNS resolved evil.example.com to private address 169.254.169.254"),
    );

    const provider = new GitLabTicketProvider();
    const config: GitLabProviderConfig = {
      ...baseConfig(),
      host: "evil.example.com",
    };

    await expect(provider.fetchActionableTickets(config)).rejects.toThrow(SsrfError);
  });

  it("calls assertSsrfSafe before adding a comment", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 201 }));

    const provider = new GitLabTicketProvider();
    await provider.addComment("1", "test comment", baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("calls assertSsrfSafe before fetching comments", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));

    const provider = new GitLabTicketProvider();
    await provider.fetchTicketComments("1", baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("calls assertSsrfSafe before updating state", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }));

    const provider = new GitLabTicketProvider();
    await provider.updateState("1", "closed", baseConfig());

    expect(mockAssertSsrfSafe).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("uses redirect: 'error' on all fetch calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "x-total-pages": "1" },
      }),
    );

    const provider = new GitLabTicketProvider();
    await provider.fetchActionableTickets(baseConfig());

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "error" }),
    );
    fetchSpy.mockRestore();
  });
});

describe("GitLabTicketProvider basic functionality", () => {
  it("fetches and transforms GitLab issues", async () => {
    const mockIssue = {
      iid: 42,
      title: "Test Issue",
      description: "Test description",
      web_url: "https://gitlab.com/group/project/-/issues/42",
      labels: ["optio"],
      assignee: { username: "testuser" },
      created_at: "2025-01-01T00:00:00Z",
      updated_at: "2025-01-02T00:00:00Z",
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify([mockIssue]), {
        status: 200,
        headers: { "x-total-pages": "1" },
      }),
    );

    const provider = new GitLabTicketProvider();
    const tickets = await provider.fetchActionableTickets(baseConfig());

    expect(tickets).toHaveLength(1);
    expect(tickets[0].externalId).toBe("42");
    expect(tickets[0].title).toBe("Test Issue");
    expect(tickets[0].source).toBe("gitlab");
  });
});

describe("GitLabTicketProvider groups and self-managed hosts", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "x-total-pages": "1" } });

  it("lists a group's issues, each with its own project", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json([
        {
          iid: 3,
          title: "In a subgroup",
          web_url: "https://gitlab.corp:8443/platform/tools/app/-/issues/3",
          references: { full: "platform/tools/app#3" },
          labels: ["optio"],
        },
        {
          iid: 9,
          title: "No references",
          web_url: "https://gitlab.corp:8443/platform/web/-/issues/9",
          labels: ["optio"],
        },
      ]),
    );

    const tickets = await new GitLabTicketProvider().fetchActionableTickets({
      token: "t",
      groupPath: "platform",
      host: "https://gitlab.corp:8443/",
    });

    expect(fetchSpy.mock.calls[0][0]).toMatch(
      /^https:\/\/gitlab\.corp:8443\/api\/v4\/groups\/platform\/issues\?/,
    );
    expect(tickets.map((t) => [t.externalId, t.repo])).toEqual([
      ["3", "platform/tools/app"],
      ["9", "platform/web"],
    ]);
  });

  it("keeps a path prefix in the API base", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json([]));
    await new GitLabTicketProvider().fetchActionableTickets({
      token: "t",
      projectPath: "g/p",
      host: "example.com/gitlab",
    });
    expect(fetchSpy.mock.calls[0][0]).toMatch(
      /^https:\/\/corp\.example\/gitlab\/api\/v4\/projects\/g%2Fp\/issues\?/,
    );
  });

  it("needs a project or a group", async () => {
    await expect(
      new GitLabTicketProvider().fetchActionableTickets({ token: "t", host: "gitlab.com" }),
    ).rejects.toThrow(/projectPath or groupPath/);
  });

  it("tests the connection by reading the project", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ path_with_namespace: "group/project" }));
    const result = await new GitLabTicketProvider().testConnection(baseConfig());
    expect(result).toEqual({ ok: true, serverTitle: "group/project", deploymentType: "Cloud" });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://gitlab.com/api/v4/projects/group%2Fproject");
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({
      headers: expect.objectContaining({ "PRIVATE-TOKEN": "glpat-test-token" }),
      redirect: "error",
    });
  });

  it("reports a token GitLab refuses or a project it can't see", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ message: "401 Unauthorized" }, 401))
      .mockResolvedValueOnce(json({ message: "404 Group Not Found" }, 404));
    const provider = new GitLabTicketProvider();
    expect(await provider.testConnection(baseConfig())).toEqual({
      ok: false,
      error: "GitLab refused the token (401)",
    });
    expect(
      await provider.testConnection({ token: "t", groupPath: "missing", host: "gitlab.corp" }),
    ).toEqual({ ok: false, error: "The token can't see that group (404)" });
    expect(await provider.testConnection({ host: "gitlab.com" })).toMatchObject({ ok: false });
  });
});
