import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { UsageTracker, parseTranscriptLine } from "../local/usage-tracker.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function transcript(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "optio-usage-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

const turn = (
  id: string,
  usage: Partial<Record<string, number>>,
  extra: Record<string, unknown> = {},
) => ({
  type: "assistant",
  uuid: `u-${id}-${Math.random()}`,
  requestId: `req_${id}`,
  message: {
    id: `msg_${id}`,
    model: "claude-opus-5",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...usage,
    },
  },
  ...extra,
});

describe("parseTranscriptLine", () => {
  it("reads an assistant turn's tokens and model", () => {
    const t = parseTranscriptLine(
      JSON.stringify(turn("1", { input_tokens: 10, output_tokens: 20 })),
    );
    expect(t).toMatchObject({
      key: "msg_1|req_1",
      model: "claude-opus-5",
      tokens: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it("ignores user lines, junk, and turns without usage", () => {
    expect(parseTranscriptLine("not json")).toBeNull();
    expect(parseTranscriptLine(JSON.stringify({ type: "user", message: {} }))).toBeNull();
    expect(
      parseTranscriptLine(JSON.stringify({ type: "assistant", message: { id: "x" } })),
    ).toBeNull();
  });
});

describe("UsageTracker", () => {
  it("sums turns, dedupes per-block repeats, and prices known models", () => {
    const path = transcript([
      { type: "user", message: { role: "user", content: "hi" } },
      turn("a", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 }),
      // Same API call, second content block — identical usage, must not double count.
      turn("a", { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000 }),
      turn("b", { output_tokens: 10, cache_creation_input_tokens: 200 }),
    ]);
    const tracker = new UsageTracker();
    const u = tracker.update("t1", path)!;
    expect(u.turns).toBe(2);
    expect(u.inputTokens).toBe(100);
    expect(u.outputTokens).toBe(60);
    expect(u.cacheReadTokens).toBe(1000);
    expect(u.cacheWriteTokens).toBe(200);
    expect(u.model).toBe("claude-opus-5");
    // opus-5: 100*5 + 60*25 + 1000*0.5 + 200*6.25 = 500+1500+500+1250 = 3750 / 1e6
    expect(u.costUsd).toBeCloseTo(0.00375, 6);
  });

  it("is incremental: a second update only folds appended lines", () => {
    const path = transcript([turn("a", { output_tokens: 5 })]);
    const tracker = new UsageTracker();
    expect(tracker.update("t1", path)!.turns).toBe(1);
    expect(tracker.update("t1", path)).toBeNull();
    appendFileSync(path, JSON.stringify(turn("b", { output_tokens: 7 })) + "\n");
    const u = tracker.update("t1", path)!;
    expect(u.turns).toBe(2);
    expect(u.outputTokens).toBe(12);
  });

  it("copes with a partial trailing line being completed later", () => {
    const path = transcript([turn("a", { output_tokens: 5 })]);
    const full = JSON.stringify(turn("b", { output_tokens: 7 }));
    appendFileSync(path, full.slice(0, 20));
    const tracker = new UsageTracker();
    expect(tracker.update("t1", path)!.turns).toBe(1);
    appendFileSync(path, full.slice(20) + "\n");
    expect(tracker.update("t1", path)!.turns).toBe(2);
  });

  it("reports null cost when a model has no price", () => {
    const path = transcript([
      turn("a", { output_tokens: 5 }, {}),
      {
        ...turn("b", { output_tokens: 5 }),
        message: { id: "msg_b", model: "claude-unknown-9", usage: { output_tokens: 5 } },
      },
    ]);
    const u = new UsageTracker().update("t1", path)!;
    expect(u.turns).toBe(2);
    expect(u.costUsd).toBeNull();
  });

  it("starts over when the terminal switches transcripts", () => {
    const a = transcript([turn("a", { output_tokens: 5 })]);
    const b = transcript([turn("b", { output_tokens: 9 })]);
    const tracker = new UsageTracker();
    tracker.update("t1", a);
    const u = tracker.update("t1", b)!;
    expect(u.turns).toBe(1);
    expect(u.outputTokens).toBe(9);
  });

  it("returns null for a missing transcript and forgets removed terminals", () => {
    const tracker = new UsageTracker();
    expect(tracker.update("t1", "/nonexistent/x.jsonl")).toBeNull();
    const path = transcript([turn("a", { output_tokens: 5 })]);
    tracker.update("t2", path);
    expect(tracker.current("t2")?.turns).toBe(1);
    tracker.remove("t2");
    expect(tracker.current("t2")).toBeNull();
  });
});
