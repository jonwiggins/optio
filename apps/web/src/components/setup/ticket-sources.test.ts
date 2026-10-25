import { featuresFromEnv } from "@optio/shared/features";
import { describe, it, expect } from "vitest";
import { gitLabIssuesProject, gitLabIssuesRepo, setupTrackerSources } from "./ticket-sources";

describe("setupTrackerSources", () => {
  it("offers Linear, Notion and Jira under the default deployment", () => {
    expect(setupTrackerSources(featuresFromEnv({}))).toEqual(["linear", "notion", "jira"]);
  });

  it("offers Jira alone under the restricted deployment (its GitLab issues have their own toggles)", () => {
    expect(
      setupTrackerSources(
        featuresFromEnv({ OPTIO_FEATURE_PRESET: "minimal", OPTIO_MODEL_ACCESS: "gateway" }),
      ),
    ).toEqual(["jira"]);
  });
});

describe("gitLabIssuesProject", () => {
  it("reads a self-managed GitLab project, groups included", () => {
    expect(gitLabIssuesProject("https://gitlab.example.com/platform/tools/optio.git")).toEqual({
      host: "gitlab.example.com",
      projectPath: "platform/tools/optio",
    });
    expect(gitLabIssuesProject("git@git.example.org:team/app.git")).toEqual({
      host: "git.example.org",
      projectPath: "team/app",
    });
    expect(gitLabIssuesProject("https://gitlab.com/a/b/-/merge_requests/3")).toEqual({
      host: "gitlab.com",
      projectPath: "a/b",
    });
  });

  it("refuses GitHub and anything that isn't a project URL", () => {
    expect(gitLabIssuesProject("https://github.com/acme/web")).toBeNull();
    expect(gitLabIssuesProject("https://gitlab.example.com/")).toBeNull();
    expect(gitLabIssuesProject("not a url at all")).toBeNull();
  });
});

describe("gitLabIssuesRepo", () => {
  it("takes the Git step's GitLab host, gitlab.com and hosts named gitlab where GitHub is offered", () => {
    expect(
      gitLabIssuesRepo("https://git.example.com/team/app", "https://git.example.com/", true),
    ).toEqual({
      host: "git.example.com",
      projectPath: "team/app",
    });
    expect(gitLabIssuesRepo("https://gitlab.com/team/app", "gitlab.com", true)).not.toBeNull();
    expect(
      gitLabIssuesRepo("https://gitlab.example.com/team/app", "gitlab.com", true),
    ).not.toBeNull();
    // A GitHub Enterprise repo stays out.
    expect(gitLabIssuesRepo("https://ghe.example.com/team/app", "gitlab.com", true)).toBeNull();
    expect(gitLabIssuesRepo("https://github.com/acme/web", "gitlab.com", true)).toBeNull();
  });

  it("takes any non-GitHub project where GitHub isn't offered", () => {
    expect(
      gitLabIssuesRepo("https://ghe.example.com/team/app", "gitlab.com", false),
    ).not.toBeNull();
    expect(gitLabIssuesRepo("https://github.com/acme/web", "gitlab.com", false)).toBeNull();
  });
});
