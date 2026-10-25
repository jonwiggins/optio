/**
 * The commit-trailers hook, for real: the setup lines run in a scratch git
 * repository with a linked worktree (as in a repo pod), then commits are made
 * the ways an agent makes them, and their messages read back.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMMIT_HOOK_MARKER,
  commitTrailerHookSetup,
  prepareCommitMsgHook,
} from "./commit-trailers.js";

let root: string;
let repo: string;
let worktree: string;

const RUN_ENV = {
  OPTIO_JIRA_KEY: "PLAT-1",
  OPTIO_COMMIT_CO_AUTHOR: "Ada Lovelace <ada@example.test>",
  OPTIO_RUN_URL: "https://optio.example.test/work/t1",
  OPTIO_TEAM_NAME: "Platform",
};

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: root,
      GIT_AUTHOR_NAME: "Optio Agent",
      GIT_AUTHOR_EMAIL: "agent@optio.test",
      GIT_COMMITTER_NAME: "Optio Agent",
      GIT_COMMITTER_EMAIL: "agent@optio.test",
      ...env,
    },
    encoding: "utf8",
  });
}

/** Runs the task setup's hook lines in the worktree, with the run's environment. */
function setup(env: Record<string, string>) {
  return execFileSync("sh", ["-c", commitTrailerHookSetup().join("\n")], {
    cwd: worktree,
    env: { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", ...env },
    encoding: "utf8",
  });
}

function commit(message: string, env: Record<string, string>, file = "a.txt") {
  writeFileSync(join(worktree, file), `${Math.random()}\n`);
  git(worktree, ["add", file], env);
  git(worktree, ["commit", "-q", "-m", message], env);
  return git(worktree, ["log", "-1", "--format=%B"], env).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "optio-trailers-"));
  repo = join(root, "repo");
  worktree = join(root, "task-1");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
  git(repo, ["worktree", "add", "-q", "-b", "optio/task-1", worktree]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the commit-trailers hook", () => {
  it("ends every commit with the ticket, the requester, the run and the team", () => {
    expect(setup(RUN_ENV)).toContain("Commit trailers hook installed");
    const msg = commit("feat: add /health", RUN_ENV);
    expect(msg).toBe(
      [
        "feat: add /health",
        "",
        "Jira: PLAT-1",
        "Co-authored-by: Ada Lovelace <ada@example.test>",
        "Optio-Run: https://optio.example.test/work/t1",
        "Optio-Team: Platform",
      ].join("\n"),
    );
    // The author stays the bot.
    expect(git(worktree, ["log", "-1", "--format=%an <%ae>"]).trim()).toBe(
      "Optio Agent <agent@optio.test>",
    );
  });

  it("never adds a trailer twice (the agent wrote them, or the commit is amended)", () => {
    setup(RUN_ENV);
    const msg = commit(
      "fix: thing\n\nCo-authored-by: Ada Lovelace <ada@example.test>\nOptio-Run: https://optio.example.test/work/t1",
      RUN_ENV,
    );
    expect(msg.match(/Co-authored-by/g)).toHaveLength(1);
    expect(msg.match(/Optio-Run/g)).toHaveLength(1);
    git(worktree, ["commit", "-q", "--amend", "--no-edit"], RUN_ENV);
    const amended = git(worktree, ["log", "-1", "--format=%B"]).trim();
    expect(amended.match(/Optio-Team/g)).toHaveLength(1);
  });

  it("adds what each run's environment says (one hook for every task in the pod)", () => {
    setup(RUN_ENV);
    const other = { OPTIO_RUN_URL: "https://optio.example.test/work/t2" };
    const msg = commit("chore: other task", other);
    expect(msg).toBe("chore: other task\n\nOptio-Run: https://optio.example.test/work/t2");
    expect(commit("chore: nothing to add", {})).toBe("chore: nothing to add");
  });

  it("is not installed for a run with nothing to add", () => {
    expect(setup({})).toBe("");
    expect(existsSync(join(repo, ".git", "hooks", "prepare-commit-msg"))).toBe(false);
  });

  it("keeps the repository's own prepare-commit-msg, which runs first", () => {
    const own = join(repo, ".git", "hooks", "prepare-commit-msg");
    writeFileSync(own, '#!/bin/sh\nprintf "[own hook]\\n" >> "$1"\n');
    chmodSync(own, 0o755);
    setup(RUN_ENV);
    expect(readFileSync(own, "utf8")).toContain(COMMIT_HOOK_MARKER);
    expect(existsSync(`${own}.optio-chained`)).toBe(true);
    const msg = commit("feat: chained", { OPTIO_RUN_URL: "https://o/work/3" });
    expect(msg).toBe("feat: chained\n[own hook]\n\nOptio-Run: https://o/work/3");
    // A second run rewrites Optio's hook and leaves the chained one alone.
    setup(RUN_ENV);
    expect(readFileSync(`${own}.optio-chained`, "utf8")).toContain("[own hook]");
  });

  it("leaves a repository with core.hooksPath (husky) alone", () => {
    git(repo, ["config", "core.hooksPath", ".husky/_"]);
    expect(setup(RUN_ENV)).toContain("core.hooksPath is set");
    expect(existsSync(join(repo, ".git", "hooks", "prepare-commit-msg"))).toBe(false);
  });

  it("doesn't turn an empty (aborted) message into a commit", () => {
    setup(RUN_ENV);
    writeFileSync(join(worktree, "b.txt"), "x\n");
    git(worktree, ["add", "b.txt"]);
    expect(() =>
      git(worktree, ["commit", "-q", "--cleanup=strip", "-m", "# only a comment"], RUN_ENV),
    ).toThrow();
  });

  it("never ends the run's setup (set -e) when it can't be installed", () => {
    // The hooks directory is a file: nothing can be written there.
    rmSync(join(repo, ".git", "hooks"), { recursive: true, force: true });
    writeFileSync(join(repo, ".git", "hooks"), "not a directory");
    const out = execFileSync(
      "sh",
      ["-c", ["set -e", ...commitTrailerHookSetup(), "echo setup-went-on"].join("\n")],
      { cwd: worktree, env: { ...process.env, HOME: root, ...RUN_ENV }, encoding: "utf8" },
    );
    expect(out).toContain("Could not install the commit trailers hook");
    expect(out).toContain("setup-went-on");
  });

  it("is plain POSIX sh", () => {
    expect(prepareCommitMsgHook().startsWith("#!/bin/sh\n")).toBe(true);
    execFileSync("sh", ["-n", "-c", prepareCommitMsgHook()]);
    execFileSync("sh", ["-n", "-c", commitTrailerHookSetup().join("\n")]);
  });
});
