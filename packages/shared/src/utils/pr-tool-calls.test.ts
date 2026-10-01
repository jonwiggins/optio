import { describe, it, expect } from "vitest";
import {
  branchBelongsToTask,
  prCreatingCommand,
  prCreatingCommandCount,
  prCreatingMcpTool,
  prUrlFromToolResult,
  prsFromToolCall,
  prsFromToolCalls,
  prsFromTranscript,
  prsFromToolResult,
  shellCommandFromInput,
  splitShellCommands,
  PrToolCallTracker,
} from "./pr-tool-calls.js";

const TASK = "0b5c2a8e-1111-4222-8333-944455556666";

describe("splitShellCommands", () => {
  it("splits compound commands and strips quotes", () => {
    expect(
      splitShellCommands(`cd /w && git push -u origin HEAD; gh pr create --title 'a b' | tee x`),
    ).toEqual([
      ["cd", "/w"],
      ["git", "push", "-u", "origin", "HEAD"],
      ["gh", "pr", "create", "--title", "a b"],
      ["tee", "x"],
    ]);
  });

  it("finds commands inside $(…) and backticks, including inside double quotes", () => {
    const cmds = splitShellCommands(`URL="$(gh pr create --fill)"; echo \`gh pr list\``);
    expect(cmds).toContainEqual(["gh", "pr", "create", "--fill"]);
    expect(cmds).toContainEqual(["gh", "pr", "list"]);
  });

  it("skips heredoc bodies", () => {
    const script = `gh pr view 1 --json body <<'EOF'\ngh pr create --title nope\nEOF\necho done`;
    const cmds = splitShellCommands(script);
    expect(cmds).not.toContainEqual(expect.arrayContaining(["create"]));
    expect(cmds).toContainEqual(["echo", "done"]);
  });

  it("treats 2>&1 as a redirect, not a background separator", () => {
    expect(splitShellCommands("gh pr create --fill 2>&1")).toEqual([
      ["gh", "pr", "create", "--fill", "2"],
    ]);
  });
});

describe("prCreatingCommand", () => {
  it.each([
    "gh pr create --fill",
    "gh pr new --title x --body y",
    "gh -R o/r pr create --fill",
    "gh pr create --repo o/r --title 'x'",
    "git add -A && git commit -m 'feat: x' && git push -u origin HEAD && gh pr create --fill",
    `gh pr create --title "T" --body "$(cat <<'OPTIO_PR_EOF'\n## What changed\ngh pr view 3\nOPTIO_PR_EOF\n)"`,
    `PR_URL=$(gh pr create --fill) && echo "$PR_URL"`,
    `URL="$(gh pr create --fill)"`,
    "GH_TOKEN=x gh pr create --fill",
    "env GH_PROMPT_DISABLED=1 gh pr create --fill",
    "/usr/local/bin/gh pr create --fill",
    "bash -lc 'gh pr create --fill'",
    "glab mr create --fill --yes",
    "glab mr new -f",
    "git push -o merge_request.create -o merge_request.target=main origin HEAD",
    "git push --push-option=merge_request.create origin HEAD",
    "git push origin HEAD -o merge_request.create",
    "hub pull-request -m 'x'",
    "gh api repos/o/r/pulls -X POST -f title=x -f head=b -f base=main",
    "gh api --method POST /repos/o/r/pulls -f title=x",
    "gh api repos/o/r/pulls -f title=x -f head=b -f base=main",
    "gh api -XPOST repos/o/r/pulls --input body.json",
    `gh api graphql -f query='mutation { createPullRequest(input: {}) { pullRequest { url } } }'`,
    "aws codecommit create-pull-request --title x --targets repositoryName=r,sourceReference=b",
    "aws --region us-east-1 codecommit create-pull-request --title x",
  ])("matches %s", (cmd) => {
    expect(prCreatingCommand(cmd)).toBe(true);
  });

  it.each([
    "gh pr view 812",
    "gh pr list --state open",
    "gh pr checkout 812",
    "gh pr status",
    "gh pr view 812 --json url",
    "gh api repos/o/r/pulls",
    "gh api repos/o/r/pulls?head=o:b",
    "gh api repos/o/r/pulls/5/comments -f body=x",
    "gh api -X GET repos/o/r/pulls -f state=open",
    "gh api graphql -f query='{ repository { pullRequests { nodes { url } } } }'",
    "glab mr list",
    "glab mr view 3",
    "git push -u origin HEAD",
    "git push -o ci.skip origin HEAD",
    "echo 'gh pr create --fill'",
    "echo gh pr create",
    "# gh pr create --fill",
    "grep -r 'gh pr create' docs",
    "aws codecommit list-pull-requests --repository-name r",
    "aws codecommit get-pull-request --pull-request-id 3",
    "hub browse",
  ])("does not match %s", (cmd) => {
    expect(prCreatingCommand(cmd)).toBe(false);
  });

  it("counts every create in a compound command", () => {
    expect(prCreatingCommandCount("gh pr create --fill && gh pr create --head x --fill")).toBe(2);
  });
});

