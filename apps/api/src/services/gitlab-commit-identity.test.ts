import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getGitToken = vi.hoisted(() => vi.fn());
vi.mock("./git-token-service.js", () => ({ getGitToken }));

import { fakeGitLab } from "../test-utils/fake-gitlab.js";
import { gitLabCommitIdentity, resetGitLabCommitIdentityCache } from "./gitlab-commit-identity.js";

describe("gitLabCommitIdentity", () => {
  beforeEach(() => {
    vi.stubEnv("GITLAB_HOSTS", "gitlab.example.test");
    resetGitLabCommitIdentityCache();
    getGitToken.mockReset().mockResolvedValue("glpat-org");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is the organization token's bot user, with GitLab's private commit email", async () => {
    const gl = fakeGitLab({
      host: "gitlab.example.test",
      bot: { id: 42, username: "project_7_bot", bot: true },
      token: "glpat-org",
    });
    vi.stubGlobal("fetch", gl.fetch);

    const identity = await gitLabCommitIdentity("https://gitlab.example.test/acme/app", "ws-1");

    expect(identity).toEqual({
      name: "project_7_bot",
      email: "42-project_7_bot@users.noreply.gitlab.example.test",
    });
    expect(getGitToken).toHaveBeenCalledWith("gitlab", {
      server: true,
      workspaceId: "ws-1",
      host: "gitlab.example.test",
    });
    // Asked once an hour, not for every pod
    await gitLabCommitIdentity("https://gitlab.example.test/acme/other", "ws-1");
    expect(gl.calls.filter((c) => c === "GET /user")).toHaveLength(1);
  });

  it("prefers the user's own commit email and display name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 5,
              username: "optio",
              name: "Optio Bot",
              commit_email: "optio@example.test",
              bot: true,
            }),
            { status: 200 },
          ),
      ),
    );
    expect(await gitLabCommitIdentity("https://gitlab.com/acme/app", null)).toEqual({
      name: "Optio Bot",
      email: "optio@example.test",
    });
  });

  it("is nothing for a person's token: agents never commit as a real person", async () => {
    for (const user of [
      { id: 7, username: "alice", name: "Alice Admin", commit_email: "alice@example.test" },
      { id: 7, username: "alice", name: "Alice Admin", bot: false },
    ]) {
      resetGitLabCommitIdentityCache();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(user), { status: 200 })),
      );
      expect(await gitLabCommitIdentity("https://gitlab.com/acme/app", null)).toBeNull();
    }
  });

  it("is nothing for a GitHub repo, without a token, or when GitLab refuses", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await gitLabCommitIdentity("https://github.com/acme/app", null)).toBeNull();
    expect(getGitToken).not.toHaveBeenCalled();

    expect(await gitLabCommitIdentity("https://gitlab.com/acme/app", null)).toBeNull();

    getGitToken.mockRejectedValue(new Error("No GitLab token available"));
    resetGitLabCommitIdentityCache();
    expect(await gitLabCommitIdentity("https://gitlab.com/acme/app", null)).toBeNull();
  });
});
