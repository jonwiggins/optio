import { describe, expect, it } from "vitest";
import {
  classifyTranscriptUserText,
  peerMessageText,
  taskNotificationText,
} from "./transcript-source.js";

const NOTIFICATION = `<task-notification>
<task-id>b02n8ro4a</task-id>
<tool-use-id>toolu_01B3</tool-use-id>
<output-file>/tmp/tasks/b02n8ro4a.output</output-file>
<status>completed</status>
<summary>Background command "Poll the mirrors" completed (exit code 0)</summary>
</task-notification>`;

describe("classifyTranscriptUserText", () => {
  it("leaves what the person typed alone", () => {
    expect(classifyTranscriptUserText("Please fix the build")).toBeNull();
    expect(classifyTranscriptUserText("  [not an interruption] ")).toBeNull();
    expect(classifyTranscriptUserText("Summarize <task-notification> handling")).toBeNull();
  });

  it("reads a background task's notification as its summary", () => {
    expect(classifyTranscriptUserText(NOTIFICATION)).toEqual({
      source: "task",
      text: 'Background command "Poll the mirrors" completed (exit code 0)',
    });
    const withResult = NOTIFICATION.replace(
      "</task-notification>",
      "<result>All done.\nTwo files changed.</result>\n</task-notification>",
    );
    expect(taskNotificationText(withResult)).toBe(
      'Background command "Poll the mirrors" completed (exit code 0)\n\nAll done.\nTwo files changed.',
    );
  });

  it("reads another session's message as that agent's", () => {
    const text =
      'Another Claude session sent a message:\n<agent-message from="a150">\nM1 is committed.\n</agent-message>';
    expect(classifyTranscriptUserText(text)).toEqual({
      source: "agent",
      text: "a150: M1 is committed.",
    });
    expect(peerMessageText(text, "general-purpose")).toBe("general-purpose: M1 is committed.");
  });

  it("recognizes a compaction summary and an interruption", () => {
    expect(
      classifyTranscriptUserText(
        "This session is being continued from a previous conversation that ran out of context.",
      )?.source,
    ).toBe("compact");
    expect(classifyTranscriptUserText("[Request interrupted by user for tool use]")).toEqual({
      source: "interrupt",
      text: "Request interrupted by user for tool use",
    });
  });
});
