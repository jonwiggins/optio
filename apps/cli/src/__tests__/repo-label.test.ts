import { describe, it, expect } from "vitest";
import { repoFullName, repoLabel } from "../output/repo-label.js";
import { createProgram } from "../program.js";

describe("repoLabel", () => {
  it("shows the path on any host", () => {
    expect(repoLabel("https://github.com/acme/web")).toBe("acme/web");
    expect(repoLabel("https://gitlab.com/group/sub/project.git")).toBe("group/sub/project");
    expect(repoLabel("https://git.example.com:8443/platform/app/")).toBe("platform/app");
    expect(repoLabel("git@git.example.com:team/app.git")).toBe("team/app");
    expect(repoLabel(null)).toBe("");
  });
});

describe("repoFullName", () => {
  it("keeps a GitLab namespace whole when the platform is given", () => {
    expect(repoFullName("https://git.example.com/group/sub/app", "gitlab")).toBe("group/sub/app");
    expect(repoFullName("https://github.com/acme/web.git")).toBe("acme/web");
  });
});

describe("repo add", () => {
  it("takes --platform github|gitlab|codecommit", () => {
    const repo = createProgram().commands.find((c) => c.name() === "repo");
    const add = repo?.commands.find((c) => c.name() === "add");
    const option = add?.options.find((o) => o.long === "--platform");
    expect(option?.argChoices).toEqual(["github", "gitlab", "codecommit"]);
  });
});
