import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as notificationService from "../services/notification-service.js";
import * as apnsStore from "../services/apns-store.js";
import { apnsService, defaultApnsEnvironment } from "../services/apns-service.js";
import { requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import {
  NotificationSubscriptionSchema,
  NotificationPreferencesSchema,
} from "../schemas/workspace.js";

const subscribeSchema = z
  .object({
    endpoint: z.string().url().describe("Push service endpoint URL"),
    keys: z
      .object({
        p256dh: z.string().min(1),
        auth: z.string().min(1),
      })
      .describe("Web push keys"),
    userAgent: z.string().optional(),
  })
  .describe("Body for registering a push subscription");

const unsubscribeSchema = z
  .object({
    endpoint: z.string().url().describe("Push service endpoint URL to unregister"),
  })
  .describe("Body for removing a push subscription");

const preferencesSchema = z
  .record(z.string(), z.object({ push: z.boolean() }))
  .describe("Map of event-type → { push: boolean }");

// ── APNs (iOS) ───────────────────────────────────────────────────────────────

const apnsTokenSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{32,512}$/, "hex token expected")
  .transform((t) => t.toLowerCase());
const apnsEnvironmentSchema = z.enum(["sandbox", "production"]);
const liveActivityKindSchema = z.enum(["watch"]);

const registerDeviceSchema = z
  .object({
    token: apnsTokenSchema.describe("APNs device token (hex)"),
    platform: z.enum(["ios"]).default("ios"),
    environment: apnsEnvironmentSchema
      .optional()
      .describe("APNs host the token belongs to; defaults to the server's OPTIO_APNS_ENVIRONMENT"),
    bundleId: z.string().min(1).max(200),
    appVersion: z.string().max(50).optional(),
    deviceName: z.string().max(120).optional(),
  })
  .describe("Body for registering an iOS device for push (upsert by token)");

const liveActivityTokenSchema = z
  .object({
    token: apnsTokenSchema.describe("ActivityKit push token (hex)"),
    environment: apnsEnvironmentSchema.optional(),
    subjectId: z.string().max(200).optional(),
  })
  .describe("Body for registering a Live Activity update token");

const liveActivityTokenDeleteSchema = z.object({ token: apnsTokenSchema });

const pushToStartSchema = z
  .object({
    token: apnsTokenSchema.describe("ActivityKit push-to-start token (hex)"),
    environment: apnsEnvironmentSchema.optional(),
  })
  .describe("Body for registering a Live Activity push-to-start token");

const ApnsDeviceSchema = z
  .object({
    id: z.string(),
    token: z.string().describe("Masked"),
    platform: z.string(),
    environment: apnsEnvironmentSchema,
    bundleId: z.string(),
    appVersion: z.string().nullable(),
    deviceName: z.string().nullable(),
    failureCount: z.number().int(),
    lastSeenAt: z.date(),
    createdAt: z.date(),
  })
  .describe("A registered iOS device (token masked)");

const DeviceResponseSchema = z.object({ device: ApnsDeviceSchema });
const DevicesResponseSchema = z.object({ devices: z.array(ApnsDeviceSchema) });

const VapidKeyResponseSchema = z.object({ publicKey: z.string() });
const OkResponseSchema = z.object({ ok: z.boolean() });
const SubscriptionsResponseSchema = z.object({
  subscriptions: z.array(NotificationSubscriptionSchema),
});
const PreferencesResponseSchema = z.object({ preferences: NotificationPreferencesSchema });
const TestResponseSchema = z.object({ sent: z.number().int() });

