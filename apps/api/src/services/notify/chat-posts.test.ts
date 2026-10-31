import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWebhookBody, workPost } from "./chat-formats.js";
import { chatPost, renderChat, type ChatMessage } from "./chat-messages.js";
import {
  discordPost,
  googleChatPost,
  POST_FORMATS,
  renderPost,
  rocketChatPost,
  slackPost,
  webexPost,
  zulipPost,
  type ChatPost,
} from "./chat-posts.js";

const BASE = "https://optio.example.com";

const taskData = {
  taskId: "t-1",
  taskTitle: "Add a [health] endpoint",
  repoUrl: "https://gitlab.example.com/platform/hello-service",
  repoBranch: "main",
  prUrl: "https://gitlab.example.com/platform/hello-service/-/merge_requests/7",
  errorMessage: "tests failed",
};

const runData = {
  runId: "r-1",
  workflowId: "j-1",
  workflowName: "Nightly report",
  costUsd: "0.1234",
  durationMs: 4200,
  modelUsed: "model-a",
  errorMessage: "exit status 3",
};

/** Anyone's text that tries markup, links and mentions everywhere it can. */
const hostile = {
  ...taskData,
  taskTitle: "Fix [login](https://evil.example) @everyone <@123> <users/all> *now* <b>x</b>",
  repoBranch: "feat/`x`_y @here ~town <!channel>",
  errorMessage: "boom @all ``` [e](https://evil.example)",
};

const slack = vi.fn((event: string) => ({ text: `slack ${event}`, blocks: [] }));

beforeEach(() => vi.stubEnv("PUBLIC_URL", BASE));
afterEach(() => vi.unstubAllEnvs());

const work = (event = "task.failed", data: Record<string, unknown> = taskData) =>
  workPost(event, data, BASE);

const notice: ChatMessage = {
  type: "notice",
  subject: "Alice @all left the workspace",
  body: "Her [automations](https://evil.example) were paused.\nAsk @channel.",
  link: "/workspace-settings",
};

const digest: ChatMessage = {
  type: "digest",
  title: "Your Optio digest",
  link: "/",
  sections: [
    {
      title: "Waiting for you",
      more: 2,
      items: [
        { name: "Fix [it]", link: "/work/a", detail: "platform/app" },
        { name: "Plain", link: null },
      ],
    },
  ],
};

const testMsg: ChatMessage = { type: "test", sentBy: "Ada @all", where: "your own notifications" };

describe("chat posts: every format, every message", () => {
  const messages: ChatMessage[] = [
    { type: "work", event: "task.pr_opened", data: taskData },
    { type: "work", event: "workflow_run.failed", data: runData },
    notice,
    digest,
    testMsg,
  ];
  it.each(POST_FORMATS.flatMap((f) => messages.map((m) => [f, m.type, m] as const)))(
    "%s renders a %s message as JSON",
    (format, _type, msg) => {
      const body = renderChat(format, msg, BASE);
      expect(body).toBeTypeOf("object");
      expect(JSON.parse(JSON.stringify(body))).toEqual(body);
    },
  );

  it("routes Mattermost and Teams to their own builders, as before", () => {
    const msg: ChatMessage = { type: "work", event: "task.failed", data: taskData };
    expect(Object.keys(renderChat("mattermost", msg, BASE))).toEqual(["text"]);
    expect(renderChat("msteams", msg, BASE)).toMatchObject({ type: "message" });
  });

  it("gives an outbound webhook of a new format that service's body", () => {
    expect(renderWebhookBody("discord", "task.failed", taskData, slack)).toHaveProperty("embeds");
    expect(renderWebhookBody("googlechat", "task.failed", taskData, slack)).toHaveProperty(
      "cardsV2",
    );
    expect(renderWebhookBody("rocketchat", "task.failed", taskData, slack)).toHaveProperty(
      "attachments",
    );
    expect(renderWebhookBody("webex", "task.failed", taskData, slack)).toHaveProperty("markdown");
    expect(renderWebhookBody("zulip", "task.failed", taskData, slack)).toHaveProperty("text");
    // An outbound Slack webhook keeps its own builder (webhook-service.ts).
    expect(renderWebhookBody("slack", "task.failed", taskData, slack)).toEqual({
      text: "slack task.failed",
      blocks: [],
    });
  });

  it("builds neutral parts from each message", () => {
    expect(chatPost(notice, BASE)).toMatchObject({
      title: notice.subject,
      actions: [{ title: "Open in Optio", url: `${BASE}/workspace-settings` }],
    });
    expect(chatPost(digest, BASE)).toMatchObject({
      sections: [{ items: [{ link: `${BASE}/work/a` }, { link: null }] }],
    });
    expect(chatPost(testMsg, BASE).text).toBe(
      "This is a test message for your own notifications, sent by Ada @all.",
    );
  });
});

