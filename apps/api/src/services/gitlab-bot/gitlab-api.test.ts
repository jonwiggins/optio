import { describe, expect, it } from "vitest";
import { GitLabBotApiError, gitlabProblem } from "./gitlab-api.js";

describe("gitlabProblem", () => {
  it("says GitLab's status, never the body or the address", () => {
    const err = new GitLabBotApiError(
      500,
      "/projects/42/members/all/7",
      "<html>Internal error at db-3.corp.internal</html>",
    );
    expect(err.message).toContain("db-3.corp.internal");
    expect(gitlabProblem(err)).toBe("GitLab answered 500");
    expect(gitlabProblem(new Error("GitLab API error 403 on /projects/42/pipelines"))).toBe(
      "GitLab answered 403",
    );
  });

  it("says GitLab didn't answer for anything else", () => {
    expect(
      gitlabProblem(new TypeError("fetch failed: unable to verify the first certificate")),
    ).toBe("GitLab didn't answer");
    expect(gitlabProblem("odd")).toBe("GitLab didn't answer");
  });
});
