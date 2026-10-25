import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@optio/shared/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@optio/shared/ssrf")>();
  return { ...actual, assertSsrfSafe: vi.fn() };
});

/** One fake client per API, shared by every `new` so a test can program it. */
const fake = () => ({
  myself: { getCurrentUser: vi.fn() },
  issueComments: { getComments: vi.fn(), addComment: vi.fn() },
  issueRemoteLinks: { createOrUpdateRemoteIssueLink: vi.fn() },
  projects: { getAllStatuses: vi.fn() },
  workflowStatuses: { getStatuses: vi.fn() },
  issues: { getIssue: vi.fn(), getTransitions: vi.fn(), doTransition: vi.fn() },
});
const server = fake();
const cloud = fake();

vi.mock("jira.js", () => ({
  Version2Client: vi.fn().mockImplementation(() => server),
  Version3Client: vi.fn().mockImplementation(() => cloud),
}));

import {
  jiraCommentBody,
  jiraIssueTransitions,
  jiraListComments,
  jiraMoveToStatus,
  jiraPostComment,
  jiraStatuses,
  jiraUpsertRemoteLink,
  jiraWhoAmI,
  parseJiraTime,
  sameJiraAccount,
} from "./jira-round-trip.js";
import { assertSsrfSafe } from "@optio/shared/ssrf";

const SERVER = {
  baseUrl: "https://jira.example.test/",
  deployment: "server",
  authType: "pat",
  apiToken: "pat",
};
const CLOUD = { baseUrl: "https://acme.atlassian.net", email: "bot@acme.test", apiToken: "t" };

beforeEach(() => {
  for (const client of [server, cloud])
    for (const group of Object.values(client))
      for (const fn of Object.values(group)) (fn as ReturnType<typeof vi.fn>).mockReset();
});

describe("a comment's body", () => {
  it("is wiki markup on Server, links as [text|url] and markup characters escaped", () => {
    expect(
      jiraCommentBody(
        ["Optio failed: [x] {code} | ", { text: "the run [1]", href: "https://o/work/1" }],
        "server",
      ),
    ).toBe("Optio failed: \\[x\\] \\{code\\} \\| [the run  1|https://o/work/1]");
  });

  it("is ADF on Cloud, with link marks and hard breaks", () => {
    expect(jiraCommentBody(["a\nb ", { text: "run", href: "https://o/1" }], "cloud")).toEqual({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a" },
            { type: "hardBreak" },
            { type: "text", text: "b " },
            {
              type: "text",
              text: "run",
              marks: [{ type: "link", attrs: { href: "https://o/1" } }],
            },
          ],
        },
      ],
    });
  });
});

describe("posting a comment", () => {
  it("sends wiki markup to a Server and returns the new comment's id", async () => {
    server.issueComments.addComment.mockResolvedValue({ id: 20017 });
    const out = await jiraPostComment(
      "PLAT-1",
      ["hi ", { text: "run", href: "https://o/1" }],
      SERVER,
    );
    expect(out).toEqual({ id: "20017" });
    expect(server.issueComments.addComment).toHaveBeenCalledWith({
      issueIdOrKey: "PLAT-1",
      comment: "hi [run|https://o/1]",
    });
    expect(assertSsrfSafe).toHaveBeenCalledWith("https://jira.example.test");
  });

  it("sends ADF to Cloud", async () => {
    cloud.issueComments.addComment.mockResolvedValue({ id: "10" });
    await jiraPostComment("ENG-2", ["hi"], CLOUD);
    expect(cloud.issueComments.addComment.mock.calls[0][0].comment.type).toBe("doc");
  });

  it("gives up on a Jira that never answers", async () => {
    vi.useFakeTimers();
    try {
      server.issueComments.addComment.mockReturnValue(new Promise(() => {}));
      const out = jiraPostComment("PLAT-1", ["x"], SERVER);
      const seen = expect(out).rejects.toThrow("Jira didn't answer within 20 s");
      await vi.advanceTimersByTimeAsync(20_001);
      await seen;
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why it failed, never the body", async () => {
    server.issueComments.addComment.mockRejectedValue(
      Object.assign(new Error("Request failed"), { status: 401, data: "<html>secret</html>" }),
    );
    await expect(jiraPostComment("PLAT-1", ["x"], SERVER)).rejects.toThrow(
      /Authentication failed \(401\)/,
    );
  });
});

describe("comments read back", () => {
  it("keep id and author, oldest first", async () => {
    server.issueComments.getComments.mockResolvedValue({
      comments: [
        {
          id: "30",
          author: { name: "ada", key: "JIRAUSER1", displayName: "Ada" },
          body: "second",
          created: "2026-10-24T10:01:00.000+0000",
        },
        {
          id: "9",
          author: { name: "optio-bot", key: "bot", displayName: "Optio Bot" },
          body: "first",
          created: "2026-10-24T10:00:00.000+0000",
        },
        { author: { name: "x" }, body: "no id" },
      ],
    });
    const rows = await jiraListComments("PLAT-1", SERVER);
    expect(rows.map((r) => [r.id, r.author.name, r.body])).toEqual([
      ["9", "optio-bot", "first"],
      ["30", "ada", "second"],
    ]);
    expect(server.issueComments.getComments).toHaveBeenCalledWith({
      issueIdOrKey: "PLAT-1",
      maxResults: 50,
      orderBy: "-created",
    });
  });

  it("flatten Cloud's ADF", async () => {
    cloud.issueComments.getComments.mockResolvedValue({
      comments: [
        {
          id: "1",
          author: { accountId: "abc" },
          body: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "hey" }] }],
          },
          created: "2026-10-24T10:00:00.000Z",
        },
      ],
    });
    const [row] = await jiraListComments("ENG-1", CLOUD);
    expect(row.body.trim()).toBe("hey");
    expect(row.author.accountId).toBe("abc");
  });
});