describe("Discord", () => {
  it("sends one embed: headline linked to the work, name, facts as fields, no pings", () => {
    const body = discordPost(work("task.pr_opened")) as any;
    expect(body.allowed_mentions).toEqual({ parse: [] });
    const [embed] = body.embeds;
    expect(embed).toMatchObject({
      title: "Merge request opened",
      url: `${BASE}/work/t-1`,
      color: expect.any(Number),
    });
    expect(embed.description.split("\n")[0]).toBe(
      `**[Add a \\[health\\] endpoint](${BASE}/work/t-1)**`,
    );
    expect(embed.fields).toEqual([
      { name: "Repository", value: "platform/hello-service", inline: true },
      { name: "Branch", value: "main", inline: true },
      { name: "Merge request", value: taskData.prUrl, inline: false },
    ]);
  });

  it("shows anyone's text as written: escaped Markdown, no links, mentions broken", () => {
    const body = discordPost(work("task.failed", hostile)) as any;
    const [embed] = body.embeds;
    // Outside the code block nothing links (inside it, Markdown is shown as written).
    const outside = JSON.stringify({ ...embed, description: embed.description.split("```")[0] });
    expect(outside).not.toMatch(/\]\(https:\/\/evil/);
    expect(JSON.stringify(embed)).not.toMatch(/@(everyone|here|all)/);
    expect(body.embeds[0].description).toContain(
      "```\nboom @\u200Ball ''' [e](https://evil.example)\n```",
    );
  });

  it("stays within Discord's limits for a long message", () => {
    const p: ChatPost = {
      title: "t".repeat(400),
      tone: "neutral",
      text: "y".repeat(5000),
      facts: Array.from(
        { length: 30 },
        (_, i) => [`Fact ${i}`, "v".repeat(2000)] as [string, string],
      ),
    };
    const [embed] = (discordPost(p) as any).embeds;
    expect(embed.title.length).toBeLessThanOrEqual(256);
    expect(embed.description.length).toBeLessThanOrEqual(4096);
    const total =
      embed.title.length +
      embed.description.length +
      embed.fields.reduce((n: number, f: any) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
    expect(embed.fields.length).toBeLessThanOrEqual(25);
    for (const f of embed.fields) expect(f.value.length).toBeLessThanOrEqual(1024);
  });
  it("stays within Discord's limits for a long digest", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      name: `Item ${i} ${"x".repeat(200)}`,
      link: `${BASE}/work/${i}`,
      detail: "d".repeat(100),
    }));
    const p: ChatPost = {
      title: "t".repeat(400),
      tone: "neutral",
      text: "y".repeat(5000),
      sections: [1, 2, 3, 4, 5].map((n) => ({ title: `Section ${n}`, items, more: 3 })),
    };
    const [embed] = (discordPost(p) as any).embeds;
    expect(embed.title.length).toBeLessThanOrEqual(256);
    expect(embed.description.length).toBeLessThanOrEqual(4096);
    const total =
      embed.title.length +
      embed.description.length +
      embed.fields.reduce((n: number, f: any) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
    for (const f of embed.fields) {
      expect(f.value.length).toBeLessThanOrEqual(1024);
      expect(f.value).toMatch(/and \d+ more$/);
    }
  });
});

