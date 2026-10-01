import { describe, expect, it } from "vitest";
import type { LocalTranscriptEntry } from "@optio/shared";
import { foldTranscript, groupTranscript, stepsSummary } from "./transcript-view";

const e = (seq: number, over: Partial<LocalTranscriptEntry>): LocalTranscriptEntry => ({
  seq,
  role: "assistant",
  kind: "text",
  text: `t${seq}`,
  detail: null,
  toolName: null,
  toolUseId: null,
  isError: false,
  at: null,
  ...over,
});

describe("groupTranscript", () => {
  it("folds each tool result under its call and keeps document order", () => {
    const items = groupTranscript([
      e(1, { role: "user" }),
      e(2, { kind: "tool_use", toolName: "Bash", toolUseId: "a" }),
      e(3, { kind: "tool_use", toolName: "Read", toolUseId: "b" }),
      e(4, { role: "tool", kind: "tool_result", toolUseId: "b" }),
      e(5, { role: "tool", kind: "tool_result", toolUseId: "a" }),
      e(6, {}),
    ]);
    expect(
      items.map((i) =>
        i.kind === "tool" ? `tool:${i.use.seq}->${i.result?.seq}` : `e:${i.entry.seq}`,
      ),
    ).toEqual(["e:1", "tool:2->5", "tool:3->4", "e:6"]);
  });

  it("leaves an orphan result and a call without a result standing", () => {
    const items = groupTranscript([
      e(1, { kind: "tool_use", toolUseId: "x" }),
      e(2, { role: "tool", kind: "tool_result", toolUseId: "gone" }),
    ]);
    expect(items).toMatchObject([
      { kind: "tool", use: { seq: 1 }, result: null },
      { kind: "entry", entry: { seq: 2 } },
    ]);
  });
});

describe("foldTranscript", () => {
  const shape = (entries: LocalTranscriptEntry[]) =>
    foldTranscript(groupTranscript(entries)).map((b) =>
      b.kind === "steps"
        ? `steps:${b.items.length}`
        : b.item.kind === "tool"
          ? `tool:${b.item.use.seq}`
          : `${b.item.entry.role}:${b.item.entry.seq}`,
    );

  it("keeps each turn's opener and last reply, folding everything between", () => {
    expect(
      shape([
        e(1, { role: "user" }),
        e(2, { kind: "thinking" }),
        e(3, { kind: "tool_use", toolUseId: "a" }),
        e(4, { role: "tool", kind: "tool_result", toolUseId: "a" }),
        e(5, {}),
        e(6, { kind: "tool_use", toolUseId: "b" }),
        e(7, {}),
        e(8, { role: "user" }),
        e(9, {}),
      ]),
    ).toEqual(["user:1", "steps:4", "assistant:7", "user:8", "assistant:9"]);
  });

  it("folds a turn still at work after its last reply, and leaves a lone step unfolded", () => {
    expect(
      shape([
        e(1, { role: "user" }),
        e(2, {}),
        e(3, { kind: "tool_use", toolUseId: "a" }),
        e(4, { kind: "tool_use", toolUseId: "b" }),
      ]),
    ).toEqual(["user:1", "assistant:2", "steps:2"]);
    expect(shape([e(1, { role: "user" }), e(2, { kind: "tool_use" }), e(3, {})])).toEqual([
      "user:1",
      "tool:2",
      "assistant:3",
    ]);
  });

  it("treats system turns as openers", () => {
    expect(
      shape([
        e(1, { role: "system", source: "task" }),
        e(2, { kind: "tool_use" }),
        e(3, { kind: "tool_use" }),
        e(4, {}),
      ]),
    ).toEqual(["system:1", "steps:2", "assistant:4"]);
  });

  it("summarizes what a steps block holds", () => {
    const items = groupTranscript([
      e(1, { kind: "tool_use", toolUseId: "a" }),
      e(2, { role: "tool", kind: "tool_result", toolUseId: "a" }),
      e(3, { kind: "tool_use" }),
      e(4, {}),
      e(5, { kind: "thinking" }),
    ]);
    expect(stepsSummary(items)).toBe("2 tool calls · 1 message · thinking");
  });
});
