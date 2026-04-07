import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock web-push before importing the module under test
vi.mock("web-push", () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

// Mock the database
vi.mock("../db/client.js", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// Mock the logger
vi.mock("../logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock the schema
vi.mock("../db/schema.js", () => ({
  pushSubscriptions: {
    id: "id",
    userId: "user_id",
    endpoint: "endpoint",
    p256dh: "p256dh",
    auth: "auth",
    userAgent: "user_agent",
    createdAt: "created_at",
    lastUsedAt: "last_used_at",
    lastErrorAt: "last_error_at",
    failureCount: "failure_count",
  },
  notificationPreferences: {
    id: "id",
    userId: "user_id",
    workspaceId: "workspace_id",
    preferences: "preferences",
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
  tasks: {
    id: "id",
    title: "title",
    repoUrl: "repo_url",
    createdBy: "created_by",
  },
}));

// Note: VAPID env vars are not set in the test environment, so the service
// initializes with vapidConfigured=false. We test the module's behavior
// in "unconfigured" mode and verify the pure logic (defaults, event types).

import {
  isVapidConfigured,
  getVapidPublicKey,
  DEFAULT_PREFERENCES,
  type NotificationEventType,
} from "./notification-service.js";

describe("notification-service", () => {
  describe("VAPID configuration (unconfigured)", () => {
    it("reports VAPID as not configured when env vars are missing", () => {
      // In test environment, VAPID env vars are not set
      expect(isVapidConfigured()).toBe(false);
    });

    it("returns null for public key when not configured", () => {
      expect(getVapidPublicKey()).toBeNull();
    });
  });

  describe("DEFAULT_PREFERENCES", () => {
    it("has push enabled by default for critical events", () => {
      expect(DEFAULT_PREFERENCES["task.pr_opened"].push).toBe(true);
      expect(DEFAULT_PREFERENCES["task.completed"].push).toBe(true);
      expect(DEFAULT_PREFERENCES["task.failed"].push).toBe(true);
      expect(DEFAULT_PREFERENCES["task.needs_attention"].push).toBe(true);
    });

    it("has push disabled by default for non-critical events", () => {
      expect(DEFAULT_PREFERENCES["task.stalled"].push).toBe(false);
      expect(DEFAULT_PREFERENCES["task.review_requested"].push).toBe(false);
      expect(DEFAULT_PREFERENCES["task.commented"].push).toBe(false);
    });

    it("covers all 7 expected event types", () => {
      const eventTypes = Object.keys(DEFAULT_PREFERENCES);
      expect(eventTypes).toContain("task.pr_opened");
      expect(eventTypes).toContain("task.completed");
      expect(eventTypes).toContain("task.failed");
      expect(eventTypes).toContain("task.needs_attention");
      expect(eventTypes).toContain("task.stalled");
      expect(eventTypes).toContain("task.review_requested");
      expect(eventTypes).toContain("task.commented");
      expect(eventTypes).toHaveLength(7);
    });

    it("each preference has a push boolean field", () => {
      for (const [, pref] of Object.entries(DEFAULT_PREFERENCES)) {
        expect(typeof pref.push).toBe("boolean");
      }
    });
  });

  describe("sendPushNotificationForTransition (VAPID not configured)", () => {
    it("exits early when VAPID is not configured", async () => {
      const { sendPushNotificationForTransition } = await import("./notification-service.js");

      // Should not throw even with valid task data
      await expect(
        sendPushNotificationForTransition(
          {
            id: "task-1",
            title: "Test task",
            repoUrl: "https://github.com/acme/widget",
            createdBy: "user-1",
          },
          "completed" as any,
        ),
      ).resolves.toBeUndefined();
    });

    it("exits early when task has no createdBy", async () => {
      const { sendPushNotificationForTransition } = await import("./notification-service.js");

      await expect(
        sendPushNotificationForTransition(
          {
            id: "task-2",
            title: "Test task",
            repoUrl: "https://github.com/acme/widget",
            createdBy: null,
          },
          "completed" as any,
        ),
      ).resolves.toBeUndefined();
    });

    it("exits early for non-notifiable states", async () => {
      const { sendPushNotificationForTransition } = await import("./notification-service.js");

      // "running" is not a notifiable state
      await expect(
        sendPushNotificationForTransition(
          {
            id: "task-3",
            title: "Test task",
            repoUrl: "https://github.com/acme/widget",
            createdBy: "user-1",
          },
          "running" as any,
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("sendPushNotificationForComment (VAPID not configured)", () => {
    it("exits early when VAPID is not configured", async () => {
      const { sendPushNotificationForComment } = await import("./notification-service.js");

      await expect(sendPushNotificationForComment("task-1", "user-1")).resolves.toBeUndefined();
    });
  });

  describe("sendTestNotification (VAPID not configured)", () => {
    it("returns 0 when VAPID is not configured", async () => {
      const { sendTestNotification } = await import("./notification-service.js");

      const sent = await sendTestNotification("user-1");
      expect(sent).toBe(0);
    });
  });
});
