import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hook in webhook-service.ts `deliverWebhook`: a webhook's `format`
 * decides the body (chat-formats.ts); without one, upstream's guess from
 * the hostname stays. The signature covers whatever body was sent.
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

import { setOutboundDefaults } from "../../utils/outbound-url.js";
import { deliverWebhook, signPayload, type WebhookRecord } from "../webhook-service.js";

const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
let restore: () => void;

beforeEach(() => {
  calls.length = 0;
  inserted.length = 0;
  vi.stubEnv("PUBLIC_URL", "https://optio.example.com");
  restore = setOutboundDefaults({
    fetchImpl: async (url, init) => {
      calls.push({
        url,
        body: String(init.body),
        headers: init.headers as Record<string, string>,
      });
      return new Response("ok", { status: 200 });
    },
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
  });
});

afterEach(() => {
  restore();
  vi.unstubAllEnvs();
});

function hook(over: Partial<WebhookRecord>): WebhookRecord {
  return {
    id: "wh-1",
    url: "https://chat.example.com/hooks/abc",
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

const data = { taskId: "t-1", taskTitle: "Fix login", repoUrl: "https://gitlab.example.com/a/b" };

describe("deliverWebhook with a format", () => {
  it("sends Mattermost a text body to any URL", async () => {
    const d = await deliverWebhook(hook({ format: "mattermost" }), "task.failed", data);
    expect(d.success).toBe(true);
    const body = JSON.parse(calls[0].body);
    expect(Object.keys(body)).toEqual(["text"]);
    expect(body.text).toContain("[Fix login](https://optio.example.com/work/t-1)");
    // The delivery log keeps what was sent.
    expect((inserted[0] as { payload: unknown }).payload).toEqual(body);
  });

  it("sends Teams an Adaptive Card, signed like any other body", async () => {
    await deliverWebhook(hook({ format: "msteams", secret: "s3cret" }), "task.failed", data);
    const { body, headers } = calls[0];
    expect(JSON.parse(body).attachments[0].contentType).toBe(
      "application/vnd.microsoft.card.adaptive",
    );
    expect(headers["X-Optio-Signature"]).toBe(await signPayload(body, "s3cret"));
  });

  it("sends the generic JSON to a Slack URL when told to", async () => {
    await deliverWebhook(
      hook({ format: "generic", url: "https://hooks.slack.com/services/x" }),
      "task.failed",
      data,
    );
    expect(JSON.parse(calls[0].body)).toMatchObject({ event: "task.failed", data });
  });

  it("keeps upstream's guess without a format", async () => {
    await deliverWebhook(hook({ url: "https://hooks.slack.com/services/x" }), "task.failed", data);
    expect(JSON.parse(calls[0].body).blocks).toBeDefined();
    await deliverWebhook(hook({ format: null }), "task.failed", data);
    expect(JSON.parse(calls[1].body)).toMatchObject({ event: "task.failed" });
  });
});
