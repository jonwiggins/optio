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

const codexContext = (model: string, service_tier?: string) => ({
  type: "turn_context",
  payload: { model, service_tier },
});
const codexUsage = (input: number, cached: number, output: number, extra = {}) => ({
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        ...extra,
      },
      last_token_usage: { input_tokens: input },
    },
  },
});

describe("Codex session estimates", () => {
  it("counts cumulative snapshots once, discounts cached input, and includes reasoning only once", () => {
    const event = codexUsage(10000, 8000, 500, { reasoning_output_tokens: 300 });
    const path = transcript([codexContext("gpt-6.1-sol"), event, event]);
    const tracker = new UsageTracker();
    expect(tracker.update("t", path, "codex")).toMatchObject({
      inputTokens: 2000,
      cacheReadTokens: 8000,
      outputTokens: 500,
      turns: 1,
      model: "gpt-6.1-sol",
      costUsd: 0.0098,
    });
    appendFileSync(path, JSON.stringify(codexUsage(12000, 9000, 700)) + "\n");
    expect(tracker.update("t", path, "codex")).toMatchObject({
      inputTokens: 3000,
      cacheReadTokens: 9000,
      outputTokens: 700,
      turns: 2,
      costUsd: 0.0139,
    });
    // An older snapshot after reconnect must not reset the cumulative baseline.
    appendFileSync(path, JSON.stringify(event) + "\n");
    expect(tracker.update("t", path, "codex")).toBeNull();
    expect(new UsageTracker().update("t", path, "codex")).toMatchObject({
      costUsd: 0.0139,
      turns: 2,
    });
  });

  it("prices each delta at that turn's model, including cache writes", () => {
    const path = transcript([
      codexContext("gpt-5.3-codex"),
      codexUsage(1000, 500, 100),
      codexContext("gpt-6.1-sol"),
      codexUsage(2000, 500, 200, { cache_write_input_tokens: 400 }),
    ]);
    expect(new UsageTracker().update("t", path, "codex")).toMatchObject({
      inputTokens: 1100,
      outputTokens: 200,
      cacheReadTokens: 500,
      cacheWriteTokens: 400,
      costUsd: 0.005563,
    });
  });

  it("applies long-context and known Fast pricing, and leaves unknown models unpriced", () => {
    const long = transcript([
      codexContext("gpt-6.1-sol", "priority"),
      codexUsage(300000, 200000, 1000),
    ]);
    expect(new UsageTracker().update("t", long, "codex")?.costUsd).toBe(0.91);
    const unknown = transcript([codexContext("gpt-6.1-sol-unpublished"), codexUsage(100, 0, 10)]);
    expect(new UsageTracker().update("t", unknown, "codex")).toMatchObject({
      turns: 1,
      costUsd: null,
    });
    const missing = transcript([codexUsage(100, 0, 10)]);
    expect(new UsageTracker().update("t", missing, "codex")?.costUsd).toBeNull();
  });

  it("waits for complete lines and ignores rate-limit-only or malformed events", () => {
    const path = transcript([
      codexContext("gpt-5.2-codex"),
      { type: "event_msg", payload: { type: "token_count", info: null } },
    ]);
    const tracker = new UsageTracker();
    expect(tracker.update("t", path, "codex")).toBeNull();
    const line = JSON.stringify(codexUsage(1000, 0, 10));
    appendFileSync(path, line.slice(0, 50));
    expect(tracker.update("t", path, "codex")).toBeNull();
    appendFileSync(path, line.slice(50) + "\n");
    expect(tracker.update("t", path, "codex")).toMatchObject({ turns: 1, costUsd: 0.00189 });
  });
});