describe("accounts and times", () => {
  it("knows the same account by accountId, key or name", () => {
    expect(sameJiraAccount({ accountId: "a" }, { accountId: "a", name: "x" })).toBe(true);
    expect(sameJiraAccount({ key: "k", name: "bot" }, { key: "other", name: "bot" })).toBe(false);
    expect(sameJiraAccount({ name: "Optio-Bot" }, { name: "optio-bot" })).toBe(true);
    expect(sameJiraAccount({ displayName: "Optio" }, { displayName: "Optio" })).toBe(false);
    expect(sameJiraAccount(null, { name: "x" })).toBe(false);
  });

  it("reads Jira's +0000 offsets", () => {
    expect(parseJiraTime("2026-10-24T10:00:00.000+0000")).toBe(Date.UTC(2026, 9, 24, 10));
    expect(parseJiraTime("2026-10-24T12:00:00.000+0200")).toBe(Date.UTC(2026, 9, 24, 10));
    expect(parseJiraTime("2026-10-24T10:00:00.000Z")).toBe(Date.UTC(2026, 9, 24, 10));
    expect(parseJiraTime("soon")).toBeNull();
    expect(parseJiraTime(undefined)).toBeNull();
  });

  it("asks /myself who the provider is", async () => {
    server.myself.getCurrentUser.mockResolvedValue({
      name: "optio-bot",
      key: "bot",
      displayName: "Optio Bot",
    });
    expect(await jiraWhoAmI(SERVER)).toMatchObject({ name: "optio-bot", key: "bot" });
  });
});

describe("the remote link", () => {
  it("is keyed by globalId, so Jira updates it instead of adding another", async () => {
    server.issueRemoteLinks.createOrUpdateRemoteIssueLink.mockResolvedValue({ id: 1 });
    await jiraUpsertRemoteLink(
      "PLAT-1",
      {
        globalId: "optio:t1",
        url: "https://gitlab.example.test/p/r/-/merge_requests/3",
        title: "Merge request !3",
        summary: "Waiting for review",
        resolved: false,
        iconUrl: "https://optio.example.test/favicon-32.png",
      },
      SERVER,
    );
    expect(server.issueRemoteLinks.createOrUpdateRemoteIssueLink).toHaveBeenCalledWith({
      issueIdOrKey: "PLAT-1",
      globalId: "optio:t1",
      application: { type: "io.optio", name: "Optio" },
      relationship: "Optio",
      object: {
        url: "https://gitlab.example.test/p/r/-/merge_requests/3",
        title: "Merge request !3",
        summary: "Waiting for review",
        icon: { url16x16: "https://optio.example.test/favicon-32.png", title: "Optio" },
        status: { resolved: false },
      },
    });
  });
});

describe("statuses and transitions", () => {
  it("lists a project's statuses once each", async () => {
    server.projects.getAllStatuses.mockResolvedValue([
      {
        name: "Task",
        statuses: [
          { name: "To Do" },
          { name: "In Progress", statusCategory: { name: "In Progress" } },
        ],
      },
      { name: "Bug", statuses: [{ name: "In Progress" }, { name: "Done" }] },
    ]);
    const out = await jiraStatuses({ ...SERVER, projectKey: "PLAT" });
    expect(out.map((s) => s.name)).toEqual(["To Do", "In Progress", "Done"]);
    expect(server.projects.getAllStatuses).toHaveBeenCalledWith({ projectIdOrKey: "PLAT" });
  });

  it("lists every status without a project", async () => {
    server.workflowStatuses.getStatuses.mockResolvedValue([{ name: "Open" }, { name: "Closed" }]);
    expect((await jiraStatuses(SERVER)).map((s) => s.name)).toEqual(["Open", "Closed"]);
  });

  const issueIn = (status: string) => {
    server.issues.getIssue.mockResolvedValue({ fields: { status: { name: status } } });
    server.issues.getTransitions.mockResolvedValue({
      transitions: [
        { id: "21", name: "Start progress", to: { name: "In Progress" } },
        { id: "41", name: "Review", to: { name: "In Review" } },
      ],
    });
  };

  it("names the issue's status and where it can go", async () => {
    issueIn("To Do");
    expect(await jiraIssueTransitions("PLAT-1", SERVER)).toEqual({
      status: "To Do",
      transitions: [
        { id: "21", name: "Start progress", to: "In Progress" },
        { id: "41", name: "Review", to: "In Review" },
      ],
    });
  });

  it("moves to a status by name through the transition that leads there", async () => {
    issueIn("To Do");
    expect(await jiraMoveToStatus("PLAT-1", "in review", SERVER)).toEqual({
      moved: true,
      from: "To Do",
    });
    expect(server.issues.doTransition).toHaveBeenCalledWith({
      issueIdOrKey: "PLAT-1",
      transition: { id: "41" },
    });
  });

  it("doesn't move what is already there, or can't get there from here", async () => {
    issueIn("In Review");
    expect(await jiraMoveToStatus("PLAT-1", "In Review", SERVER)).toEqual({
      moved: false,
      from: "In Review",
      reason: "already",
    });
    issueIn("To Do");
    expect(await jiraMoveToStatus("PLAT-1", "Done", SERVER)).toEqual({
      moved: false,
      from: "To Do",
      reason: "unreachable",
      available: ["In Progress", "In Review"],
    });
    expect(server.issues.doTransition).not.toHaveBeenCalled();
  });
});
