import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shellSingleQuote,
  buildEnvExports,
  buildPooledExecScript,
  CHECKOUT_REPO,
  POOLED_CHECKOUT_DIR,
  RUN_WORK_SETUP_COMMANDS,
  WRITE_SETUP_FILES,
} from "./pod-env.js";

/**
 * Regression payload for the Phase 4F shell-quoting bug: a realistic task
 * prompt with markdown backticks, `$HOME`, wildcard text like `optio/task-*`,
 * literal newlines, and single quotes. It also carries canary commands — if
 * any of them run, the env injection leaked prompt content to the shell.
 */
const HOSTILE_PROMPT = [
  "Fix the `pr_opened` handling before broader autonomous use.",
  "",
  "Steps:",
  "1. Inspect $HOME and run `git status` in the worktree.",
  "2. Don't touch branches named optio/task-* — they belong to other agents.",
  "3. Preserve 'single-quoted' text exactly as written.",
  "```bash",
  "touch injected-from-fenced-block",
  "```",
  "$(touch injected-from-substitution)",
  "`touch injected-from-backquotes`",
  "rm -rf $HOME/should-never-expand",
].join("\n");

function runBash(script: string, cwd: string): string {
  return execFileSync("bash", ["-c", script], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("shellSingleQuote", () => {
  it("wraps plain values in single quotes", () => {
    expect(shellSingleQuote("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellSingleQuote("don't")).toBe("'don'\\''t'");
  });

  it("handles empty strings", () => {
    expect(shellSingleQuote("")).toBe("''");
  });
});

describe("buildEnvExports", () => {
  it("emits one export statement per env entry", () => {
    expect(buildEnvExports({ A: "1", B_2: "two" })).toEqual(["export A='1'", "export B_2='two'"]);
  });

  it("rejects env names bash would not accept as identifiers", () => {
    expect(() => buildEnvExports({ "BAD-NAME": "x" })).toThrow(/Invalid environment variable/);
    expect(() => buildEnvExports({ "PATH; touch pwned": "x" })).toThrow(
      /Invalid environment variable/,
    );
    expect(() => buildEnvExports({ "1LEADING": "x" })).toThrow(/Invalid environment variable/);
  });

  it("round-trips a hostile prompt through bash without executing its contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "pod-env-"));
    try {
      const script = [
        "set -e",
        ...buildEnvExports({
          OPTIO_PROMPT: HOSTILE_PROMPT,
          OPTIO_TASK_ID: "task-1",
        }),
        `printf '%s' "$OPTIO_PROMPT" > prompt-out`,
        `printf '%s' "$OPTIO_TASK_ID" > task-id-out`,
      ].join("\n");

      // Throws on non-zero exit — e.g. "command not found" from a prompt
      // line leaking to the shell under `set -e`.
      const stdout = runBash(script, dir);
      expect(stdout).toBe("");

      // Exact round-trip: newlines, backticks, $HOME, globs, quotes intact.
      expect(readFileSync(join(dir, "prompt-out"), "utf8")).toBe(HOSTILE_PROMPT);
      expect(readFileSync(join(dir, "task-id-out"), "utf8")).toBe("task-1");

      // No canary commands executed — only our two output files exist.
      expect(readdirSync(dir).sort()).toEqual(["prompt-out", "task-id-out"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps values with only quotes and whitespace intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "pod-env-"));
    try {
      const value = `  '  "  \t  '' \n `;
      const script = [
        "set -e",
        ...buildEnvExports({ TRICKY: value }),
        `printf '%s' "$TRICKY" > out`,
      ].join("\n");
      runBash(script, dir);
      expect(readFileSync(join(dir, "out"), "utf8")).toBe(value);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("WRITE_SETUP_FILES / RUN_WORK_SETUP_COMMANDS", () => {
  const files = [
    { path: ".mcp.json", content: '{"mcpServers":{}}' },
    { path: ".claude/commands/release.md", content: "How we release\n" },
    // Marketplace skills travel as base64, possibly binary and executable.
    {
      path: ".claude/skills/tool/run.sh",
      content: "",
      contentBase64: Buffer.from("#!/bin/sh\necho hi\n").toString("base64"),
      executable: true,
    },
  ];

  function run(env: Record<string, string>, dir: string): string {
    return runBash(
      [...buildEnvExports(env), ...WRITE_SETUP_FILES, ...RUN_WORK_SETUP_COMMANDS].join("\n"),
      dir,
    );
  }

  it("writes every setup file under the working directory, base64 ones decoded", () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-setup-"));
    try {
      run({ OPTIO_SETUP_FILES: Buffer.from(JSON.stringify(files)).toString("base64") }, dir);
      expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe('{"mcpServers":{}}');
      expect(readFileSync(join(dir, ".claude/commands/release.md"), "utf8")).toBe(
        "How we release\n",
      );
      const script = join(dir, ".claude/skills/tool/run.sh");
      expect(readFileSync(script, "utf8")).toBe("#!/bin/sh\necho hi\n");
      expect(statSync(script).mode & 0o111).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the work's setup commands in the working directory, and stops when they fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-setup-"));
    try {
      run({ OPTIO_WORK_SETUP_COMMANDS: "echo ready > marker && echo 'it''s set'" }, dir);
      expect(readFileSync(join(dir, "marker"), "utf8")).toBe("ready\n");
      expect(() => run({ OPTIO_WORK_SETUP_COMMANDS: "false" }, dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing without setup files or commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-setup-"));
    try {
      expect(run({}, dir)).toBe("");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CHECKOUT_REPO", () => {
  it("clones the repo at its branch once, then only fetches — the agent's changes stay", () => {
    const root = mkdtempSync(join(tmpdir(), "optio-checkout-"));
    try {
      const origin = join(root, "origin");
      const git = (args: string[], cwd = root) =>
        execFileSync("git", args, { cwd, env: { ...process.env, HOME: root }, stdio: "pipe" });
      git(["init", "-q", "-b", "dev", origin]);
      git(
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one"],
        origin,
      );

      const checkout = join(root, "checkout");
      const script = [
        ...buildEnvExports({ OPTIO_REPO_URL: origin, OPTIO_REPO_BRANCH: "dev" }),
        ...CHECKOUT_REPO,
        `cd ${checkout}`,
        "git rev-parse --abbrev-ref HEAD",
      ]
        .join("\n")
        .replaceAll(POOLED_CHECKOUT_DIR, checkout);
      const run = () =>
        execFileSync("bash", ["-c", script], {
          cwd: root,
          encoding: "utf8",
          // Its own HOME: the script configures git globally, as in a pod.
          env: { ...process.env, HOME: root },
          stdio: ["ignore", "pipe", "pipe"],
        });

      expect(run().trim().split("\n").pop()).toBe("dev");
      execFileSync("bash", ["-c", `echo note > ${join(checkout, "agent-notes.md")}`]);
      run();
      expect(readFileSync(join(checkout, "agent-notes.md"), "utf8")).toBe("note\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildPooledExecScript", () => {
  const base = { env: { A: "1" }, workDir: "/workspace/turns/t1", agentCommand: ["run-agent"] };

  it("runs in the run's own directory, after its setup files and commands", () => {
    const script = buildPooledExecScript(base);
    expect(script).toContain(`mkdir -p '/workspace/turns/t1'`);
    expect(script).toContain(`cd '/workspace/turns/t1'`);
    expect(script.indexOf(WRITE_SETUP_FILES[0])).toBeLessThan(script.indexOf("run-agent"));
    expect(script.indexOf(RUN_WORK_SETUP_COMMANDS[0])).toBeLessThan(script.indexOf("run-agent"));
  });

  it("with a repo, works in the pod's one checkout of it", () => {
    const script = buildPooledExecScript({ ...base, checkout: true });
    expect(script).toContain(CHECKOUT_REPO.join("\n"));
    expect(script).toContain(`cd '${POOLED_CHECKOUT_DIR}'`);
    expect(script).not.toContain("/workspace/turns/t1");
  });
});
