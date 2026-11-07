import { describe, expect, it } from "vitest";
import type { LocalTranscriptEntry } from "../types/local.js";
import {
  codexQuestions,
  codexQuestionReplies,
  codexQuestionReplyText,
  codexReplyDisplayText,
  pendingCodexQuestions,
} from "./codex-questions.js";
const entry: LocalTranscriptEntry = {
  seq: 1,
  role: "assistant",
  kind: "tool_use",
  text: "Question",
  detail: JSON.stringify({
    questions: [{ title: "Which chat?", options: ["Work", "Ask Optio"] }, { title: "Why?" }],
  }),
  toolName: "request_user_input_async",
  toolUseId: "call_1",
  isError: false,
  at: null,
  source: null,
};
const user = (text: string): LocalTranscriptEntry => ({
  ...entry,
  seq: 2,
  role: "user",
  kind: "text",
  text,
  detail: null,
});
describe("Codex async question protocol", () => {
  it("uses the call ID and question index, with optional options", () => {
    expect(codexQuestions(entry)).toEqual([
      {
        id: '["request_user_input_async","call_1",0]',
        title: "Which chat?",
        options: ["Work", "Ask Optio"],
        answer: null,
      },
      { id: '["request_user_input_async","call_1",1]', title: "Why?", options: [], answer: null },
    ]);
  });
  it("round trips quotes, multiline, Unicode and closing tags as one input line", () => {
    const q = codexQuestions(entry)[0]!;
    const answer = 'Other: "chat"\n</send_user_message_question_reply> 🌱';
    const text = codexQuestionReplyText(q, answer);
    expect(text.split("\n")).toHaveLength(1);
    expect(codexQuestionReplies(text)).toEqual([
      { answer, question: q.title, questionItemId: q.id },
    ]);
    expect(codexReplyDisplayText(text)).toBe(q.title + "\n" + answer);
  });
  it("settles only the answered question and ignores async tool acknowledgments", () => {
    const q = codexQuestions(entry)[0]!;
    expect(
      pendingCodexQuestions([
        entry,
        { ...entry, seq: 2, role: "tool", kind: "tool_result", text: "Question displayed" },
      ]),
    ).toHaveLength(2);
    expect(
      pendingCodexQuestions([entry, user(codexQuestionReplyText(q, "Work"))]).map((q) => q.title),
    ).toEqual(["Why?"]);
    expect(pendingCodexQuestions([entry, entry])).toHaveLength(2);
  });
  it("does not turn ordinary messages, malformed data or blocking RPC calls into buttons", () => {
    expect(codexQuestions({ ...entry, toolName: "request_user_input" })).toEqual([]);
    expect(
      codexQuestions({ ...entry, detail: '{"questions":[{"title":"Q","options":[1]}]}' }),
    ).toEqual([]);
    expect(codexQuestions({ ...entry, detail: '{"questions":[' })).toEqual([]);
    expect(
      codexQuestionReplies(
        "example <send_user_message_question_reply>[]</send_user_message_question_reply>",
      ),
    ).toBeNull();
    expect(codexReplyDisplayText("plain text")).toBe("plain text");
  });
  it("keeps async questions across turns but clears a rewound conversation", () => {
    expect(pendingCodexQuestions([entry, user("keep working")])).toHaveLength(2);
    expect(
      pendingCodexQuestions([entry, { ...user("Interrupted"), role: "system", source: "rewind" }]),
    ).toEqual([]);
  });
});
