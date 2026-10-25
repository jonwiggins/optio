import { describe, expect, it } from "vitest";
import {
  chatMessageSummary,
  renderChat,
  workChatMessage,
  type ChatMessage,
} from "./chat-messages.js";

const BASE = "https://optio.example.test";

type Card = {
  type: string;
  attachments: Array<{
    contentType: string;
    content: { body: Array<{ text?: string }>; actions?: Array<{ url: string }> };
  }>;
};

describe("chat messages for a person's hook or a team's channel", () => {
  it("shapes a work event like an outbound webhook of the same format", () => {
    const msg = workChatMessage("task.failed", {
      id: "t1",
      kind: "repo",
      title: "Fix *login*",
      repoUrl: "https://gitlab.example.test/platform/app.git",
      errorMessage: "tests failed",
    });
    const mm = renderChat("mattermost", msg, BASE) as { text: string };
    expect(mm.text).toContain("Task failed");
    expect(mm.text).toContain("[Fix \\*login\\*](https://optio.example.test/work/t1)");
    expect(mm.text).toContain("Repository: platform/app");
    const card = renderChat("msteams", msg, BASE) as Card;
    expect(card.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
  });

  it("names a Job run's failure as one, linking the run under its Job", () => {
    const msg = workChatMessage("task.failed", {
      id: "r1",
      kind: "standalone",
      title: "Nightly export",
      workId: "j1",
      errorMessage: "exit 3",
    });
    expect(msg).toMatchObject({ type: "work", event: "workflow_run.failed" });
    const mm = renderChat("mattermost", msg, BASE) as { text: string };
    expect(mm.text).toContain("Job run failed");
    expect(mm.text).toContain("https://optio.example.test/jobs/j1/runs/r1");
  });

  it("shows a notice's text as written: no formatting, no mentions, only Optio's link", () => {
    const msg: ChatMessage = {
      type: "notice",
      subject: "Team @all used 80% of its budget",
      body: "Spent [80](https://evil.example) of 100.\nAsk @channel.",
      link: "/teams/t1",
    };
    const { text } = renderChat("mattermost", msg, BASE) as { text: string };
    expect(text.split("\n")).toEqual([
      "#### Team @​all used 80% of its budget",
      "Spent \\[80\\]\\(https://evil.example\\) of 100.",
      "Ask @​channel.",
      "[Open in Optio](https://optio.example.test/teams/t1)",
    ]);
    const card = renderChat("msteams", msg, BASE) as Card;
    const body = card.attachments[0].content.body;
    expect(body[1].text).toContain("[80]​(https://evil.example)");
    expect(card.attachments[0].content.actions).toEqual([
      {
        type: "Action.OpenUrl",
        title: "Open in Optio",
        url: "https://optio.example.test/teams/t1",
      },
    ]);
  });

  it("never links to anything but an http(s) address", () => {
    const msg: ChatMessage = {
      type: "notice",
      subject: "s",
      body: "b",
      link: "javascript:alert(1)",
    };
    expect((renderChat("mattermost", msg, BASE) as { text: string }).text).not.toContain(
      "javascript",
    );
    expect(
      (renderChat("msteams", msg, BASE) as Card).attachments[0].content.actions,
    ).toBeUndefined();
  });

  it("lists a digest's sections, each line linked, with what didn't fit", () => {
    const msg: ChatMessage = {
      type: "digest",
      title: "Your Optio digest for Tuesday 20 October",
      sections: [
        {
          title: "Waiting for you",
          items: [{ name: "Add [export]", link: "/work/a", detail: "platform/app" }],
          more: 2,
        },
      ],
      link: "/",
    };
    const { text } = renderChat("mattermost", msg, BASE) as { text: string };
    expect(text).toContain("**Waiting for you** (3)");
    expect(text).toContain(
      "- [Add \\[export\\]](https://optio.example.test/work/a) · platform/app",
    );
    expect(text).toContain("- and 2 more");
    const card = renderChat("msteams", msg, BASE) as Card;
    const lines = card.attachments[0].content.body.map((b) => b.text).join("\n");
    // Brackets out of the name so it can't break the link.
    expect(lines).toContain("- [Add export](https://optio.example.test/work/a) · platform/app");
  });

  it("sums a message up in one line for the outbox", () => {
    expect(chatMessageSummary({ type: "notice", subject: "Hello", body: "b" })).toBe("Hello");
    expect(
      chatMessageSummary({ type: "work", event: "task.failed", data: { taskTitle: "Fix it" } }),
    ).toBe("task.failed: Fix it");
    expect(chatMessageSummary({ type: "test", sentBy: null, where: "x" })).toBe("Test message");
  });
});
