import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users, webhooks, workspaceMembers } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { directorySyncRoutes } from "../routes/directory-sync.js";
import {
  createWebhook,
  deliverWebhook,
  getWebhooksForEvent,
  isWebhookCreatorEnabled,
} from "./webhook-service.js";
import { enqueueWebhookEvent, startWebhookWorker } from "../workers/webhook-worker.js";

const harness = vi.hoisted(() => ({
  add: vi.fn(),
  deliver: vi.fn(),
  processor: null as
    | null
    | ((job: {
        name: string;
        data: Record<string, unknown>;
        attemptsMade: number;
      }) => Promise<void>),
}));
vi.mock("../utils/outbound-url.js", () => ({ guardedFetch: harness.deliver }));
vi.mock("bullmq", async (importOriginal) => ({
  ...(await importOriginal<typeof import("bullmq")>()),
  Queue: class {
    add = harness.add;
  },
  Worker: class {
    constructor(_name: string, processor: typeof harness.processor) {
      harness.processor = processor;
    }
    on() {
      return this;
    }
  },
}));

afterEach(async () => {
  await db.delete(webhooks);
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("webhook delivery after administrative offboarding", () => {
  it("continues selecting and delivering legacy hooks with no tracked creator", async () => {
    vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
    const workspace = await insertWorkspace();
    const hook = await createWebhook(
      { url: "https://example.test/legacy-hook", events: ["task.completed"] },
      undefined,
      workspace.id,
    );
    expect(hook.createdBy).toBeNull();
    expect(await isWebhookCreatorEnabled(hook)).toBe(true);
    expect((await getWebhooksForEvent("task.completed")).map((row) => row.id)).toContain(hook.id);
    harness.deliver.mockImplementation(async () => new Response("ok"));
    await deliverWebhook(hook, "task.completed", { taskId: "legacy-event" });
    expect(harness.deliver).toHaveBeenCalledOnce();
    await enqueueWebhookEvent("task.completed", { taskId: "legacy-event" });
    startWebhookWorker();
    const queued = harness.add.mock.calls.find(
      (call) => (call[1] as { webhookId: string }).webhookId === hook.id,
    )![1];
    await harness.processor!({ name: "deliver", data: queued, attemptsMade: 0 });
    expect(harness.deliver).toHaveBeenCalledTimes(2);
  });
  it("keeps active hooks and memberships but excludes the disabled creator at selection and queued delivery", async () => {
    vi.stubEnv("OPTIO_AUTH_DISABLED", "false");
    const [operator, creator] = await db
      .insert(users)
      .values([
        {
          provider: "google",
          externalId: randomUUID(),
          email: "operator@example.test",
          displayName: "Operator",
          deploymentAdmin: true,
        },
        {
          provider: "google",
          externalId: randomUUID(),
          email: "creator@example.test",
          displayName: "Creator",
        },
      ])
      .returning();
    const workspace = await insertWorkspace();
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: workspace.id, userId: creator.id, role: "member" });
    const hook = await createWebhook(
      { url: "https://example.test/hook", events: ["task.completed"] },
      creator.id,
      workspace.id,
    );
    expect((await getWebhooksForEvent("task.completed")).map((h) => h.id)).toContain(hook.id);
    await enqueueWebhookEvent("task.completed", { taskId: "retained-event" });
    expect(harness.add).toHaveBeenCalledOnce();
    const queued = harness.add.mock.calls[0][1] as Record<string, unknown>;
    const app = await buildRouteTestApp(directorySyncRoutes, {
      user: { id: operator.id, workspaceId: workspace.id, workspaceRole: "admin" },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/users/disable",
        payload: { userId: creator.id },
      });
      expect(response.statusCode, response.body).toBe(200);
    } finally {
      await app.close();
    }
    expect((await db.select().from(users).where(eq(users.id, creator.id)))[0].disabledReason).toBe(
      "admin",
    );
    expect((await db.select().from(webhooks).where(eq(webhooks.id, hook.id)))[0].active).toBe(true);
    expect(
      await db
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, creator.id),
            eq(workspaceMembers.workspaceId, workspace.id),
          ),
        ),
    ).toHaveLength(1);
    expect(await isWebhookCreatorEnabled(hook)).toBe(false);
    expect(await getWebhooksForEvent("task.completed")).toEqual([]);
    startWebhookWorker();
    expect(harness.processor).not.toBeNull();
    await harness.processor!({ name: "deliver", data: queued, attemptsMade: 0 });
    await expect(
      deliverWebhook(hook, "task.completed", { taskId: "retained-event" }),
    ).rejects.toThrow("disabled");
    expect(harness.deliver).not.toHaveBeenCalled();
  });
});
