import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter, parseModelUsage } from "./claude-code.js";

// Token accounting for Claude Code's stream-json output. Kept apart from
// claude-code.test.ts so that file stays as upstream has it.

const adapter = new ClaudeCodeAdapter();

/** One assistant stream event: a single content block of message `id`. */
function block(id: string, type: string, usage: Record<string, number>, model = "claude-sonnet-5") {
  return JSON.stringify({
    type: "assistant",
    message: { id, model, content: [{ type }], usage },
  });
}

describe("ClaudeCodeAdapter token accounting", () => {
  it("counts a message's usage once when its content blocks arrive as separate events", () => {
    // Claude Code emits one assistant event per content block of a message,
    // each repeating the whole message's usage. The old parser summed every
    // event, so this message (thinking + text + tool_use) counted 3 times:
    // 1530 input / 120 output / 1500 cache read.
    const usage = {
      input_tokens: 10,
      output_tokens: 40,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 0,
    };
    const logs = [
      block("msg_a", "thinking", usage),
      block("msg_a", "text", usage),
      block("msg_a", "tool_use", usage),
      block("msg_b", "text", { input_tokens: 5, output_tokens: 8 }),
    ].join("\n");
    const result = adapter.parseResult(0, logs);
    expect(result.inputTokens).toBe(515);
    expect(result.outputTokens).toBe(48);
    expect(result.cacheReadTokens).toBe(500);
    expect(result.cacheWriteTokens).toBe(0);
    expect(result.modelUsage).toBeUndefined();
  });

  it("keeps the last event's figures for a message whose usage grows across its blocks", () => {
    const logs = [
      block("msg_a", "thinking", { input_tokens: 3, output_tokens: 1 }),
      block("msg_a", "tool_use", { input_tokens: 3, output_tokens: 90 }),
    ].join("\n");
    const result = adapter.parseResult(0, logs);
    expect(result.inputTokens).toBe(3);
    expect(result.outputTokens).toBe(90);
  });

  it("takes the totals from the result event, which also counts calls with no assistant event", () => {
    // The result's usage is the process total from Claude Code's cost ledger:
    // it includes the background Haiku call that never shows up as an
    // assistant event. The old parser reported only the 100 + 50 it saw.
    const logs = [
      '{"type":"system","subtype":"init","model":"claude-sonnet-5"}',
      block("msg_1", "text", { input_tokens: 100, output_tokens: 50 }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.01,
        result: "done",
        usage: { input_tokens: 130, output_tokens: 60 },
      }),
    ].join("\n");
    const result = adapter.parseResult(0, logs);
    expect(result.inputTokens).toBe(130);
    expect(result.outputTokens).toBe(60);
  });

  it("uses the last result event of a multi-turn run, whose usage is cumulative", () => {
    const logs = [
      block("msg_1", "text", { input_tokens: 100, output_tokens: 50 }),
      '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"usage":{"input_tokens":100,"output_tokens":50}}',
      block("msg_2", "text", { input_tokens: 200, output_tokens: 75 }),
      '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.03,"usage":{"input_tokens":300,"output_tokens":125}}',
    ].join("\n");
    const result = adapter.parseResult(0, logs);
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(125);
    expect(result.costUsd).toBe(0.03);
  });

  it("reads the result event's modelUsage per model, a gateway's own ids included", () => {
    // A gateway run: Claude Code asked for the gateway's internal name and
    // a Haiku id for background work. costUSD is its guess from the public
    // price list (wrong for an internal name; the pricing module recomputes).
    const logs = [
      '{"type":"system","subtype":"init","model":"acme-coder-large[1m]"}',
      '{"type":"assistant","message":{"id":"msg_1","model":"acme-coder-large","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200}}}',
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.42,
        result: "done",
        usage: {
          input_tokens: 130,
          output_tokens: 60,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
        },
        modelUsage: {
          "acme-coder-large[1m]": {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 1000,
            cacheCreationInputTokens: 200,
            costUSD: 0.4,
            contextWindow: 1000000,
          },
          "claude-haiku-4-5-20251001": {
            inputTokens: 30,
            outputTokens: 10,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.02,
          },
        },
      }),
    ].join("\n");
    const result = adapter.parseResult(0, logs);
    expect(result.model).toBe("acme-coder-large");
    expect(result.modelUsage).toEqual({
      "acme-coder-large": {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 1000,
        cacheWriteTokens: 200,
        costUsd: 0.4,
      },
      "claude-haiku-4-5-20251001": {
        inputTokens: 30,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.02,
      },
    });
    // inputTokens counts the cache tokens too, as before.
    expect(result.inputTokens).toBe(1330);
    expect(result.outputTokens).toBe(60);
    expect(result.cacheReadTokens).toBe(1000);
    expect(result.cacheWriteTokens).toBe(200);
    expect(result.costUsd).toBe(0.42);
  });

  it("totals a result that has modelUsage but no usage from the split", () => {
    const logs = [
      block("msg_1", "text", { input_tokens: 100, output_tokens: 50 }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.02,
        modelUsage: {
          "claude-sonnet-5": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 400 },
          "claude-haiku-4-5": { inputTokens: 30, outputTokens: 10 },
        },
      }),
    ].join("\n");
    const result = adapter.parseResult(0, logs);
    expect(result.inputTokens).toBe(530);
    expect(result.outputTokens).toBe(60);
    expect(result.cacheReadTokens).toBe(400);
  });

  it("falls back to the per-message sum when the run produced no result event", () => {
    const usage = { input_tokens: 20, output_tokens: 5 };
    const logs = [block("msg_a", "text", usage), block("msg_a", "tool_use", usage)].join("\n");
    const result = adapter.parseResult(1, logs);
    expect(result.success).toBe(false);
    expect(result.inputTokens).toBe(20);
    expect(result.outputTokens).toBe(5);
  });

  it("accepts a scientific-notation cost in the regex fallback and strips [1m] from the model", () => {
    // The old regex read "1.5e-05" as 1.5.
    const logs = [
      '{"type":"assistant","message":{"model":"claude-sonnet-5[1m]","usage":{"input_tokens":1,"output_tokens":1}}}',
      '<garbled> "total_cost_usd": 1.5e-05 ...',
    ].join("\n");
    const result = adapter.parseResult(0, logs);
    expect(result.costUsd).toBe(0.000015);
    expect(result.model).toBe("claude-sonnet-5");
  });
});

describe("parseModelUsage", () => {
  it("sums two spellings of one model and ignores junk", () => {
    const out = parseModelUsage({
      "claude-sonnet-5": { inputTokens: 10, outputTokens: 1, costUSD: 0.1 },
      "claude-sonnet-5[1m]": { inputTokens: 5, outputTokens: 2, costUSD: 0.05 },
      "  ": { inputTokens: 99 },
      "claude-haiku-4-5": { inputTokens: -3, outputTokens: "7", costUSD: Infinity },
      broken: null,
    });
    expect(Object.keys(out ?? {})).toEqual(["claude-sonnet-5", "claude-haiku-4-5"]);
    expect(out?.["claude-sonnet-5"]).toMatchObject({
      inputTokens: 15,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(out?.["claude-sonnet-5"].costUsd).toBeCloseTo(0.15);
    expect(out?.["claude-haiku-4-5"]).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("returns null for anything that is not a non-empty object", () => {
    expect(parseModelUsage(undefined)).toBeNull();
    expect(parseModelUsage([])).toBeNull();
    expect(parseModelUsage({})).toBeNull();
    expect(parseModelUsage("x")).toBeNull();
  });
});
