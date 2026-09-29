import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexOutput,
  codexSessionMeta,
  codexThreadIdFromPath,
  describeCodexCall,
  entriesFromCodexLine,
} from "../local/codex-transcript.js";
import {
  CodexSessionFinder,
  findCodexRollout,
  isCodexProcess,
  pickMainRollout,
  processTree,
  type ProcessRow,
} from "../local/codex-sessions.js";
import { TranscriptTracker } from "../local/transcript-tracker.js";
import { readSessionTranscript } from "../local/transcript-backfill.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const THREAD = "019fe95c-6b19-7ab1-a93c-d88ca9d747bc";
const at = "2026-09-28T20:08:47.000Z";
const event = (payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: at, type: "event_msg", payload });
const item = (payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: at, type: "response_item", payload });
const meta = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    timestamp: at,
    type: "session_meta",
    payload: {
      id: THREAD,
      cwd: "/home/dev/optio",
      originator: "codex-tui",
      source: "cli",
      ...extra,
    },
  });

/** One turn as Codex 0.146 writes it: injected context, the prompt twice, a command, a reply. */
const turn = [
  meta(),
  event({ type: "task_started", turn_id: "t1" }),
  item({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/home/dev/optio</cwd>" }],
  }),
  item({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "why is CI red?" }],
  }),
  event({ type: "user_message", message: "why is CI red?", images: [], local_images: [] }),
  event({ type: "agent_reasoning", text: "**Checking the failing job**" }),
  event({ type: "agent_message", message: "Let me look at the logs.", phase: "commentary" }),
  item({
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Let me look at the logs." }],
  }),
  item({
    type: "function_call",
    name: "exec_command",
    arguments: JSON.stringify({ cmd: "gh run view --log-failed", workdir: "/home/dev/optio" }),
    call_id: "call_1",
  }),
  item({
    type: "function_call_output",
    call_id: "call_1",
    output:
      "Chunk ID: 1a2b\nWall time: 1.2 seconds\nProcess exited with code 1\nOriginal token count: 9\nOutput:\nError: lint failed\n",
  }),
  event({ type: "token_count", info: {} }),
  event({ type: "agent_message", message: "Lint fails on `foo.ts`.", phase: "final_answer" }),
];

describe("entriesFromCodexLine", () => {
  it("reads the conversation once: prompts and replies from events, tools from items", () => {
    const entries = turn.flatMap((l) => entriesFromCodexLine(l) ?? []);
    expect(entries.map((e) => [e.role, e.kind, e.text])).toEqual([
      ["user", "text", "why is CI red?"],
      ["assistant", "thinking", "**Checking the failing job**"],
      ["assistant", "text", "Let me look at the logs."],
      ["assistant", "tool_use", "gh run view --log-failed"],
      ["tool", "tool_result", "Error: lint failed\n"],
      ["assistant", "text", "Lint fails on `foo.ts`."],
    ]);
    const [, , , use, result] = entries;
    expect(use).toMatchObject({ toolName: "Shell", toolUseId: "call_1", at });
    expect(use!.detail).toContain('"workdir": "/home/dev/optio"');
    expect(result).toMatchObject({ toolUseId: "call_1", isError: true });
  });

  it("files interruptions, compactions and rollbacks as system turns", () => {
    expect(
      entriesFromCodexLine(event({ type: "turn_aborted", reason: "interrupted" })),
    ).toMatchObject([{ role: "system", source: "interrupt", text: "Turn interrupted" }]);
    expect(entriesFromCodexLine(event({ type: "context_compacted" }))).toMatchObject([
      { role: "system", source: "compact" },
    ]);
    expect(entriesFromCodexLine(event({ type: "thread_rolled_back", num_turns: 2 }))).toMatchObject(
      [{ role: "system", source: "rewind", text: "Rolled back 2 turns" }],
    );
  });

  it("names patches, plans, searches, code-mode cells and agents", () => {
    expect(
      describeCodexCall(
        "apply_patch",
        "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: b.md\n",
      ),
    ).toEqual({ toolName: "Patch", summary: "src/a.ts, b.md" });
    expect(
      describeCodexCall("shell", JSON.stringify({ command: ["bash", "-lc", "ls -la"] })),
    ).toEqual({ toolName: "Shell", summary: "ls -la" });
    expect(
      describeCodexCall(
        "exec",
        'const r = await tools.exec_command({"cmd":"rg foo","workdir":"/x"}); text(r)',
      ),
    ).toEqual({ toolName: "Shell", summary: "rg foo" });
    expect(
      describeCodexCall(
        "exec",
        'const q = await tools.web__run({search_query:[{q:"codex hooks"}]});',
      ),
    ).toEqual({ toolName: "WebSearch", summary: "codex hooks" });
    expect(
      describeCodexCall("spawn_agent", JSON.stringify({ task_name: "audit", message: "x" })),
    ).toEqual({ toolName: "Agent", summary: "spawn agent · audit" });
    expect(
      entriesFromCodexLine(
        item({ type: "web_search_call", action: { type: "search", query: "xterm reflow" } }),
      ),
    ).toMatchObject([{ kind: "tool_use", toolName: "WebSearch", text: "xterm reflow" }]);
  });

  it("strips Codex's output framing and reads the exit code", () => {
    expect(codexOutput('{"output":"Success. Updated a.ts\\n","metadata":{"exit_code":0}}')).toEqual(
      {
        text: "Success. Updated a.ts\n",
        isError: false,
      },
    );
    expect(codexOutput("Exit code: 0\nWall time: 0 seconds\nOutput:\nok\n")).toEqual({
      text: "ok\n",
      isError: false,
    });
    expect(
      codexOutput([
        { type: "input_text", text: "Script completed\nWall time 1.0 seconds\nOutput:\n" },
        { type: "input_text", text: "/home/dev/optio" },
        { type: "input_image", image_url: "data:" },
      ]),
    ).toEqual({ text: "/home/dev/optio\n[image]", isError: false });
    expect(codexOutput("apply_patch verification failed: no such line").isError).toBe(true);
  });

  it("knows a subagent's thread from the person's", () => {
    expect(codexSessionMeta(meta())).toEqual({
      id: THREAD,
      cwd: "/home/dev/optio",
      subagent: false,
    });
    expect(
      codexSessionMeta(meta({ source: { subagent: { thread_spawn: {} } }, parent_thread_id: "p" })),
    ).toMatchObject({ subagent: true });
    expect(
      codexThreadIdFromPath(`/x/sessions/2026/09/28/rollout-2026-09-28T20-08-47-${THREAD}.jsonl`),
    ).toBe(THREAD);
  });
});

