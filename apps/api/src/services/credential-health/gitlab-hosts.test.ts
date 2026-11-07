import { describe, expect, it } from "vitest";
import { gitlabHostsFor, namedGitLabHosts, normalizeGitLabHost } from "./gitlab-hosts.js";

const closed = (named: string[]) => gitlabHostsFor({ named, allowGitLabCom: false });
const open = (named: string[]) => gitlabHostsFor({ named, allowGitLabCom: true });

describe("which GitLab hosts a token is sent to", () => {
  it("only the hosts a deployment admin named, in the named order", () => {
    expect(closed(["gitlab-a.example.test", "gitlab-b.example.test"])).toEqual([
      "gitlab-a.example.test",
      "gitlab-b.example.test",
    ]);
    expect(closed(["https://GitLab.example.test:8443/", "gitlab.example.test:8443"])).toEqual([
      "gitlab.example.test:8443",
    ]);
    expect(closed([])).toEqual([]);
  });

  it("never gitlab.com when it isn't allowed, even when named", () => {
    expect(closed(["gitlab.com"])).toEqual([]);
    expect(namedGitLabHosts(["gitlab.com", "gitlab.example.test"], false)).toEqual([
      "gitlab.example.test",
    ]);
  });

  it("with gitlab.com allowed, gitlab.com only when no GitLab is named", () => {
    expect(open([])).toEqual(["gitlab.com"]);
    // A self-hosted GitLab's token is not sent to the internet's.
    expect(open(["gitlab.example.test"])).toEqual(["gitlab.example.test"]);
  });

  it("normalizes what an admin typed", () => {
    expect(normalizeGitLabHost(" https://GitLab.example.test/group ")).toBe("gitlab.example.test");
    expect(normalizeGitLabHost(null)).toBe("");
  });
});