describe("prCreatingMcpTool", () => {
  it.each([
    "mcp__github__create_pull_request",
    "mcp__my-gh__create_pull_request",
    "create_pull_request",
    "github.create_pull_request",
    "mcp__gitlab__create_merge_request",
    "createPullRequest",
  ])("matches %s", (name) => expect(prCreatingMcpTool(name)).toBe(true));
  it.each([
    "mcp__github__get_pull_request",
    "mcp__github__list_pull_requests",
    "Bash",
    "create_pull_request_review",
  ])("does not match %s", (name) => expect(prCreatingMcpTool(name)).toBe(false));
});

describe("shellCommandFromInput", () => {
  it("reads command / cmd fields, argv arrays, JSON strings, and code mode", () => {
    expect(shellCommandFromInput({ command: "gh pr create" })).toBe("gh pr create");
    expect(shellCommandFromInput({ cmd: "ls" })).toBe("ls");
    expect(shellCommandFromInput({ command: ["bash", "-lc", "gh pr create --fill"] })).toBe(
      "gh pr create --fill",
    );
    expect(shellCommandFromInput(['{"command":"gh pr create"}'][0])).toBe("gh pr create");
    expect(shellCommandFromInput('{"command":"gh pr create --title \\"x\\" --bo')).toBe(
      'gh pr create --title "x" --bo',
    );
    expect(shellCommandFromInput('tools.exec_command({cmd: "gh pr create --fill"})')).toBe(
      "gh pr create --fill",
    );
    expect(shellCommandFromInput(null)).toBeNull();
  });
});

describe("prsFromToolResult", () => {
  it("reads the URL gh pr create prints", () => {
    const out =
      "Creating pull request for optio/task-x into main in o/r\n\nhttps://github.com/o/r/pull/42\n";
    expect(prUrlFromToolResult(out)).toBe("https://github.com/o/r/pull/42");
  });

  it("ignores /pull/new/ suggestion links and API URLs", () => {
    const out =
      "remote: Create a pull request for 'b' on GitHub by visiting:\nremote: https://github.com/o/r/pull/new/b\nhttps://api.github.com/repos/o/r/pulls/3";
    expect(prsFromToolResult(out)).toEqual([]);
  });

  it("reads GitLab MR URLs from push output", () => {
    const out =
      "remote: View merge request for b:\nremote:   https://gitlab.com/g/sub/r/-/merge_requests/7\n";
    expect(prUrlFromToolResult(out)).toBe("https://gitlab.com/g/sub/r/-/merge_requests/7");
  });

  it("reads html_url from MCP JSON, never URLs in the body", () => {
    const json = JSON.stringify({
      number: 9,
      url: "https://api.github.com/repos/o/r/pulls/9",
      html_url: "https://github.com/o/r/pull/9",
      body: "Follows https://github.com/o/r/pull/3",
    });
    expect(prsFromToolResult(json)).toEqual([
      { url: "https://github.com/o/r/pull/9", codecommit: null },
    ]);
    // MCP content wrapper
    const wrapped = JSON.stringify([{ type: "text", text: json }]);
    expect(prUrlFromToolResult(wrapped)).toBe("https://github.com/o/r/pull/9");
  });

  it("reads GitLab web_url and GraphQL results", () => {
    expect(
      prUrlFromToolResult(
        JSON.stringify({ iid: 4, web_url: "https://gitlab.com/g/r/-/merge_requests/4" }),
      ),
    ).toBe("https://gitlab.com/g/r/-/merge_requests/4");
    expect(
      prUrlFromToolResult(
        JSON.stringify({
          data: { createPullRequest: { pullRequest: { url: "https://github.com/o/r/pull/5" } } },
        }),
      ),
    ).toBe("https://github.com/o/r/pull/5");
  });

  it("reads a CodeCommit create-pull-request result", () => {
    const json = JSON.stringify({
      pullRequest: { pullRequestId: "12", pullRequestTargets: [{ repositoryName: "r" }] },
    });
    expect(prsFromToolResult(json)).toEqual([
      { url: null, codecommit: { pullRequestId: 12, repositoryName: "r" } },
    ]);
  });

  it("keeps the last URL per create", () => {
    const out = "see https://github.com/o/r/pull/1\nhttps://github.com/o/r/pull/2";
    expect(prsFromToolResult(out).map((p) => p.url)).toEqual(["https://github.com/o/r/pull/2"]);
    expect(prsFromToolResult(out, 2).map((p) => p.url)).toEqual([
      "https://github.com/o/r/pull/1",
      "https://github.com/o/r/pull/2",
    ]);
  });
});