describe("Google Chat", () => {
  it("sends one card: header, facts, merge request link, error, buttons", () => {
    const body = googleChatPost(work("task.failed")) as any;
    expect(Object.keys(body)).toEqual(["cardsV2"]);
    const { card } = body.cardsV2[0];
    expect(card.header).toEqual({ title: "Task failed", subtitle: "Add a [health] endpoint" });
    const widgets = card.sections[0].widgets;
    expect(widgets[0]).toEqual({
      decoratedText: { topLabel: "Repository", text: "platform/hello-service" },
    });
    expect(widgets[2].decoratedText.text).toBe(`<a href="${taskData.prUrl}">${taskData.prUrl}</a>`);
    expect(widgets[3].textParagraph.text).toContain("tests failed");
    expect(widgets[4].buttonList.buttons).toEqual([
      { text: "Open in Optio", onClick: { openLink: { url: `${BASE}/work/t-1` } } },
      { text: "Open the merge request", onClick: { openLink: { url: taskData.prUrl } } },
    ]);
  });

  it("HTML-escapes anyone's text in card text, so no tag, link or mention gets through", () => {
    const body = googleChatPost(work("task.failed", hostile)) as any;
    const widgets = body.cardsV2[0].card.sections[0].widgets;
    const branch = widgets.find((w: any) => w.decoratedText?.topLabel === "Branch");
    expect(branch.decoratedText.text).toBe("feat/`x`_y @here ~town &lt;!channel&gt;");
    expect(JSON.stringify(widgets)).not.toMatch(/<b>|<users\/all>/);
  });

  it("lists a digest's sections with linked items", () => {
    const body = renderChat("googlechat", digest, BASE) as any;
    const [, section] = body.cardsV2[0].card.sections;
    expect(section.header).toBe("Waiting for you (4)");
    expect(section.widgets[0].textParagraph.text).toBe(
      `<a href="${BASE}/work/a">Fix [it]</a> · platform/app<br>Plain<br>and 2 more`,
    );
  });

  it("keeps a long digest within Google Chat's 32,000 bytes", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      name: `Élément ${i} ${"é".repeat(300)}`,
      link: `${BASE}/work/${i}`,
      detail: "<détail>".repeat(20),
    }));
    const p: ChatPost = {
      title: "Digest",
      tone: "neutral",
      sections: [1, 2, 3, 4].map((n) => ({ title: `Section ${n}`, items, more: 0 })),
    };
    const body = googleChatPost(p) as any;
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(32_000);
    for (const s of body.cardsV2[0].card.sections) {
      expect(s.widgets[0].textParagraph.text).toMatch(/and \d+ more$/);
    }
  });

  it("always has a section with a widget", () => {
    const body = googleChatPost({ title: "Only a title", tone: "neutral" }) as any;
    expect(body.cardsV2[0].card.sections).toEqual([
      { widgets: [{ textParagraph: { text: "Only a title" } }] },
    ]);
  });
});

