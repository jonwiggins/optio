import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDir, resolveFlagDirs, withFlagDirs } from "../local/flag-dirs.js";

describe("optio local up --dir", () => {
  let root: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "optio-flag-dirs-")));
    mkdirSync(join(root, "repo"));
    symlinkSync(join(root, "repo"), join(root, "link"));
    writeFileSync(join(root, "file.txt"), "x");
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("collects every --dir", () => {
    expect(collectDir("/b", collectDir("/a"))).toEqual(["/a", "/b"]);
  });

  it("resolves relative paths and symlinks, once each", () => {
    const { paths, missing } = resolveFlagDirs(["repo", join(root, "link"), " "], root);
    expect(paths).toEqual([join(root, "repo")]);
    expect(missing).toEqual([]);
  });

  it("leaves out what isn't a directory here yet", () => {
    const { paths, missing } = resolveFlagDirs(["checkout", "file.txt"], root);
    expect(paths).toEqual([]);
    expect(missing).toEqual([join(root, "checkout"), join(root, "file.txt")]);
  });

  it("adds them to the allowlist without repeating a listed one", () => {
    expect(
      withFlagDirs(
        [{ path: "/home/coder/repo", repoUrl: "https://git.corp/a.git" }],
        [{ path: "/home/coder/repo" }, { path: "/srv/data" }],
      ),
    ).toEqual([
      { path: "/home/coder/repo", repoUrl: "https://git.corp/a.git" },
      { path: "/srv/data" },
    ]);
  });
});
