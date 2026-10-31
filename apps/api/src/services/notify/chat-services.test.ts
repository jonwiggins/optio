import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_FORMAT_IDS, type ChatFormat } from "@optio/shared";

/**
 * What Optio posts to each chat service, over HTTP, against the fake
 * incoming webhooks in test-utils/fake-chat.ts: every format takes every
 * message for a person's own hook, an outbound webhook without a
 * format gets the format of a URL only one service uses, an explicit format
 * still wins, and Slack and generic webhooks send what they did.
 */

const inserted: unknown[] = [];
vi.mock("../../db/client.js", () => ({
  db: {
    insert: () => ({
      values: (v: unknown) => {
        inserted.push(v);
        return { returning: async () => [{ id: "d-1", ...(v as object) }] };
      },
    }),
  },
}));

import { startFakeChat, zulipRendering, type FakeChat } from "../../test-utils/fake-chat.js";
import { setOutboundDefaults } from "../../utils/outbound-url.js";
import { deliverWebhook, type WebhookRecord } from "../webhook-service.js";
import { postChat } from "./chat-hooks.js";
import type { ChatMessage } from "./chat-messages.js";

const BASE = "https://optio.example.com";

const taskData = {
  taskId: "t-1",
  taskTitle: "Add a health endpoint",
  repoUrl: "https://gitlab.example.com/platform/hello-service",
  repoBranch: "main",
  prUrl: "https://gitlab.example.com/platform/hello-service/-/merge_requests/7",
  errorMessage: "tests failed",
};

const hostileData = {
  ...taskData,
  taskTitle: "Fix *login* _now_ ~old~ <https://evil.example|click> [x](https://evil.example) @all",
};

const longNotice: ChatMessage = {
  type: "notice",
  subject: "A long notice",
  body: Array.from({ length: 60 }, (_, i) => `Line ${i} ${"n".repeat(120)}`).join("\n"),
  link: "/",
};

const MESSAGES: Array<[string, ChatMessage]> = [
  ["a Task's event", { type: "work", event: "task.pr_opened", data: taskData }],
  ["a hostile Task title", { type: "work", event: "task.failed", data: hostileData }],
  [
    "a Job run's failure",
    {
      type: "work",
      event: "workflow_run.failed",
      data: { runId: "r-1", workflowId: "j-1", workflowName: "Nightly", errorMessage: "exit 3" },
    },
  ],
  [
    "a notice",
    {
      type: "notice",
      subject: "Alice @all left the workspace",
      body: "Her automations were paused.\nAsk @channel.",
      link: "/workspace-settings",
    },
  ],
  ["a long notice", longNotice],
  ["a test", { type: "test", sentBy: "Ada", where: "your own notifications" }],
];

let chat: FakeChat;
let restore: () => void;

beforeAll(async () => {
  chat = await startFakeChat();
});
afterAll(async () => {
  await chat.close();
});
beforeEach(() => {
  vi.stubEnv("PUBLIC_URL", BASE);
  chat.posts.length = 0;
  inserted.length = 0;
  restore = setOutboundDefaults({ fetchImpl: chat.fetch, resolveHost: chat.resolveHost });
});
afterEach(() => {
  restore();
  vi.unstubAllEnvs();
});

describe("a person's own hook, of each chat service", () => {
  it.each(CHAT_FORMAT_IDS.flatMap((f) => MESSAGES.map(([what, msg]) => [f, what, msg] as const)))(
    "%s takes %s",
    async (format, _what, msg) => {
      const result = await postChat({ url: chat.urlFor(format), format }, msg);
      const [post] = chat.posts;
      expect(post.refused, JSON.stringify(post.body).slice(0, 400)).toBeUndefined();
      expect(result).toMatchObject({ ok: true });
      expect(post.service).toBe(format);
      expect(post.headers["content-type"]).toMatch(/^application\/json/);
      if (format === "zulip") expect(post.rendered).not.toBe("");
    },
  );

  it("shows a hostile title in Zulip as written, after Zulip's own conversion", async () => {
    await postChat(
      { url: chat.urlFor("zulip"), format: "zulip" },
      { type: "work", event: "task.failed", data: hostileData },
    );
    const rendered = chat.postsTo("zulip")[0].rendered!;
    const name = rendered.split("\n")[1];
    // Only Optio's own link is a link; the title's stays escaped text.
    expect(name).toBe(
      "**[Fix \\*login\\* \\_now\\_ \\~old\\~ \\<https://evil.example\\|click\\> " +
        `\\[x\\]\\(https://evil.example\\) @\u200Ball](${BASE}/work/t-1)**`,
    );
  });

  it("mirrors Zulip's conversion of Slack-style text", () => {
    expect(zulipRendering("a *b* _c_ ~d~ <https://x.example|e>")).toBe(
      "a **b** *c* ~~d~~ [e](https://x.example)",
    );
    expect(zulipRendering("a \\*b\\* \\_c\\_")).toBe("a \\*b\\* \\_c\\_");
  });

  it("tells a retry from a refusal for good", async () => {
    chat.failNext("discord", 429);
    const busy = await postChat(
      { url: chat.urlFor("discord"), format: "discord" },
      { type: "test", sentBy: null, where: "x" },
    );
    expect(busy).toMatchObject({ ok: false, status: 429, permanent: false });
    chat.failNext("googlechat", 404);
    const gone = await postChat(
      { url: chat.urlFor("googlechat"), format: "googlechat" },
      { type: "test", sentBy: null, where: "x" },
    );
    expect(gone).toMatchObject({ ok: false, status: 404, permanent: true });
  });

  it("is refused by a chat when the format doesn't match its URL", async () => {
    const result = await postChat(
      { url: chat.urlFor("discord"), format: "mattermost" },
      { type: "test", sentBy: null, where: "x" },
    );
    expect(result).toMatchObject({ ok: false, status: 400, permanent: true });
    expect(chat.posts[0].refused).toBe("empty message");
  });
});

