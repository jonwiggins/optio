import { describe, it, expect, vi } from "vitest";
import { CLAUDE_MANAGED_SETTINGS_PATH } from "@optio/shared";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachRunScript,
  buildEnvExports,
  buildPooledStartScript,
  CHECKOUT_REPO,
  deliverStdinScript,
  gitBotEnv,
  gitBotIdentity,
  killRunScript,
  POOLED_CHECKOUT_DIR,
  RUN_FILES,
  RUN_STARTED_MARKER,
  RUN_WORK_SETUP_COMMANDS,
  STDIN_EOF_SENTINEL,
  superviseAgent,
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

  describe("Claude Code's managed settings (agent-policy.ts)", () => {
    const managed = {
      path: CLAUDE_MANAGED_SETTINGS_PATH,
      content: JSON.stringify({
        permissions: { deny: ["Read(**/.env*)", "Bash(git push --force)"] },
      }),
    };
    // The agent's own settings.json comes after the managed file here: the
    // fallback must still end up in it.
    const userSettings = {
      path: "home/.claude/settings.json",
      content: JSON.stringify({ model: "m" }),
    };
    const encoded = Buffer.from(JSON.stringify([managed, ...files])).toString("base64");
    const encodedWithSettings = Buffer.from(
      JSON.stringify([managed, userSettings, ...files]),
    ).toString("base64");

    it("go to the managed directory when the image has one the agent may write", () => {
      const dir = mkdtempSync(join(tmpdir(), "optio-setup-"));
      try {
        const out = run(
          {
            OPTIO_SETUP_FILES: encoded,
            OPTIO_CLAUDE_MANAGED_DIR: join(dir, "etc-claude-code"),
            OPTIO_AGENT_HOME_DIR: join(dir, "home"),
          },
          dir,
        );
        expect(
          JSON.parse(readFileSync(join(dir, "etc-claude-code/managed-settings.json"), "utf8")),
        ).toEqual(JSON.parse(managed.content));
        expect(out).not.toContain("predates the agent policy");
        expect(() => statSync(join(dir, "home/.claude/settings.json"))).toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("on a pod from before the agent policy, go to the agent's own settings and the run goes on", () => {
      const dir = mkdtempSync(join(tmpdir(), "optio-setup-"));
      try {
        // No directory can be made there (its parent is a file), as in an old image.
        writeFileSync(join(dir, "not-a-dir"), "");
        mkdirSync(join(dir, "home/.claude"), { recursive: true });
        writeFileSync(
          join(dir, "home/.claude/settings.json"),
          JSON.stringify({
            model: "m",
            permissions: { deny: ["Read(**/.env*)"], allow: ["Bash(ls)"] },
          }),
        );
        const out = run(
          {
            OPTIO_SETUP_FILES: encoded,
            OPTIO_CLAUDE_MANAGED_DIR: join(dir, "not-a-dir/claude-code"),
            OPTIO_AGENT_HOME_DIR: join(dir, "home"),
          },
          dir,
        );
        expect(out).toContain("this pod predates the agent policy");
        expect(JSON.parse(readFileSync(join(dir, "home/.claude/settings.json"), "utf8"))).toEqual({
          model: "m",
          permissions: { deny: ["Read(**/.env*)", "Bash(git push --force)"], allow: ["Bash(ls)"] },
        });
        // The other files are still written after it.
        expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe('{"mcpServers":{}}');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("still reach the agent's settings when its settings.json is written after them", () => {
      const dir = mkdtempSync(join(tmpdir(), "optio-setup-"));
      try {
        writeFileSync(join(dir, "not-a-dir"), "");
        run(
          {
            OPTIO_SETUP_FILES: encodedWithSettings,
            OPTIO_CLAUDE_MANAGED_DIR: join(dir, "not-a-dir/claude-code"),
            OPTIO_AGENT_HOME_DIR: join(dir, "home"),
          },
          dir,
        );
        expect(JSON.parse(readFileSync(join(dir, "home/.claude/settings.json"), "utf8"))).toEqual({
          model: "m",
          permissions: { deny: ["Read(**/.env*)", "Bash(git push --force)"] },
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("makes sensitive files owner-only, and keeps every file out of the checkout's git", () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-setup-"));
    try {
      execFileSync("git", ["init", "-q", dir]);
      const sensitive = [...files, { path: "gsa-key.json", content: "{}", sensitive: true }];
      run({ OPTIO_SETUP_FILES: Buffer.from(JSON.stringify(sensitive)).toString("base64") }, dir);
      expect(statSync(join(dir, "gsa-key.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, ".mcp.json")).mode & 0o777).toBe(0o644);
      // Nothing Optio wrote shows up for `git add -A`, and a second run adds no duplicates.
      const status = () =>
        execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
          cwd: dir,
          encoding: "utf8",
        });
      expect(status()).toBe("");
      run({ OPTIO_SETUP_FILES: Buffer.from(JSON.stringify(sensitive)).toString("base64") }, dir);
      const exclude = readFileSync(join(dir, ".git/info/exclude"), "utf8");
      expect(exclude.split("\n").filter((l) => l === "/.mcp.json")).toHaveLength(1);
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

  it("installs MCP servers first, and a failed install only warns", () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-setup-"));
    try {
      const out = run(
        {
          OPTIO_MCP_INSTALL_COMMANDS: "echo installed > mcp && false",
          OPTIO_WORK_SETUP_COMMANDS: "cat mcp > after",
        },
        dir,
      );
      expect(out).toMatch(/MCP server install failed/);
      expect(readFileSync(join(dir, "after"), "utf8")).toBe("installed\n");
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
  /** An origin repo with a `dev` and a `release` branch, and a runner for the script. */
  function setup(root: string) {
    const git = (args: string[], cwd = root) =>
      execFileSync("git", args, { cwd, env: { ...process.env, HOME: root }, stdio: "pipe" });
    const repo = (name: string) => {
      const origin = join(root, name);
      git(["init", "-q", "-b", "dev", origin]);
      const commit = (m: string) =>
        git(
          ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", m],
          origin,
        );
      commit("one");
      git(["branch", "release"], origin);
      return origin;
    };
    const checkout = join(root, "checkout");
    const run = (url: string, branch: string) =>
      execFileSync(
        "bash",
        [
          "-c",
          [
            ...buildEnvExports({ OPTIO_REPO_URL: url, OPTIO_REPO_BRANCH: branch }),
            ...CHECKOUT_REPO,
            `cd ${checkout}`,
            "git rev-parse --abbrev-ref HEAD",
          ]
            .join("\n")
            .replaceAll(POOLED_CHECKOUT_DIR, checkout),
        ],
        {
          cwd: root,
          encoding: "utf8",
          // Its own HOME: the script configures git globally, as in a pod.
          env: { ...process.env, HOME: root },
          stdio: ["ignore", "pipe", "pipe"],
        },
      )
        .trim()
        .split("\n")
        .pop();
    return { git, repo, checkout, run };
  }

  it("clones the repo at its branch once, then only fetches — the agent's changes stay", () => {
    const root = mkdtempSync(join(tmpdir(), "optio-checkout-"));
    try {
      const { repo, checkout, run, git } = setup(root);
      const origin = repo("origin");
      expect(run(origin, "dev")).toBe("dev");
      writeFileSync(join(checkout, "agent-notes.md"), "note\n");
      // The agent's own branch stays checked out between turns.
      git(["checkout", "-q", "-b", "agent/fix"], checkout);
      expect(run(origin, "dev")).toBe("agent/fix");
      expect(readFileSync(join(checkout, "agent-notes.md"), "utf8")).toBe("note\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("follows the work to another branch, and to another repo", () => {
    const root = mkdtempSync(join(tmpdir(), "optio-checkout-"));
    try {
      const { repo, checkout, run } = setup(root);
      const first = repo("first");
      expect(run(first, "dev")).toBe("dev");
      expect(run(first, "release")).toBe("release");
      const second = repo("second");
      expect(run(second, "dev")).toBe("dev");
      expect(
        execFileSync("git", ["remote", "get-url", "origin"], {
          cwd: checkout,
          encoding: "utf8",
        }).trim(),
      ).toBe(second);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("WRITE_SETUP_FILES — a repo's own config", () => {
  const encoded = (files: unknown[]) => Buffer.from(JSON.stringify(files)).toString("base64");
  const write = (files: unknown[], dir: string) =>
    runBash(
      [...buildEnvExports({ OPTIO_SETUP_FILES: encoded(files) }), ...WRITE_SETUP_FILES].join("\n"),
      dir,
    );

  it("merges a `merge: json` file into the object already there, one level into shared objects", () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-merge-"));
    try {
      writeFileSync(
        join(dir, "mcp.json"),
        JSON.stringify({ mcpServers: { theirs: { command: "t" } }, other: 1 }),
      );
      writeFileSync(join(dir, "notes.json"), "not json");
      write(
        [
          {
            path: "mcp.json",
            content: JSON.stringify({ mcpServers: { ours: { command: "o" } } }),
            merge: "json",
            sensitive: true,
          },
          // No file there yet: written as is.
          { path: "fresh.json", content: '{"a":1}', merge: "json" },
          // Not JSON there: replaced.
          { path: "notes.json", content: '{"b":2}', merge: "json" },
        ],
        dir,
      );
      expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"))).toEqual({
        mcpServers: { theirs: { command: "t" }, ours: { command: "o" } },
        other: 1,
      });
      expect(statSync(join(dir, "mcp.json")).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(dir, "fresh.json"), "utf8"))).toEqual({ a: 1 });
      expect(JSON.parse(readFileSync(join(dir, "notes.json"), "utf8"))).toEqual({ b: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a tracked file it wrote over never shows as a change the agent could commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "optio-tracked-"));
    try {
      const git = (args: string[]) =>
        execFileSync("git", args, {
          cwd: dir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      git(["init", "-q"]);
      git(["config", "user.email", "t@t"]);
      git(["config", "user.name", "t"]);
      writeFileSync(join(dir, "theirs.json"), '{"mcpServers":{"theirs":{"command":"t"}}}');
      git(["add", "."]);
      git(["commit", "-q", "-m", "theirs"]);
      write(
        [
          {
            path: "theirs.json",
            content: '{"mcpServers":{"ours":{"command":"o","env":{"TOKEN":"s3cret"}}}}',
            merge: "json",
            sensitive: true,
          },
          { path: ".mcp.json", content: "{}" },
        ],
        dir,
      );
      expect(readFileSync(join(dir, "theirs.json"), "utf8")).toContain("s3cret");
      expect(git(["status", "--porcelain", "--untracked-files=all"])).toBe("");
      git(["add", "-A"]);
      expect(git(["diff", "--cached", "--name-only"])).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildPooledStartScript (the run protocol)", () => {
  const runId = "0f2e1c1a-1111-4222-8333-444444444444";
  const base = {
    env: { A: "1" },
    runId,
    workDir: "/workspace/turns/t1",
    agentCommand: ["run-agent"],
  };

  it("does the pooled setup, then hands the agent to the supervisor in the run's home", () => {
    const script = buildPooledStartScript(base);
    expect(script).toContain(`mkdir -p '/workspace/turns/t1'`);
    expect(script).toContain(`cd '/workspace/turns/t1'`);
    expect(script.indexOf(WRITE_SETUP_FILES[0])).toBeLessThan(script.indexOf("run-agent"));
    expect(script.indexOf(RUN_WORK_SETUP_COMMANDS[0])).toBeLessThan(script.indexOf("run-agent"));
    expect(script).toContain(
      superviseAgent(`/home/agent/optio/runs/${runId}`, ["run-agent"]).join("\n"),
    );
    expect(script.trim().endsWith(`echo "${RUN_STARTED_MARKER}:$_optio_sup"`)).toBe(true);
  });

  it("keeps the run lock, refuses a second start of a live run, and never traps or removes the home", () => {
    const script = buildPooledStartScript(base);
    expect(script).toMatch(/exec 7>\/workspace\/\.run-[0-9a-f]+\.lock\nflock -n 7/);
    expect(script).toContain(`if optio_run_pid '/home/agent/optio/runs/${runId}' >/dev/null; then`);
    expect(script).toContain("optio_run_pid() {");
    expect(script).toContain(`read -r _optio_pid _optio_start < "$1/${RUN_FILES.pid}"`);
    expect(script).not.toContain("trap '");
    expect(script).not.toContain("__OPTIO_RUN_EXIT__");
    // Nothing removes the run home (only a previous attempt's moved-aside files go).
    expect(script).not.toMatch(/rm -rf '\/home\/agent\/optio\/runs\/[^.']*'/);
    expect(script).not.toContain('rm -rf "$OPTIO_RUN_DIR"');
    expect(script.match(/rm -rf/g)).toEqual(["rm -rf"]);
    // The exec script's inline agent + exit line are not here.
    expect(script).not.toContain("AGENT_EXIT=$?");
  });

  it("with a repo, works in the pod's one checkout of it", () => {
    const script = buildPooledStartScript({ ...base, checkout: true });
    expect(script).toContain(CHECKOUT_REPO.join("\n"));
    expect(script).toContain(`cd '${POOLED_CHECKOUT_DIR}'`);
  });

  it("re-exports the protocol's pieces beside the other script fragments", () => {
    expect(STDIN_EOF_SENTINEL).toBe("__OPTIO_STDIN_EOF__");
    expect(attachRunScript("/home/agent/optio/runs/x", 0)).toContain("tail -c +1 ");
    expect(deliverStdinScript("/home/agent/optio/runs/x", 3)).toContain("head -c 3 >>");
    expect(killRunScript("/home/agent/optio/runs/x", "TERM")).toContain("kill -TERM");
  });
});

describe("the bot identity a pod commits as", () => {
  const commitAs = (env: Record<string, string>) => {
    const { name, email } = gitBotIdentity();
    return execFileSync("bash", ["-c", `echo "${name} <${email}>"`], {
      env: { PATH: process.env.PATH ?? "", ...env },
    })
      .toString()
      .trim();
  };

  it("is upstream's chain with no GIT_BOT_*: the GitHub App's bot, else Optio Agent", () => {
    vi.stubEnv("GIT_BOT_NAME", "");
    vi.stubEnv("GIT_BOT_EMAIL", "");
    try {
      expect(commitAs({})).toBe("Optio Agent <optio-agent@noreply.github.com>");
      expect(commitAs({ GITHUB_APP_BOT_NAME: "app[bot]", GITHUB_APP_BOT_EMAIL: "1+app@x" })).toBe(
        "app[bot] <1+app@x>",
      );
      // Nothing for repo-init.sh to read: it uses the same chain.
      expect(gitBotEnv()).toEqual({});
      // Whatever git platforms the deployment offers.
      vi.stubEnv("OPTIO_GIT_PLATFORMS", "gitlab");
      expect(commitAs({})).toBe("Optio Agent <optio-agent@noreply.github.com>");
      expect(gitBotEnv()).toEqual({});
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is GIT_BOT_NAME / GIT_BOT_EMAIL when the deployment sets them, over the GitHub App's bot", () => {
    vi.stubEnv("GIT_BOT_NAME", "Build Bot");
    vi.stubEnv("GIT_BOT_EMAIL", "bot@example.com");
    try {
      const env = gitBotEnv();
      expect(env).toEqual({ GIT_BOT_NAME: "Build Bot", GIT_BOT_EMAIL: "bot@example.com" });
      expect(
        commitAs({ ...env, GITHUB_APP_BOT_NAME: "app[bot]", GITHUB_APP_BOT_EMAIL: "1+app@x" }),
      ).toBe("Build Bot <bot@example.com>");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
