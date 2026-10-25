import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// What the repo, task and session commands send and print for any host:
// `repo add --platform`, the MR: line of `task show`, the short repo paths of
// `task list` and `session list`.
const client = vi.hoisted(() => ({
  get: vi.fn(async (_path: string): Promise<unknown> => ({})),
  post: vi.fn(async (_path: string, _body: unknown): Promise<unknown> => ({ repo: {} })),
}));
vi.mock("../api/client.js", () => ({ buildClient: () => client }));

import { createProgram } from "../program.js";

let out = "";
beforeEach(() => {
  out = "";
  client.get.mockReset();
  client.post.mockReset();
  client.post.mockResolvedValue({ repo: {} });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    out += String(chunk);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const run = (...args: string[]) =>
  createProgram().parseAsync([
    "node",
    "optio",
    "--server",
    "https://optio.example.com",
    "--api-key",
    "optio_pat_test",
    ...args,
  ]);

describe("optio repo add", () => {
  // The commands are module singletons that keep option values between
  // parses (commander 12): the default case goes first.
  it("sends the URL and its owner/repo, and no platform, by default", async () => {
    await run("repo", "add", "https://github.com/acme/web");
    expect(client.post).toHaveBeenCalledWith("/api/repos", {
      repoUrl: "https://github.com/acme/web",
      fullName: "acme/web",
    });
  });

  it("sends --platform as gitPlatform, with the whole GitLab namespace", async () => {
    await run("repo", "add", "https://git.example.com/group/sub/app", "--platform", "gitlab");
    expect(client.post).toHaveBeenCalledWith("/api/repos", {
      repoUrl: "https://git.example.com/group/sub/app",
      fullName: "group/sub/app",
      gitPlatform: "gitlab",
    });
  });
});

describe("optio task show", () => {
  it("prints PR: for a pull request, as upstream", async () => {
    client.get.mockResolvedValue({
      task: { id: "t1", title: "Fix", state: "pr_opened", prUrl: "https://github.com/a/b/pull/3" },
    });
    await run("task", "show", "t1");
    expect(out).toContain("PR:");
    expect(out).not.toContain("MR:");
  });

  it("prints MR: for a merge request", async () => {
    client.get.mockResolvedValue({
      task: {
        id: "t2",
        title: "Fix",
        state: "pr_opened",
        prUrl: "https://git.example.com/g/p/-/merge_requests/4",
      },
    });
    await run("task", "show", "t2");
    expect(out).toContain("MR:");
    expect(out).not.toContain("PR:");
  });
});

describe("optio task list and session list", () => {
  it("show each repo's path on any host", async () => {
    client.get.mockResolvedValue({
      tasks: [
        { id: "t1", state: "running", title: "A", repoUrl: "https://github.com/acme/web" },
        {
          id: "t2",
          state: "queued",
          title: "B",
          repoUrl: "https://git.example.com:8443/group/sub/app.git",
        },
      ],
    });
    await run("task", "list");
    expect(out).toContain("acme/web");
    expect(out).toContain("group/sub/app");
    expect(out).not.toContain("git.example.com");

    out = "";
    client.get.mockResolvedValue({
      sessions: [
        { id: "s1", state: "active", repoUrl: "git@git.example.com:team/app.git", branch: "main" },
      ],
    });
    await run("session", "list");
    expect(out).toContain("team/app");
    expect(out).not.toContain("git.example.com");
  });
});