function hook(over: Partial<WebhookRecord>): WebhookRecord {
  return {
    id: "wh-1",
    url: "https://receiver.example.com/optio",
    workspaceId: null,
    events: ["task.failed"],
    secret: null,
    description: null,
    active: true,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe("outbound webhooks", () => {
  const recognised: Array<[ChatFormat, string, string]> = [
    ["discord", "https://discord.com/api/webhooks/1234/tok", "embeds"],
    ["googlechat", "https://chat.googleapis.com/v1/spaces/S/messages?key=k&token=t", "cardsV2"],
    ["mattermost", "https://team.cloud.mattermost.com/hooks/abc", "text"],
    [
      "msteams",
      "https://example.webhook.office.com/webhookb2/a/IncomingWebhook/b/c",
      "attachments",
    ],
    ["rocketchat", "https://open.rocket.chat/hooks/abc/def", "attachments"],
    ["webex", "https://webexapis.com/v1/webhooks/incoming/abc", "markdown"],
    ["zulip", "https://org.zulipchat.com/api/v1/external/slack_incoming?api_key=k", "text"],
  ];

  it.each(recognised)(
    "gives a %s URL its service's body when no format is chosen",
    async (service, url, key) => {
      const d = await deliverWebhook(hook({ url, format: null }), "task.failed", taskData);
      expect(d.success).toBe(true);
      const [post] = chat.posts;
      expect(post.service).toBe(service);
      expect(post.refused).toBeUndefined();
      expect(post.body).toHaveProperty(key);
      expect(post.body).not.toHaveProperty("event");
    },
  );

  it.each(CHAT_FORMAT_IDS.filter((f) => f !== "slack"))(
    "sends format %s to its service when chosen",
    async (format) => {
      const d = await deliverWebhook(
        hook({ url: chat.urlFor(format), format }),
        "task.pr_opened",
        taskData,
      );
      expect(d.success).toBe(true);
      expect(chat.posts[0]).toMatchObject({ service: format, status: expect.any(Number) });
      expect(chat.posts[0].refused).toBeUndefined();
    },
  );

  it("keeps an explicit format over the URL's", async () => {
    await deliverWebhook(
      hook({ url: "https://discord.com/api/webhooks/1234/tok", format: "generic" }),
      "task.failed",
      taskData,
    );
    expect(chat.posts[0].body).toMatchObject({ event: "task.failed", data: taskData });
    // Discord refuses Optio's JSON, as it always did; the choice is the admin's.
    expect(chat.posts[0].refused).toBe("empty message");
  });

  it("sends Slack and unrecognised URLs what they got before", async () => {
    await deliverWebhook(
      hook({ url: chat.urlFor("slack"), format: null }),
      "task.failed",
      taskData,
    );
    expect(chat.posts[0]).toMatchObject({ service: "slack", status: 200 });
    expect((chat.posts[0].body as { blocks: unknown[] }).blocks[0]).toMatchObject({
      type: "header",
    });
    await deliverWebhook(
      hook({ url: "https://chat.example.com/hooks/abc", format: null }),
      "task.failed",
      taskData,
    );
    expect(chat.posts[1].body).toMatchObject({ event: "task.failed", data: taskData });
  });

  it("takes Discord's answer with ?wait=true too", async () => {
    const d = await deliverWebhook(
      hook({ url: "https://discord.com/api/webhooks/1234/tok?wait=true", format: null }),
      "task.failed",
      taskData,
    );
    expect(d).toMatchObject({ success: true, statusCode: 200 });
  });
});
