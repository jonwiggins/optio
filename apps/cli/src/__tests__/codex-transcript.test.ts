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
  matchRollout,
  parseElapsed,
  pickMainRollout,
  processTree,
  type ProcessRow,
  type RolloutInfo,
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

  it("reads Codex 0.160's item_completed events, skipping the tool items the response items cover", () => {
    const completed = (item: Record<string, unknown>) =>
      event({ type: "item_completed", thread_id: THREAD, turn_id: "t1", item });
    const lines = [
      completed({
        type: "UserMessage",
        id: "u1",
        content: [{ type: "text", text: "tell me a story", text_elements: [] }],
      }),
      completed({ type: "Reasoning", id: "rs1", summary_text: [], raw_content: [] }),
      completed({
        type: "Reasoning",
        id: "rs2",
        summary_text: ["**Picking a setting**", "A desert fits."],
        raw_content: [],
      }),
      completed({
        type: "AgentMessage",
        id: "m1",
        content: [{ type: "Text", text: "The moon went missing on a Tuesday." }],
      }),
      completed({
        type: "CommandExecution",
        id: "exec-1",
        command: ["/bin/zsh", "-lc", "python3 -c 'print(1)'"],
        status: "completed",
        stdout: "1\n",
      }),
      item({
        type: "custom_tool_call",
        call_id: "call_1",
        name: "exec",
        input: "text(await tools.exec_command({cmd:\"python3 -c 'print(1)'\"}));\n",
      }),
      item({
        type: "custom_tool_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
          { type: "input_text", text: '{"chunk_id":"8","exit_code":0,"output":"1\\n"}' },
        ],
      }),
      event({ type: "task_complete", turn_id: "t1", last_agent_message: "The moon…" }),
      completed({
        type: "UserMessage",
        id: "u2",
        content: [
          { type: "text", text: "and this?" },
          { type: "image", image_url: "data:" },
        ],
      }),
    ];
    const entries = lines.flatMap((l) => entriesFromCodexLine(l) ?? []);
    expect(entries.map((e) => [e.role, e.kind, e.text])).toEqual([
      ["user", "text", "tell me a story"],
      ["assistant", "thinking", "**Picking a setting**\n\nA desert fits."],
      ["assistant", "text", "The moon went missing on a Tuesday."],
      ["assistant", "tool_use", "python3 -c 'print(1)'"],
      ["tool", "tool_result", "1\n"],
      ["user", "text", "and this?\n[1 image]"],
    ]);
    expect(entries[3]).toMatchObject({ toolName: "Shell", toolUseId: "call_1" });
    expect(entries[4]).toMatchObject({ toolUseId: "call_1", isError: false });
    expect(
      codexOutput([
        { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
        { type: "input_text", text: '{"chunk_id":"9","exit_code":2,"output":"boom\\n"}' },
      ]),
    ).toEqual({ text: "boom\n", isError: true });
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

  it("reads ps's elapsed time", () => {
    expect(parseElapsed("22:44:42")).toBe((22 * 3600 + 44 * 60 + 42) * 1000);
    expect(parseElapsed("03-22:27:27")).toBe(((3 * 24 + 22) * 3600 + 27 * 60 + 27) * 1000);
    expect(parseElapsed("05:09")).toBe((5 * 60 + 9) * 1000);
    expect(parseElapsed("-")).toBeNull();
  });

  it("matches a rollout by dir and start when the process holds none open", () => {
    const t0 = Date.parse("2026-10-05T01:15:28.000Z");
    const rollout = (path: string, extra: Partial<RolloutInfo>): RolloutInfo => ({
      path,
      cwd: "/home/dev/optio",
      startedAt: t0 + 1_000,
      modifiedAt: t0 + 60_000,
      subagent: false,
      ...extra,
    });
    const earlier = rollout("/s/earlier.jsonl", {
      startedAt: t0 - 900_000,
      modifiedAt: t0 - 60_000,
    });
    const own = rollout("/s/own.jsonl", {});
    const later = rollout("/s/later.jsonl", { startedAt: t0 + 30_000 });
    const elsewhere = rollout("/s/elsewhere.jsonl", { cwd: "/home/dev/other" });
    const sub = rollout("/s/sub.jsonl", { subagent: true, startedAt: t0 + 500 });
    const all = [later, elsewhere, sub, own, earlier];
    // The session that started with the process, not a later one in the same dir.
    expect(matchRollout(all, "/home/dev/optio/", t0, new Set())).toBe(own.path);
    // Another terminal's is never picked twice.
    expect(matchRollout(all, "/home/dev/optio", t0, new Set([own.path]))).toBe(later.path);
    // A resumed thread: nothing new, but one written to since the process started.
    const resumed = rollout("/s/resumed.jsonl", {
      startedAt: t0 - 900_000,
      modifiedAt: t0 + 5_000,
    });
    expect(matchRollout([earlier, resumed, elsewhere], "/home/dev/optio", t0, new Set())).toBe(
      resumed.path,
    );
    // A codex still at its prompt: no session yet.
    expect(matchRollout([earlier, elsewhere], "/home/dev/optio", t0, new Set())).toBeNull();
  });

  it("follows the app-server daemon's rollouts by dir and start, one per terminal", async () => {
    // Codex 0.160: the TUI under each terminal holds no rollout; a daemon (pid 900) holds all.
    const start1 = Date.parse("2026-08-09T19:49:30.000Z");
    const start2 = start1 + 20_000;
    let now = start1 + 2_000;
    const sessionMeta = (id: string, startedAt: number) =>
      JSON.stringify({
        timestamp: new Date(startedAt + 100).toISOString(),
        type: "session_meta",
        payload: {
          id,
          timestamp: new Date(startedAt).toISOString(),
          cwd: "/home/dev/optio",
          originator: "codex-tui",
          source: "vscode",
        },
      });
    const first = codexHome([], THREAD, sessionMeta(THREAD, start1 + 1_000));
    const dir = first.path.slice(0, first.path.lastIndexOf("/"));
    const SECOND = "019fe95c-6b19-7ab1-a93c-d88ca9d747bd";
    const second = join(dir, `rollout-2026-08-09T19-49-51-${SECOND}.jsonl`);
    const rows: ProcessRow[] = [
      { pid: 900, ppid: 1, comm: "/Users/me/.codex/packages/app-server-daemon/bin/codex" },
      { pid: 100, ppid: 1, comm: "/bin/zsh" },
      { pid: 200, ppid: 100, comm: "codex", startedAt: start1 },
      { pid: 300, ppid: 1, comm: "/bin/zsh" },
      { pid: 400, ppid: 300, comm: "codex", startedAt: start2 },
    ];
    const finder = new CodexSessionFinder({
      listProcesses: async () => rows,
      openRollouts: async () => [],
      now: () => now,
      codexHome: first.home,
    });
    const terminals = [
      { terminalId: "one", pid: 100, dir: "/home/dev/optio" },
      { terminalId: "two", pid: 300, dir: "/home/dev/optio" },
    ];
    // Only the first session exists yet: the first terminal's; the second has none.
    expect([...(await finder.scan(terminals))]).toEqual([["one", first.path]]);
    // The second session appears (started with the second Codex): the second terminal's —
    // and the first keeps its own rather than switching to the newer one.
    now = start2 + 2_000;
    writeFileSync(second, sessionMeta(SECOND, start2 + 1_000) + "\n");
    expect([...(await finder.scan(terminals))]).toEqual([
      ["one", first.path],
      ["two", second],
    ]);
    now = start2 + 30_000;
    expect([...(await finder.scan(terminals))]).toEqual([
      ["one", first.path],
      ["two", second],
    ]);
  });
});