describe("Rocket.Chat", () => {
  it("sends the headline and an attachment: name linked, facts as fields, colour", () => {
    const body = rocketChatPost(work("task.failed")) as any;
    expect(body.text).toBe("*Task failed*");
    expect(body.attachments[0]).toMatchObject({
      title: "Add a [health] endpoint",
      title_link: `${BASE}/work/t-1`,
      color: expect.stringMatching(/^#/),
      fields: [
        { short: true, title: "Repository", value: "platform/hello-service" },
        { short: true, title: "Branch", value: "main" },
        { short: false, title: "Merge request", value: taskData.prUrl },
      ],
    });
    expect(body.attachments[0].text).toBe("```\ntests failed\n```");
  });

  it("disarms mentions and links in anyone's text", () => {
    const body = rocketChatPost(chatPost(notice, BASE)) as any;
    expect(body.text).toBe("*Alice @\u200Ball left the workspace*");
    const text = body.attachments[0].text as string;
    expect(text).toContain("Her [automations]\u200B(https://evil.example) were paused.");
    expect(text).toContain("Ask @\u200Bchannel.");
    expect(text).toContain(`[Open in Optio](${BASE}/workspace-settings)`);
  });
  it("gives each digest section an attachment with Markdown links", () => {
    const body = renderChat("rocketchat", digest, BASE) as any;
    expect(body.attachments[0]).toMatchObject({ title: "Waiting for you (4)" });
    expect(body.attachments[0].text).toBe(
      `- [Fix it](${BASE}/work/a) · platform/app\n- Plain\n- and 2 more`,
    );
    expect(body.attachments[1].text).toBe(`[Open Optio](${BASE}/)`);
  });
});

describe("Slack (a person's own hook)", () => {
  it("sends a header, the linked name, facts and the error", () => {
    const body = slackPost(work("task.failed")) as any;
    expect(body.text).toBe("Task failed: Add a [health] endpoint");
    expect(body.blocks[0]).toEqual({
      type: "header",
      text: { type: "plain_text", text: "Task failed", emoji: false },
    });
    expect(body.blocks[1].text.text).toBe(`*<${BASE}/work/t-1|Add a [health] endpoint>*`);
    expect(body.blocks[2].fields.map((f: any) => f.text)).toEqual([
      "*Repository:*\nplatform/hello-service",
      "*Branch:*\nmain",
      `*Merge request:*\n<${taskData.prUrl}|${taskData.prUrl}>`,
    ]);
    expect(body.blocks[3].text.text).toBe("```tests failed```");
  });

  it("escapes &, < and > so anyone's text never links or mentions", () => {
    const body = slackPost(work("task.failed", hostile)) as any;
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/<!channel>|<@123>|<https:\/\/evil/);
    expect(body.blocks[2].fields[1].text).toBe(
      "*Branch:*\nfeat/`x`_y @here ~town &lt;!channel&gt;",
    );
  });
});

describe("Webex", () => {
  it("sends Markdown, with anyone's text escaped", () => {
    const body = webexPost(work("task.pr_opened")) as { markdown: string };
    expect(body.markdown.split("\n")).toEqual([
      "**Merge request opened**",
      `**[Add a \\[health\\] endpoint](${BASE}/work/t-1)**`,
      `Repository: platform/hello-service · Branch: main · Merge request: ${taskData.prUrl}`,
      "```",
      "tests failed",
      "```",
    ]);
  });

  it("keeps a long message within Webex's 5,400 characters and 7,439 bytes", () => {
    const body = webexPost({ title: "Notice", tone: "neutral", text: "é".repeat(9000) }) as {
      markdown: string;
    };
    expect(Buffer.byteLength(body.markdown)).toBeLessThanOrEqual(7439);
    expect(body.markdown.length).toBeLessThanOrEqual(5400);
  });

  it("escapes a mention of everyone", () => {
    const body = webexPost(work("task.failed", hostile)) as { markdown: string };
    expect(body.markdown).not.toMatch(/(?<!\\)<@/);
    expect(body.markdown).toContain("\\<@\u200B123\\>");
  });
});

describe("Zulip", () => {
  it("sends Markdown text, the error as one escaped line", () => {
    const body = zulipPost(work("task.failed", hostile)) as { text: string };
    const lines = body.text.split("\n");
    expect(lines[0]).toBe("**Task failed**");
    expect(lines[1]).toMatch(
      /^\*\*\[Fix \\\[login\\\]\\\(https:\/\/evil\.example\\\) @\u200Beveryone/,
    );
    expect(lines.at(-1)).toBe("Error: boom @\u200Ball \\`\\`\\` \\[e\\]\\(https://evil.example\\)");
    expect(body.text).not.toMatch(/```/);
  });

  it("is the same body for every message type renderPost knows", () => {
    expect(renderPost("zulip", chatPost(testMsg, BASE))).toEqual({
      text: "**Optio can post here**\nThis is a test message for your own notifications, sent by Ada @\u200Ball.",
    });
  });
});
