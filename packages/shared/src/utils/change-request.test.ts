import { describe, it, expect } from "vitest";
import { featuresFromEnv } from "../config/features.js";
import {
  changeRequestAbbrev,
  changeRequestHost,
  changeRequestRef,
  isMergeRequest,
} from "./change-request.js";

/** Every platform offered (the default), and GitLab without GitHub. */
const ALL = { features: featuresFromEnv({}) };
const GITLAB_ONLY = { features: featuresFromEnv({ OPTIO_GIT_PLATFORMS: "gitlab" }) };

describe("change-request wording", () => {
  it("reads a merge request from its URL whatever the platforms or host name", () => {
    const mr = "https://git.example.com/group/app/-/merge_requests/12";
    expect(isMergeRequest(mr, ALL)).toBe(true);
    expect(changeRequestAbbrev(mr, GITLAB_ONLY)).toBe("MR");
    expect(changeRequestRef(12, mr, ALL)).toBe("!12");
    expect(changeRequestHost(mr, ALL)).toBe("GitLab");
  });

  it("reads a pull request from its URL, even on a repo named gitlab", () => {
    const pr = "https://github.com/acme/gitlab-tools/pull/7";
    expect(isMergeRequest(pr, { ...GITLAB_ONLY, platform: "gitlab" })).toBe(false);
    expect(changeRequestAbbrev(pr, GITLAB_ONLY)).toBe("PR");
    expect(changeRequestRef(7, pr, GITLAB_ONLY)).toBe("#7");
    expect(changeRequestHost(pr, ALL)).toBe("GitHub");
  });

  it("with no URL yet, goes by the repo's platform, else the deployment", () => {
    expect(changeRequestAbbrev(null, { ...ALL, platform: "gitlab" })).toBe("MR");
    expect(changeRequestAbbrev(null, { ...GITLAB_ONLY, platform: "github" })).toBe("PR");
    expect(changeRequestAbbrev(null, GITLAB_ONLY)).toBe("MR");
    expect(changeRequestAbbrev(undefined, ALL)).toBe("PR");
    expect(changeRequestHost(null, { platform: "codecommit" })).toBe("CodeCommit");
  });
});
