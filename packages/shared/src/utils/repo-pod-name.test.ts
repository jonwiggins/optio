import { afterEach, describe, expect, it, vi } from "vitest";
import { repoPodNameParts } from "./repo-pod-name.js";
import { generateRepoPodName, generateStatefulSetName } from "../constants.js";

// Upstream issue #676: a project name with a dot fell back to unknown-unknown.
describe("repoPodNameParts", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads a dotted GitLab project", () => {
    expect(repoPodNameParts("https://gitlab.example.com/platform/my.service.git")).toEqual({
      owner: "platform",
      repo: "my.service",
    });
    expect(repoPodNameParts("https://gitlab.example.com/platform/my.service")).toEqual({
      owner: "platform",
      repo: "my.service",
    });
  });

  it("takes the last subgroup as the owner", () => {
    expect(repoPodNameParts("https://gitlab.example.com/group/sub/my.proj.git")).toEqual({
      owner: "sub",
      repo: "my.proj",
    });
  });

  it("reads SSH URLs with a dot", () => {
    expect(repoPodNameParts("git@gitlab.example.com:group/sub/my.proj.git")).toEqual({
      owner: "sub",
      repo: "my.proj",
    });
    expect(repoPodNameParts("git@github.com:acme/example.dev.git")).toEqual({
      owner: "acme",
      repo: "example.dev",
    });
  });

  it("keeps upstream's answer for every URL it already read", () => {
    // Existing pods and StatefulSets keep their names across the upgrade.
    expect(repoPodNameParts("https://github.com/jonwiggins/optio.git")).toEqual({
      owner: "jonwiggins",
      repo: "optio",
    });
    expect(repoPodNameParts("https://gitlab.example.com/group/sub/proj")).toEqual({
      owner: "sub",
      repo: "proj",
    });
    expect(
      repoPodNameParts("https://git-codecommit.us-east-1.amazonaws.com/v1/repos/MyRepo"),
    ).toEqual({ owner: "repos", repo: "MyRepo" });
  });

  it("reads a named GitLab host's subgroups with any feature lists", () => {
    vi.stubEnv("GITLAB_HOSTS", "git.example.com");
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
    expect(repoPodNameParts("https://git.example.com/group/sub/my.proj.git")).toEqual({
      owner: "sub",
      repo: "my.proj",
    });
    // Every platform offered (the default): a host named in GITLAB_HOSTS.
    vi.stubEnv("OPTIO_GIT_PLATFORMS", "");
    vi.stubEnv("GITLAB_HOSTS", "git.example.com");
    expect(repoPodNameParts("https://git.example.com/group/sub/my.proj.git")).toEqual({
      owner: "sub",
      repo: "my.proj",
    });
  });

  it("falls back to unknown", () => {
    expect(repoPodNameParts("not-a-url")).toEqual({ owner: "unknown", repo: "unknown" });
  });
});

describe("pod and StatefulSet names for dotted projects", () => {
  it("names the pod after platform/my.service", () => {
    expect(generateRepoPodName("https://gitlab.example.com/platform/my.service.git")).toMatch(
      /^optio-repo-platform-my-service-[0-9a-f]{4}$/,
    );
  });

  it("names the StatefulSet after group/sub/my.proj", () => {
    expect(generateStatefulSetName("https://gitlab.example.com/group/sub/my.proj.git")).toBe(
      "optio-sts-sub-my-proj",
    );
  });

  it("names acme/example.dev", () => {
    expect(generateStatefulSetName("https://gitlab.example.com/acme/example.dev")).toBe(
      "optio-sts-acme-example-dev",
    );
  });

  it("gives two dotted projects two names", () => {
    expect(generateStatefulSetName("https://gitlab.example.com/platform/a.service")).not.toBe(
      generateStatefulSetName("https://gitlab.example.com/platform/b.service"),
    );
  });
});