export async function notificationRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const member = { preHandler: [requireRole("member")] };

  app.get(
    "/api/notifications/vapid-public-key",
    {
      schema: {
        operationId: "getVapidPublicKey",
        summary: "Get the VAPID public key",
        description:
          "Return the server's VAPID public key so browsers can subscribe to " +
          "web push notifications. Returns 503 if VAPID keys are not configured. " +
          "This endpoint is public — no authentication required.",
        tags: ["Workspaces"],
        security: [],
        response: { 200: VapidKeyResponseSchema, 503: ErrorResponseSchema },
      },
    },
    async (_req, reply) => {
      const publicKey = notificationService.getVapidPublicKey();
      if (!publicKey) {
        return reply.status(503).send({ error: "Push notifications not configured" });
      }
      return reply.send({ publicKey });
    },
  );

  app.post(
    "/api/notifications/subscribe",
    {
      schema: {
        operationId: "subscribeToPushNotifications",
        summary: "Register a push subscription",
        description: "Register a browser's push subscription for the authenticated user.",
        tags: ["Workspaces"],
        body: subscribeSchema,
        response: { 201: OkResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });

      await notificationService.subscribe(userId, req.body, req.body.userAgent);
      return reply.status(201).send({ ok: true });
    },
  );

  app.delete(
    "/api/notifications/subscribe",
    {
      schema: {
        operationId: "unsubscribeFromPushNotifications",
        summary: "Remove a push subscription",
        description: "Remove a previously-registered push subscription. Returns 204 on success.",
        tags: ["Workspaces"],
        body: unsubscribeSchema,
        response: { 204: z.null(), 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });

      await notificationService.unsubscribe(userId, req.body.endpoint);
      return reply.status(204).send(null);
    },
  );

  app.get(
    "/api/notifications/subscriptions",
    {
      schema: {
        operationId: "listPushSubscriptions",
        summary: "List my push subscriptions",
        description: "Return all push subscriptions for the authenticated user.",
        tags: ["Workspaces"],
        response: { 200: SubscriptionsResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });

      const subscriptions = await notificationService.listSubscriptions(userId);
      return reply.send({ subscriptions });
    },
  );

  app.get(
    "/api/notifications/preferences",
    {
      schema: {
        operationId: "getNotificationPreferences",
        summary: "Get notification preferences",
        description: "Return the authenticated user's per-event-type notification preferences.",
        tags: ["Workspaces"],
        response: { 200: PreferencesResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });

      const preferences = await notificationService.getPreferences(userId);
      return reply.send({ preferences });
    },
  );

  app.put(
    "/api/notifications/preferences",
    {
      schema: {
        operationId: "updateNotificationPreferences",
        summary: "Update notification preferences",
        description: "Update the authenticated user's notification preferences.",
        tags: ["Workspaces"],
        body: preferencesSchema,
        response: { 200: PreferencesResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });

      const preferences = await notificationService.updatePreferences(userId, req.body);
      return reply.send({ preferences });
    },
  );

  app.post(
    "/api/notifications/test",
    {
      schema: {
        operationId: "sendTestNotification",
        summary: "Send a test push notification",
        description:
          "Deliver a test push notification to every subscription registered " +
          "by the caller. Returns 503 if VAPID is not configured.",
        tags: ["Workspaces"],
        response: {
          200: TestResponseSchema,
          401: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });

      if (!notificationService.isVapidConfigured()) {
        return reply.status(503).send({ error: "Push notifications not configured" });
      }

      const sent = await notificationService.sendTestNotification(userId);
      return reply.send({ sent });
    },
  );

  // ── APNs devices (iOS) ─────────────────────────────────────────────────────

  app.post(
    "/api/notifications/devices",
    {
      ...member,
      schema: {
        operationId: "registerApnsDevice",
        summary: "Register an iOS device for push",
        description:
          "Upsert the caller's APNs device token. A token that re-registers under " +
          "another user moves to them. Resets the failure counter.",
        tags: ["Workspaces"],
        body: registerDeviceSchema,
        response: { 201: DeviceResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      const device = await apnsStore.registerDevice(userId, {
        token: req.body.token,
        platform: req.body.platform,
        environment: req.body.environment ?? defaultApnsEnvironment(),
        bundleId: req.body.bundleId,
        appVersion: req.body.appVersion,
        deviceName: req.body.deviceName,
        workspaceId: req.user?.workspaceId ?? null,
      });
      return reply.status(201).send({ device });
    },
  );

  app.get(
    "/api/notifications/devices",
    {
      schema: {
        operationId: "listApnsDevices",
        summary: "List my iOS devices",
        description: "Return the caller's registered APNs devices with masked tokens.",
        tags: ["Workspaces"],
        response: { 200: DevicesResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      const devices = await apnsStore.listDevicesForUser(userId);
      return reply.send({ devices });
    },
  );

  app.delete(
    "/api/notifications/devices/:token",
    {
      ...member,
      schema: {
        operationId: "unregisterApnsDevice",
        summary: "Remove an iOS device",
        description: "Delete one of the caller's APNs device tokens. 204 even when absent.",
        tags: ["Workspaces"],
        params: z.object({ token: apnsTokenSchema }),
        response: { 204: z.null(), 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      await apnsStore.unregisterDevice(userId, req.params.token);
      return reply.status(204).send(null);
    },
  );

  // ── Live Activity tokens ───────────────────────────────────────────────────

  app.post(
    "/api/notifications/live-activities/:kind/token",
    {
      ...member,
      schema: {
        operationId: "registerLiveActivityToken",
        summary: "Register a Live Activity update token",
        description:
          "Upsert the ActivityKit push token for a running activity. Only kind " +
          "`watch` exists today (one aggregate activity per user).",
        tags: ["Workspaces"],
        params: z.object({ kind: liveActivityKindSchema }),
        body: liveActivityTokenSchema,
        response: { 201: OkResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      await apnsStore.registerLiveActivityToken(userId, {
        kind: req.params.kind,
        token: req.body.token,
        environment: req.body.environment ?? defaultApnsEnvironment(),
        subjectId: req.body.subjectId,
      });
      return reply.status(201).send({ ok: true });
    },
  );

  app.delete(
    "/api/notifications/live-activities/:kind/token",
    {
      ...member,
      schema: {
        operationId: "unregisterLiveActivityToken",
        summary: "Remove a Live Activity update token",
        description: "Call when the app observes the activity ended or was dismissed.",
        tags: ["Workspaces"],
        params: z.object({ kind: liveActivityKindSchema }),
        body: liveActivityTokenDeleteSchema,
        response: { 204: z.null(), 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      await apnsStore.unregisterLiveActivityToken(userId, req.params.kind, req.body.token);
      return reply.status(204).send(null);
    },
  );

  app.post(
    "/api/notifications/live-activities/:kind/push-to-start",
    {
      ...member,
      schema: {
        operationId: "registerLiveActivityStartToken",
        summary: "Register a Live Activity push-to-start token",
        description:
          "Upsert the ActivityKit push-to-start token so the server can start the " +
          "activity when the first agent begins running.",
        tags: ["Workspaces"],
        params: z.object({ kind: liveActivityKindSchema }),
        body: pushToStartSchema,
        response: { 201: OkResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      await apnsStore.registerLiveActivityStartToken(userId, {
        kind: req.params.kind,
        token: req.body.token,
        environment: req.body.environment ?? defaultApnsEnvironment(),
      });
      return reply.status(201).send({ ok: true });
    },
  );

  app.post(
    "/api/notifications/devices/test",
    {
      ...member,
      schema: {
        operationId: "sendTestApnsNotification",
        summary: "Send a test push to my iOS devices",
        description:
          "Deliver a test alert to every APNs device the caller registered. " +
          "Returns 503 if APNs is not configured.",
        tags: ["Workspaces"],
        response: {
          200: TestResponseSchema,
          401: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      if (!apnsService.isConfigured()) {
        return reply.status(503).send({ error: "APNs not configured" });
      }
      // sendAlert has no preference gate (glance-service applies it), so a test always ships.
      const sent = await apnsService.sendAlert(userId, {
        title: "Optio test notification",
        body: "If you see this, iOS push is working.",
        category: "TEST",
        threadId: "test",
        url: "optio://settings",
        kind: "test",
        id: "test",
      });
      return reply.send({ sent });
    },
  );
}
