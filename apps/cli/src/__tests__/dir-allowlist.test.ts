import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "optio-dirs-")));
const testLocalConfigPath = join(tempDir, "local.json");

vi.mock("../config/paths.js", () => ({
  localConfigPath: () => testLocalConfigPath,
}));

import { loadLocalConfig } from "../config/local-store.js";
import {
  DirAllowlistError,
  addAllowedDir,
  expandHome,
  removeAllowedDir,
} from "../local/dir-allowlist.js";

const project = join(tempDir, "project");
const checkout = join(tempDir, "checkout");
mkdirSync(project);
mkdirSync(checkout);
execFileSync("git", ["init", "-q", checkout]);
execFileSync("git", ["-C", checkout, "remote", "add", "origin", "git@github.com:acme/app.git"]);

describe("dir allowlist", () => {
  beforeEach(() => {
    rmSync(testLocalConfigPath, { force: true });
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("expands ~ against the home directory", () => {
    expect(expandHome("~", "/home/me")).toBe("/home/me");
    expect(expandHome("~/src/app", "/home/me")).toBe("/home/me/src/app");
    expect(expandHome("/abs/~x", "/home/me")).toBe("/abs/~x");
    expect(expandHome("~other", "/home/me")).toBe("~other");
  });

  it("adds a directory, and a checkout with its remote", async () => {
    const plain = await addAllowedDir(project);
    expect(plain).toMatchObject({ path: project, alreadyAdded: false });
    expect(plain.repoUrl).toBeUndefined();

    const repo = await addAllowedDir(checkout);
    expect(repo).toMatchObject({ path: checkout, repoUrl: "git@github.com:acme/app.git" });
    expect(repo.dirs).toEqual([
      { path: project },
      { path: checkout, repoUrl: "git@github.com:acme/app.git" },
    ]);
    expect(loadLocalConfig().dirs).toEqual(repo.dirs);
  });

  it("re-adding refreshes the entry instead of duplicating it", async () => {
    await addAllowedDir(project);
    const again = await addAllowedDir(`${project}/`);
    expect(again.alreadyAdded).toBe(true);
    expect(again.dirs).toHaveLength(1);
  });

  it("resolves a relative path against cwd for the CLI", async () => {
    const added = await addAllowedDir("project", { cwd: tempDir });
    expect(added.path).toBe(project);
  });

  it("refuses what Optio can't sensibly ask for", async () => {
    await expect(addAllowedDir("project", { remote: true, cwd: tempDir })).rejects.toThrow(
      /absolute path/,
    );
    await expect(addAllowedDir("/", { remote: true })).rejects.toThrow(/root/);
    await expect(addAllowedDir(join(tempDir, "nope"), { remote: true })).rejects.toThrow(
      /No such directory/,
    );
    const file = join(tempDir, "file.txt");
    writeFileSync(file, "x");
    await expect(addAllowedDir(file, { remote: true })).rejects.toThrow(/Not a directory/);
    await expect(addAllowedDir("  ", { remote: true })).rejects.toBeInstanceOf(DirAllowlistError);
    expect(loadLocalConfig().dirs).toEqual([]);
  });

  it("removes a directory, and says so when it isn't listed", async () => {
    await addAllowedDir(project);
    await addAllowedDir(checkout);
    const removed = removeAllowedDir(project, { remote: true });
    expect(removed.path).toBe(project);
    expect(removed.dirs.map((d) => d.path)).toEqual([checkout]);
    expect(() => removeAllowedDir(project, { remote: true })).toThrow(/not in the allowlist/);
  });

  it("removes an entry whose directory is gone from disk", async () => {
    const doomed = join(tempDir, "doomed");
    mkdirSync(doomed);
    await addAllowedDir(doomed);
    rmSync(doomed, { recursive: true });
    expect(removeAllowedDir(doomed).dirs).toEqual([]);
  });
});
