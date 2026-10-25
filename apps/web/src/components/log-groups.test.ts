import { describe, expect, it } from "vitest";
import type { LogEntry } from "@/hooks/use-logs";
import { groupIndices, groupLogs, thinkingSummary, thinkingTokens } from "./log-groups";

const at = "2026-10-22T10:00:00.000Z";
const entry = (
  logType: string,
  content = logType,
  metadata?: Record<string, unknown>,
): LogEntry => ({
  content,
  stream: "stdout",
  timestamp: at,
  logType,
  ...(metadata ? { metadata } : {}),
});

describe("groupLogs", () => {
  it("folds consecutive thinking entries into one group, between the other rows", () => {
    const logs = [
      entry("text", "hi"),
      entry("thinking", "a"),
      entry("thinking", "b"),
      entry("tool_use", "Read"),
      entry("tool_result", "ok"),
      entry("thinking", "c"),
      entry("text", "bye"),
    ];
    const groups = groupLogs(logs, true);
    expect(groups.map((g) => g.type)).toEqual([
      "single",
      "thinking",
      "tool_call",
      "thinking",
      "single",
    ]);
    const fold = groups[1];
    expect(fold.type === "thinking" && fold.entries.map((e) => e.content)).toEqual(["a", "b"]);
    expect(fold.index).toBe(1);
    // Search and highlight cover every entry a group holds.
    expect(groupIndices(fold)).toEqual([1, 2]);
    expect(groupIndices(groups[2])).toEqual([3, 4]);
    expect(groupIndices(groups[3])).toEqual([5]);
  });

  it("still drops hidden tool results and keeps a lone tool use", () => {
    const groups = groupLogs([entry("tool_use", "Bash"), entry("tool_result", "x")], false);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("tool_call");
    expect(groupLogs([entry("tool_result", "x")], false)).toEqual([]);
  });

  it("counts thinking tokens from the parser when it gave them, else estimates", () => {
    const counted = [entry("thinking", "a".repeat(400), { thinkingTokens: 120 })];
    expect(thinkingTokens(counted)).toEqual({ tokens: 120, estimated: false });
    expect(thinkingSummary(counted)).toBe("Thinking (1 block · 120 tokens)");
    const mixed = [...counted, entry("thinking", "b".repeat(4000))];
    expect(thinkingTokens(mixed)).toEqual({ tokens: 1120, estimated: true });
    expect(thinkingSummary(mixed)).toBe("Thinking (2 blocks · ~1.1K tokens)");
  });
});
