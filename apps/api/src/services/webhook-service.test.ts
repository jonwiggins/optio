import crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../db/schema.js", () => ({
  webhooks: {
    id: "webhooks.id",
    active: "webhooks.active",
    createdAt: "webhooks.created_at",
  },
  webhookDeliveries: {
    id: "webhook_deliveries.id",
    webhookId: "webhook_deliveries.webhook_id",
    deliveredAt: "webhook_deliveries.delivered_at",
  },
}));

vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { db } from "../db/client.js";
import {
  signPayload,
  VALID_EVENTS,
  createWebhook,
  listWebhooks,
  getWebhook,
  deleteWebhook,
  getWebhookDeliveries,
  deliverWebhook,
  getWebhooksForEvent,
} from "./webhook-service.js";

describe("signPayload", () => {
  it("produces a valid HMAC-SHA256 hex signature", () => {
    const payload = JSON.stringify({ event: "task.completed", data: { taskId: "123" } });
    const secret = "test-secret-key";
    const signature = signPayload(payload, secret);

    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    expect(signature).toBe(expected);
  });

  it("produces different signatures for different secrets", () => {
    const payload = JSON.stringify({ event: "task.completed" });
    const sig1 = signPayload(payload, "secret-1");
    const sig2 = signPayload(payload, "secret-2");
    expect(sig1).not.toBe(sig2);
  });

  it("produces different signatures for different payloads", () => {
    const secret = "same-secret";
    const sig1 = signPayload(JSON.stringify({ event: "task.completed" }), secret);
    const sig2 = signPayload(JSON.stringify({ event: "task.failed" }), secret);
    expect(sig1).not.toBe(sig2);
  });

  it("returns a 64-character hex string", () => {
    const signature = signPayload("test", "secret");
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("VALID_EVENTS", () => {
  it("contains all expected webhook events", () => {
    expect(VALID_EVENTS).toContain("task.completed");
    expect(VALID_EVENTS).toContain("task.failed");
    expect(VALID_EVENTS).toContain("task.needs_attention");
    expect(VALID_EVENTS).toContain("task.pr_opened");
    expect(VALID_EVENTS).toContain("review.completed");
    expect(VALID_EVENTS).toHaveLength(5);
  });
});

describe("webhook CRUD", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createWebhook", () => {
    it("creates a webhook with defaults", async () => {
      const webhook = { id: "wh-1", url: "https://example.com/hook" };
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([webhook]),
        }),
      });

      const result = await createWebhook({
        url: "https://example.com/hook",
        events: ["task.completed"],
      });

      expect(result).toEqual(webhook);
    });

    it("passes createdBy when provided", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([{ id: "wh-1" }]) };
        }),
      });

      await createWebhook({ url: "https://example.com", events: ["task.completed"] }, "user-1");

      expect(capturedValues.createdBy).toBe("user-1");
    });
  });

  describe("listWebhooks", () => {
    it("returns all webhooks ordered by createdAt", async () => {
      const hooks = [{ id: "wh-1" }, { id: "wh-2" }];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue(hooks),
        }),
      });

      const result = await listWebhooks();
      expect(result).toEqual(hooks);
    });
  });

  describe("getWebhook", () => {
    it("returns webhook when found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "wh-1", url: "https://example.com" }]),
        }),
      });

      const result = await getWebhook("wh-1");
      expect(result!.url).toBe("https://example.com");
    });

    it("returns null when not found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await getWebhook("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("deleteWebhook", () => {
    it("returns true when deleted", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "wh-1" }]),
        }),
      });

      const result = await deleteWebhook("wh-1");
      expect(result).toBe(true);
    });

    it("returns false when not found", async () => {
      (db.delete as any) = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await deleteWebhook("nonexistent");
      expect(result).toBe(false);
    });
  });

  describe("getWebhookDeliveries", () => {
    it("returns deliveries for a webhook", async () => {
      const deliveries = [{ id: "d-1" }, { id: "d-2" }];
      const mockLimit = vi.fn().mockResolvedValue(deliveries);
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: mockLimit,
            }),
          }),
        }),
      });

      const result = await getWebhookDeliveries("wh-1", { limit: 10 });
      expect(result).toEqual(deliveries);
    });
  });
});

describe("deliverWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers a standard webhook with signature", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("OK"),
    });
    globalThis.fetch = mockFetch;

    (db.insert as any) = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "d-1", success: true }]),
      }),
    });

    const webhook = {
      id: "wh-1",
      url: "https://example.com/hook",
      secret: "my-secret",
      events: ["task.completed"],
      active: true,
    };

    const result = await deliverWebhook(webhook as any, "task.completed", {
      taskId: "t-1",
      taskTitle: "Test",
    });

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://example.com/hook",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Optio-Event": "task.completed",
          "X-Optio-Signature": expect.any(String),
        }),
      }),
    );
  });

  it("delivers a Slack-formatted webhook", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("ok"),
    });
    globalThis.fetch = mockFetch;

    (db.insert as any) = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "d-1", success: true }]),
      }),
    });

    const webhook = {
      id: "wh-1",
      url: "https://hooks.slack.com/services/T00/B00/xxx",
      secret: null,
      events: ["task.completed"],
      active: true,
    };

    await deliverWebhook(webhook as any, "task.completed", { taskId: "t-1", taskTitle: "My Task" });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    // Slack payload should have blocks and text
    expect(body.text).toContain("My Task");
    expect(body.blocks).toBeDefined();
    expect(body.blocks[0].type).toBe("header");
  });

  it("records failed delivery", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    let capturedValues: any;
    (db.insert as any) = vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((vals: any) => {
        capturedValues = vals;
        return { returning: vi.fn().mockResolvedValue([{ id: "d-1", success: false }]) };
      }),
    });

    await deliverWebhook(
      { id: "wh-1", url: "https://example.com", secret: null, events: [], active: true } as any,
      "task.failed",
      { taskId: "t-1" },
    );

    expect(capturedValues.success).toBe(false);
    expect(capturedValues.error).toContain("HTTP 500");
  });

  it("handles fetch exceptions", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Connection refused"));

    let capturedValues: any;
    (db.insert as any) = vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((vals: any) => {
        capturedValues = vals;
        return { returning: vi.fn().mockResolvedValue([{ id: "d-1" }]) };
      }),
    });

    await deliverWebhook(
      { id: "wh-1", url: "https://example.com", secret: null, events: [], active: true } as any,
      "task.failed",
      {},
    );

    expect(capturedValues.success).toBe(false);
    expect(capturedValues.error).toBe("Connection refused");
  });

  it("skips signature header when no secret", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve("OK"),
    });
    globalThis.fetch = mockFetch;

    (db.insert as any) = vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "d-1" }]),
      }),
    });

    await deliverWebhook(
      { id: "wh-1", url: "https://example.com", secret: null, events: [], active: true } as any,
      "task.completed",
      {},
    );

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["X-Optio-Signature"]).toBeUndefined();
  });
});

describe("getWebhooksForEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns active webhooks subscribed to the event", async () => {
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          { id: "wh-1", events: ["task.completed", "task.failed"], active: true },
          { id: "wh-2", events: ["task.failed"], active: true },
        ]),
      }),
    });

    const result = await getWebhooksForEvent("task.completed");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("wh-1");
  });

  it("returns empty array when no webhooks match", async () => {
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ id: "wh-1", events: ["task.failed"], active: true }]),
      }),
    });

    const result = await getWebhooksForEvent("task.completed");
    expect(result).toHaveLength(0);
  });
});
