import { describe, expect, it } from "vitest";
import { gitlabHostsFor, namedGitLabHosts, normalizeGitLabHost } from "./gitlab-hosts.js";

const closed = (named: string[], own: string[]) =>
  gitlabHostsFor({ named, ownerRepoHosts: own, allowGitLabCom: false });

describe("which GitLab hosts a token is sent to", () => {
  it("never a host only a repo names: any workspace admin adds repos, on any host", () => {
    expect(closed(["gitlab.example.test"], ["collector.example.test"])).toEqual([]);
    expect(closed([], ["gitlab.example.test"])).toEqual([]);
    expect(closed([], [])).toEqual([]);
  });

  it("the named hosts the owner's work uses, in the named order", () => {
    expect(
      closed(
        ["gitlab-a.example.test", "gitlab-b.example.test", "gitlab-c.example.test"],
        ["gitlab-c.example.test", "collector.example.test", "gitlab-a.example.test"],
      ),
    ).toEqual(["gitlab-a.example.test", "gitlab-c.example.test"]);
  });

  it("every named host when the owner has no GitLab repo yet", () => {
    expect(closed(["gitlab-a.example.test", "gitlab-b.example.test"], [])).toEqual([
      "gitlab-a.example.test",
      "gitlab-b.example.test",
    ]);
  });

  it("matches a repo's host to a named host with a port or a scheme", () => {
    expect(closed(["https://GitLab.example.test:8443/"], ["gitlab.example.test"])).toEqual([
      "gitlab.example.test:8443",
    ]);
  });

  it("never gitlab.com when it isn't allowed, even when named or used", () => {
    expect(closed(["gitlab.com"], ["gitlab.com"])).toEqual([]);
    expect(namedGitLabHosts(["gitlab.com", "gitlab.example.test"], false)).toEqual([
      "gitlab.example.test",
    ]);
  });

  it("with gitlab.com allowed, gitlab.com for an owner with repos there, or when nothing else is known", () => {
    const open = (named: string[], own: string[]) =>
      gitlabHostsFor({ named, ownerRepoHosts: own, allowGitLabCom: true });
    expect(open([], ["gitlab.com"])).toEqual(["gitlab.com"]);
    expect(open(["gitlab.example.test"], ["gitlab.com", "gitlab.example.test"])).toEqual([
      "gitlab.example.test",
      "gitlab.com",
    ]);
    // A self-hosted GitLab's token is not sent to the internet's.
    expect(open(["gitlab.example.test"], ["gitlab.example.test"])).toEqual(["gitlab.example.test"]);
    expect(open([], ["gitlab.example.test"])).toEqual([]);
    expect(open([], [])).toEqual(["gitlab.com"]);
  });

  it("normalizes what an admin typed", () => {
    expect(normalizeGitLabHost(" https://GitLab.example.test/group ")).toBe("gitlab.example.test");
    expect(normalizeGitLabHost(null)).toBe("");
  });
});