describe("prsFromToolCall", () => {
  it("adopts the URL from a gh pr create result", () => {
    expect(
      prsFromToolCall({
        toolName: "Bash",
        input: { command: "gh pr create --fill" },
        result: "https://github.com/o/r/pull/42",
        isError: false,
      }),
    ).toEqual([
      {
        url: "https://github.com/o/r/pull/42",
        codecommit: null,
        toolName: "Bash",
        alreadyExisted: false,
      },
    ]);
  });

  it("adopts nothing from gh pr view, even with a URL in its output", () => {
    expect(
      prsFromToolCall({
        toolName: "Bash",
        input: { command: "gh pr view 812" },
        result: "title: x\nurl: https://github.com/o/r/pull/812",
        isError: false,
      }),
    ).toEqual([]);
  });

  it("counts 'already exists' as this work's PR, even as an error", () => {
    const [m] = prsFromToolCall({
      toolName: "Bash",
      input: { command: "gh pr create --fill" },
      result:
        'a pull request for branch "optio/task-x" into branch "main" already exists:\nhttps://github.com/o/r/pull/8',
      isError: true,
    });
    expect(m).toMatchObject({ url: "https://github.com/o/r/pull/8", alreadyExisted: true });
  });

  it("adopts nothing from a failed call or one without a URL", () => {
    expect(
      prsFromToolCall({
        toolName: "Bash",
        input: { command: "gh pr create --fill" },
        result: "GraphQL: https://github.com/o/r/pull/3 is not mergeable",
        isError: true,
      }),
    ).toEqual([]);
    expect(
      prsFromToolCall({
        toolName: "Bash",
        input: { command: "gh pr create --fill" },
        result: "no commits",
        isError: false,
      }),
    ).toEqual([]);
    expect(
      prsFromToolCall({
        toolName: "Bash",
        input: { command: "gh pr create" },
        result: null,
        isError: false,
      }),
    ).toEqual([]);
  });

  it("adopts an MCP create_pull_request result", () => {
    const [m] = prsFromToolCall({
      toolName: "mcp__github__create_pull_request",
      input: { owner: "o", repo: "r", title: "x", head: "b", base: "main" },
      result: JSON.stringify({ html_url: "https://github.com/o/r/pull/10" }),
      isError: false,
    });
    expect(m.url).toBe("https://github.com/o/r/pull/10");
  });

  it("de-duplicates across calls", () => {
    const call = {
      toolName: "Bash",
      input: { command: "gh pr create --fill" },
      result: "https://github.com/o/r/pull/1",
      isError: false,
    };
    expect(prsFromToolCalls([call, call])).toHaveLength(1);
  });
});

describe("prsFromTranscript", () => {
  it("pairs tool_use and tool_result by id and ignores mentions", () => {
    const entries = [
      {
        kind: "text",
        text: "See https://github.com/o/r/pull/812",
        detail: null,
        toolName: null,
        toolUseId: null,
        isError: false,
      },
      {
        kind: "tool_use",
        text: "$ gh pr view 812",
        detail: '{"command":"gh pr view 812"}',
        toolName: "Bash",
        toolUseId: "a",
        isError: false,
      },
      {
        kind: "tool_use",
        text: "$ gh pr create",
        detail: '{"command":"gh pr create --fill"}',
        toolName: "Bash",
        toolUseId: "b",
        isError: false,
      },
      {
        kind: "tool_result",
        text: "https://github.com/o/r/pull/812",
        detail: null,
        toolName: null,
        toolUseId: "a",
        isError: false,
      },
      {
        kind: "tool_result",
        text: "https://github.com/o/r/pull/900",
        detail: null,
        toolName: null,
        toolUseId: "b",
        isError: false,
      },
    ];
    expect(prsFromTranscript(entries).map((m) => m.url)).toEqual([
      "https://github.com/o/r/pull/900",
    ]);
  });

  it("reads a Codex code-mode shell call from its summary", () => {
    const entries = [
      {
        kind: "tool_use",
        text: "gh pr create --fill",
        detail: "const r = await tools.exec_command({cmd: 'x'})",
        toolName: "Shell",
        toolUseId: "c",
        isError: false,
      },
      {
        kind: "tool_result",
        text: "https://github.com/o/r/pull/5",
        detail: null,
        toolName: null,
        toolUseId: "c",
        isError: false,
      },
    ];
    expect(prsFromTranscript(entries).map((m) => m.url)).toEqual(["https://github.com/o/r/pull/5"]);
  });
});

