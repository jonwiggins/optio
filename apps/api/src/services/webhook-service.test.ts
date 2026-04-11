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

// Mock encrypt/decrypt from secret-service
const mockEncrypt = vi.fn().mockImplementation((plaintext: string) => ({
  alg: 1,
  ciphertext: Buffer.from(`enc:${plaintext}`),
  iv: Buffer.from("mock-iv-1234567"),
  authTag: Buffer.from("mock-auth-tag12"),
}));
const mockDecrypt = vi.fn().mockImplementation((blob: { ciphertext: Buffer }) => {
  const str = blob.ciphertext.toString();
  return str.startsWith("enc:") ? str.slice(4) : str;
});

vi.mock("./secret-service.js", () => ({
  ALG_AES_256_GCM_V1: 1,
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
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

/** Helper to build a mock DB row with encrypted secret columns */
function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "wh-1",
    url: "https://example.com/hook",
    workspaceId: null,
    events: ["task.completed"],
    encryptedSecret: null as Buffer | null,
    secretIv: null as Buffer | null,
    secretAuthTag: null as Buffer | null,
    description: null,
    active: true,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** Helper to build a DB row with an encrypted secret */
function makeDbRowWithSecret(secret: string, overrides: Record<string, unknown> = {}) {
  return makeDbRow({
    encryptedSecret: Buffer.from(`enc:${secret}`),
    secretIv: Buffer.from("mock-iv-1234567"),
    secretAuthTag: Buffer.from("mock-auth-tag12"),
    ...overrides,
  });
}

describe("signPayload", () => {
  it("produces a valid HMAC-SHA256 hex signature", async () => {
    const payload = JSON.stringify({ event: "task.completed", data: { taskId: "123" } });
    const secret = "test-secret-key";
    const signature = await signPayload(payload, secret);

    const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    expect(signature).toBe(expected);
  });

  it("produces different signatures for different secrets", async () => {
    const payload = JSON.stringify({ event: "task.completed" });
    const sig1 = await signPayload(payload, "secret-1");
    const sig2 = await signPayload(payload, "secret-2");
    expect(sig1).not.toBe(sig2);
  });

  it("produces different signatures for different payloads", async () => {
    const secret = "same-secret";
    const sig1 = await signPayload(JSON.stringify({ event: "task.completed" }), secret);
    const sig2 = await signPayload(JSON.stringify({ event: "task.failed" }), secret);
    expect(sig1).not.toBe(sig2);
  });

  it("returns a 64-character hex string", async () => {
    const signature = await signPayload("test", "secret");
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("VALID_EVENTS", () => {
  it("contains all expected task and workflow run webhook events", () => {
    expect(VALID_EVENTS).toContain("task.completed");
    expect(VALID_EVENTS).toContain("task.failed");
    expect(VALID_EVENTS).toContain("task.needs_attention");
    expect(VALID_EVENTS).toContain("task.pr_opened");
    expect(VALID_EVENTS).toContain("review.completed");
    expect(VALID_EVENTS).toContain("workflow_run.queued");
    expect(VALID_EVENTS).toContain("workflow_run.started");
    expect(VALID_EVENTS).toContain("workflow_run.completed");
    expect(VALID_EVENTS).toContain("workflow_run.failed");
    expect(VALID_EVENTS).toHaveLength(9);
  });
});

describe("webhook CRUD", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createWebhook", () => {
    it("creates a webhook and encrypts the secret", async () => {
      const dbRow = makeDbRowWithSecret("my-secret");
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([dbRow]),
        }),
      });

      const result = await createWebhook({
        url: "https://example.com/hook",
        events: ["task.completed"],
        secret: "my-secret",
      });

      expect(mockEncrypt).toHaveBeenCalledWith(
        "my-secret",
        Buffer.from("webhook:https://example.com/hook:secret"),
      );
      expect(result.secret).toBe("my-secret");
      expect(result.id).toBe("wh-1");
    });

    it("creates a webhook without secret", async () => {
      const dbRow = makeDbRow();
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([dbRow]),
        }),
      });

      const result = await createWebhook({
        url: "https://example.com/hook",
        events: ["task.completed"],
      });

      expect(mockEncrypt).not.toHaveBeenCalled();
      expect(result.secret).toBeNull();
    });

    it("passes createdBy when provided", async () => {
      let capturedValues: any;
      (db.insert as any) = vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((vals: any) => {
          capturedValues = vals;
          return { returning: vi.fn().mockResolvedValue([makeDbRow()]) };
        }),
      });

      await createWebhook({ url: "https://example.com", events: ["task.completed"] }, "user-1");

      expect(capturedValues.createdBy).toBe("user-1");
    });
  });

  describe("listWebhooks", () => {
    it("returns all webhooks with decrypted secrets ordered by createdAt", async () => {
      const hooks = [makeDbRowWithSecret("secret-1", { id: "wh-1" }), makeDbRow({ id: "wh-2" })];
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockResolvedValue(hooks),
        }),
      });

      const result = await listWebhooks();
      expect(result).toHaveLength(2);
      expect(result[0].secret).toBe("secret-1");
      expect(result[1].secret).toBeNull();
    });
  });

  describe("getWebhook", () => {
    it("returns webhook with decrypted secret when found", async () => {
      (db.select as any) = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              makeDbRowWithSecret("real-secret", { url: "https://example.com" }),
            ]),
        }),
      });

      const result = await getWebhook("wh-1");
      expect(result!.url).toBe("https://example.com");
      expect(result!.secret).toBe("real-secret");
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

  it("delivers a standard webhook with signature using decrypted secret", async () => {
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
      workspaceId: null,
      secret: "my-secret",
      events: ["task.completed"],
      description: null,
      active: true,
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await deliverWebhook(webhook, "task.completed", {
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
      workspaceId: null,
      secret: null,
      events: ["task.completed"],
      description: null,
      active: true,
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await deliverWebhook(webhook, "task.completed", { taskId: "t-1", taskTitle: "My Task" });

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
      {
        id: "wh-1",
        url: "https://example.com",
        workspaceId: null,
        secret: null,
        events: [],
        description: null,
        active: true,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
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
      {
        id: "wh-1",
        url: "https://example.com",
        workspaceId: null,
        secret: null,
        events: [],
        description: null,
        active: true,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
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
      {
        id: "wh-1",
        url: "https://example.com",
        workspaceId: null,
        secret: null,
        events: [],
        description: null,
        active: true,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
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

  it("returns active webhooks subscribed to the event with decrypted secrets", async () => {
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([
          makeDbRowWithSecret("s1", {
            id: "wh-1",
            events: ["task.completed", "task.failed"],
            active: true,
          }),
          makeDbRow({ id: "wh-2", events: ["task.failed"], active: true }),
        ]),
      }),
    });

    const result = await getWebhooksForEvent("task.completed");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("wh-1");
    expect(result[0].secret).toBe("s1");
  });

  it("returns empty array when no webhooks match", async () => {
    (db.select as any) = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockResolvedValue([makeDbRow({ id: "wh-1", events: ["task.failed"], active: true })]),
      }),
    });

    const result = await getWebhooksForEvent("task.completed");
    expect(result).toHaveLength(0);
  });
});
