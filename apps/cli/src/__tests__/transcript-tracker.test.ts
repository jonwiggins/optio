import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  TranscriptTracker,
  entriesFromLine,
  summarizeToolInput,
} from "../local/transcript-tracker.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function transcript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "optio-transcript-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

let n = 0;
const line = (type: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type,
  uuid: `u-${++n}`,
  timestamp: "2026-09-19T20:00:00.000Z",
  isSidechain: false,
  message: { role: type, content },
  ...extra,
});

const userPrompt = (text: string) => line("user", text);
const assistantText = (text: string) => line("assistant", [{ type: "text", text }]);
const toolUse = (id: string, name: string, input: unknown) =>
  line("assistant", [{ type: "tool_use", id, name, input }]);
const toolResult = (id: string, content: unknown, isError = false) =>
  line("user", [{ type: "tool_result", tool_use_id: id, content, is_error: isError }]);

describe("entriesFromLine", () => {
  it("keeps prompts, replies, tool calls and results", () => {
    expect(entriesFromLine(JSON.stringify(userPrompt("fix the bug")))).toMatchObject([
      { role: "user", kind: "text", text: "fix the bug", at: "2026-09-19T20:00:00.000Z" },
    ]);
    expect(entriesFromLine(JSON.stringify(assistantText("On it.")))).toMatchObject([
      { role: "assistant", kind: "text", text: "On it." },
    ]);
    expect(
      entriesFromLine(
        JSON.stringify(toolUse("t1", "Bash", { command: "ls -la", description: "List files" })),
      ),
    ).toMatchObject([
      {
        role: "assistant",
        kind: "tool_use",
        toolName: "Bash",
        toolUseId: "t1",
        text: "List files",
        detail: expect.stringContaining('"command": "ls -la"'),
      },
    ]);
    expect(entriesFromLine(JSON.stringify(toolResult("t1", "total 0", true)))).toMatchObject([
      { role: "tool", kind: "tool_result", toolUseId: "t1", text: "total 0", isError: true },
    ]);
  });

  it("flattens tool results given as text blocks", () => {
    expect(
      entriesFromLine(
        JSON.stringify(
          toolResult("t2", [
            { type: "text", text: "line 1" },
            { type: "text", text: "line 2" },
          ]),
        ),
      ),
    ).toMatchObject([{ kind: "tool_result", text: "line 1\nline 2" }]);
  });

  it("keeps non-empty thinking and drops empty blocks", () => {
    expect(
      entriesFromLine(
        JSON.stringify(
          line("assistant", [
            { type: "thinking", thinking: "" },
            { type: "thinking", thinking: "consider X" },
            { type: "text", text: "   " },
          ]),
        ),
      ),
    ).toMatchObject([{ kind: "thinking", text: "consider X" }]);
  });

  it("skips Claude Code's bookkeeping: meta lines, command echoes, sidechains, non-messages", () => {
    expect(
      entriesFromLine(JSON.stringify(userPrompt("<command-name>/model</command-name>"))),
    ).toEqual([]);
    expect(entriesFromLine(JSON.stringify(line("user", "caveat", { isMeta: true })))).toBeNull();
    expect(
      entriesFromLine(
        JSON.stringify(line("assistant", [{ type: "text", text: "sub" }], { isSidechain: true })),
      ),
    ).toBeNull();
    expect(entriesFromLine(JSON.stringify({ type: "ai-title", aiTitle: "x" }))).toBeNull();
    expect(entriesFromLine("not json")).toBeNull();
  });

  it("caps oversized text with a marker", () => {
    const big = "x".repeat(100_000);
    const [entry] = entriesFromLine(JSON.stringify(assistantText(big)))!;
    expect(entry!.text.length).toBeLessThanOrEqual(16 * 1024);
    expect(entry!.text).toMatch(/more characters\)$/);
  });
});

describe("summarizeToolInput", () => {
  it("picks the field that names what the tool did", () => {
    expect(summarizeToolInput("Bash", { command: "npm test" })).toBe("npm test");
    expect(summarizeToolInput("Edit", { file_path: "/a/b.ts", old_string: "x" })).toBe("/a/b.ts");
    expect(summarizeToolInput("Grep", { pattern: "foo", path: "src" })).toBe("foo in src");
    expect(summarizeToolInput("Agent", { description: "Search code", prompt: "..." })).toBe(
      "Search code",
    );
    expect(summarizeToolInput("mcp__x__y", { a: 1 })).toBe('{"a":1}');
  });

  it("collapses whitespace and bounds the length", () => {
    expect(summarizeToolInput("Bash", { command: "a\n   b\tc" })).toBe("a b c");
    expect(summarizeToolInput("Bash", { command: "z".repeat(1000) }).length).toBeLessThanOrEqual(
      400,
    );
  });
});

describe("TranscriptTracker", () => {
  it("numbers entries monotonically and only returns what's new", () => {
    const tracker = new TranscriptTracker();
    const path = transcript([userPrompt("hi"), assistantText("hello")]);

    const first = tracker.update("term", path);
    expect(first.map((e) => [e.seq, e.role, e.text])).toEqual([
      [1, "user", "hi"],
      [2, "assistant", "hello"],
    ]);
    expect(tracker.update("term", path)).toEqual([]);

    appendFileSync(
      path,
      JSON.stringify(toolUse("t1", "Read", { file_path: "/x" })) +
        "\n" +
        JSON.stringify(toolResult("t1", "contents")) +
        "\n",
    );
    const next = tracker.update("term", path);
    expect(next.map((e) => [e.seq, e.kind])).toEqual([
      [3, "tool_use"],
      [4, "tool_result"],
    ]);
    expect(tracker.paths()).toEqual([["term", path]]);
  });

  it("does not repeat entries when the file is rewritten from the top", () => {
    const tracker = new TranscriptTracker();
    const lines = [userPrompt("hi"), assistantText("hello")];
    const path = transcript(lines);
    expect(tracker.update("term", path)).toHaveLength(2);
    // Rewritten shorter (offset resets), then the same lines plus one more.
    writeFileSync(path, "");
    writeFileSync(
      path,
      [...lines, assistantText("more")].map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    expect(tracker.update("term", path).map((e) => [e.seq, e.text])).toEqual([[3, "more"]]);
  });

  it("continues numbering across a new transcript path (resume in the same terminal)", () => {
    const tracker = new TranscriptTracker();
    const a = transcript([userPrompt("one")]);
    const b = transcript([userPrompt("two")]);
    expect(tracker.update("term", a).map((e) => e.seq)).toEqual([1]);
    expect(tracker.update("term", b).map((e) => [e.seq, e.text])).toEqual([[2, "two"]]);
  });

  it("returns nothing for a transcript that does not exist yet", () => {
    const tracker = new TranscriptTracker();
    expect(tracker.update("term", "/nonexistent/transcript.jsonl")).toEqual([]);
  });
});