describe("PrToolCallTracker", () => {
  it("pairs Claude Code stream-json tool_use with its tool_result", () => {
    const t = new PrToolCallTracker();
    const use = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Opening https://github.com/o/r/pull/812 style PR" },
          { type: "tool_use", id: "tu1", name: "Bash", input: { command: "gh pr create --fill" } },
        ],
      },
    });
    const res = JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            content: [{ type: "text", text: "https://github.com/o/r/pull/77\n" }],
          },
        ],
      },
    });
    expect(t.ingestClaudeLine(use)).toEqual([]);
    expect(t.ingestClaudeLine(res).map((m) => m.url)).toEqual(["https://github.com/o/r/pull/77"]);
    expect(t.ingestClaudeLine(res)).toEqual([]); // result already consumed
    expect(t.matches).toHaveLength(1);
  });

  it("ignores results of non-creating calls", () => {
    const t = new PrToolCallTracker();
    t.ingestClaudeLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "x", name: "Bash", input: { command: "gh pr view 1" } },
          ],
        },
      }),
    );
    expect(
      t.ingestClaudeLine(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "x", content: "https://github.com/o/r/pull/1" },
            ],
          },
        }),
      ),
    ).toEqual([]);
    expect(t.ingestClaudeLine("not json")).toEqual([]);
  });

  it("reads Codex exec --json command and MCP items", () => {
    const t = new PrToolCallTracker();
    const cmd = JSON.stringify({
      type: "item.completed",
      item: {
        id: "i1",
        type: "command_execution",
        command: "bash -lc 'gh pr create --fill'",
        aggregated_output: "https://github.com/o/r/pull/3\n",
        exit_code: 0,
        status: "completed",
      },
    });
    expect(t.ingestCodexLine(cmd).map((m) => m.url)).toEqual(["https://github.com/o/r/pull/3"]);
    const failed = JSON.stringify({
      type: "item.completed",
      item: {
        id: "i2",
        type: "command_execution",
        command: "gh pr create --fill",
        aggregated_output: "https://github.com/o/r/pull/4",
        exit_code: 1,
        status: "failed",
      },
    });
    expect(t.ingestCodexLine(failed)).toEqual([]);
    const mcp = JSON.stringify({
      type: "item.completed",
      item: {
        id: "i3",
        type: "mcp_tool_call",
        server: "github",
        tool: "create_pull_request",
        arguments: {},
        result: {
          content: [{ type: "text", text: '{"html_url":"https://github.com/o/r/pull/6"}' }],
        },
        status: "completed",
      },
    });
    expect(t.ingestCodexLine(mcp).map((m) => m.url)).toEqual(["https://github.com/o/r/pull/6"]);
  });

  it("reads older Codex function_call events", () => {
    const t = new PrToolCallTracker();
    t.ingestCodexLine(
      JSON.stringify({
        type: "function_call",
        name: "shell",
        call_id: "c1",
        arguments: JSON.stringify({ command: ["bash", "-lc", "gh pr create --fill"] }),
      }),
    );
    const out = JSON.stringify({
      type: "function_call_output",
      call_id: "c1",
      output: JSON.stringify({
        output: "https://github.com/o/r/pull/9",
        metadata: { exit_code: 0 },
      }),
    });
    expect(t.ingestCodexLine(out).map((m) => m.url)).toEqual(["https://github.com/o/r/pull/9"]);
  });
});

describe("branchBelongsToTask", () => {
  it("accepts the task branch and branches under it", () => {
    expect(branchBelongsToTask(TASK, `optio/task-${TASK}`)).toBe(true);
    expect(branchBelongsToTask(TASK, `optio/task-${TASK}-docs`)).toBe(true);
    expect(branchBelongsToTask(TASK, `optio/task-${TASK}/docs`)).toBe(true);
    expect(branchBelongsToTask(TASK, `refs/heads/optio/task-${TASK}`)).toBe(true);
  });
  it("rejects other branches", () => {
    expect(branchBelongsToTask(TASK, "optio/task-other")).toBe(false);
    expect(branchBelongsToTask(TASK, `optio/task-${TASK}x`)).toBe(false);
    expect(branchBelongsToTask(TASK, "main")).toBe(false);
    expect(branchBelongsToTask(TASK, null)).toBe(false);
  });
});