/** A CODEX_HOME with one rollout under the day its UUIDv7 thread id says. */
function codexHome(
  lines: string[],
  threadId = THREAD,
  cwdLine = meta(),
): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "optio-codex-"));
  dirs.push(home);
  const day = new Date(parseInt(threadId.replace(/-/g, "").slice(0, 12), 16));
  const dir = join(
    home,
    "sessions",
    String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, "0"),
    String(day.getDate()).padStart(2, "0"),
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-08-09T19-49-35-${threadId}.jsonl`);
  writeFileSync(path, [cwdLine, ...lines].join("\n") + "\n");
  return { home, path };
}

describe("Codex rollouts", () => {
  it("are found by thread id and read into the same entries the live tracker sends", () => {
    const { home, path } = codexHome(turn.slice(1));
    expect(findCodexRollout(THREAD, home)).toBe(path);
    expect(findCodexRollout("not-a-thread", home)).toBeNull();
    const read = readSessionTranscript({
      agent: "codex",
      sessionId: THREAD,
      allowedDirs: ["/home/dev"],
      codexHome: home,
    });
    expect(read.error).toBeUndefined();
    expect(read.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    // The spawn's prompt reads as the prompt, as it did when streamed.
    expect(
      readSessionTranscript({
        agent: "codex",
        sessionId: THREAD,
        allowedDirs: ["/home/dev"],
        codexHome: home,
        launchPrompt: "why is CI red?",
      }).entries[0],
    ).toMatchObject({ role: "user", source: "prompt" });
    expect(
      readSessionTranscript({
        agent: "codex",
        sessionId: THREAD,
        allowedDirs: ["/srv"],
        codexHome: home,
      }).error,
    ).toMatch(/outside/);
  });

  it("stream incrementally, tagging the session's launch prompt", () => {
    const { path } = codexHome([]);
    const tracker = new TranscriptTracker();
    tracker.setLaunchPrompt("term", "why is CI red?");
    expect(tracker.update("term", path, "codex")).toEqual([]);
    appendFileSync(path, turn.slice(1, 6).join("\n") + "\n");
    expect(tracker.update("term", path, "codex").map((e) => [e.seq, e.role, e.source])).toEqual([
      [1, "user", "prompt"],
      [2, "assistant", null],
    ]);
    appendFileSync(path, turn.slice(6).join("\n") + "\n");
    expect(tracker.update("term", path, "codex").map((e) => e.seq)).toEqual([3, 4, 5, 6]);
    expect(tracker.paths()).toEqual([["term", path, "codex"]]);
  });
});

describe("CodexSessionFinder", () => {
  const rows: ProcessRow[] = [
    { pid: 100, ppid: 1, comm: "/bin/zsh" },
    {
      pid: 200,
      ppid: 100,
      comm: "/Users/me/.codex/packages/standalone/releases/0.146.0/bin/codex",
    },
    { pid: 300, ppid: 200, comm: "/opt/homebrew/bin/git" },
    { pid: 400, ppid: 1, comm: "/bin/zsh" },
  ];

  it("walks a terminal's process tree for Codex", () => {
    expect(processTree(rows, 100).map((r) => r.pid)).toEqual([100, 200, 300]);
    expect(
      processTree(rows, 100)
        .filter(isCodexProcess)
        .map((r) => r.pid),
    ).toEqual([200]);
    expect(isCodexProcess({ pid: 1, ppid: 0, comm: "node" })).toBe(false);
    expect(isCodexProcess({ pid: 1, ppid: 0, comm: "codex-aarch64-apple-darwin" })).toBe(true);
  });

  it("finds the rollout the terminal's Codex holds, skipping subagent threads", async () => {
    const main = codexHome([]).path;
    const sub = codexHome(
      [],
      "019fefe6-bcfe-74e2-8d90-8cc5e1e63997",
      meta({ source: { subagent: {} } }),
    ).path;
    expect(pickMainRollout([sub, main])).toBe(main);

    let now = 0;
    const opened: number[] = [];
    const finder = new CodexSessionFinder({
      listProcesses: async () => rows,
      openRollouts: async (pid) => {
        opened.push(pid);
        return pid === 200 ? [sub, main] : [];
      },
      now: () => now,
    });
    const terminals = [
      { terminalId: "codex-term", pid: 100 },
      { terminalId: "shell-term", pid: 400 },
    ];
    expect([...(await finder.scan(terminals))]).toEqual([["codex-term", main]]);
    // Known and recent: no second look at its open files.
    now = 5_000;
    expect([...(await finder.scan(terminals))]).toEqual([["codex-term", main]]);
    expect(opened).toEqual([200]);
    // After a while it looks again (a /new starts another rollout).
    now = 20_000;
    await finder.scan(terminals);
    expect(opened).toEqual([200, 200]);
  });
});
