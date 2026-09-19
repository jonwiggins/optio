import { describe, expect, it } from "vitest";
import type { LocalTranscriptEntry } from "@optio/shared";
import { groupTranscript } from "./transcript-view";

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
