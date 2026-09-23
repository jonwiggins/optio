import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as notificationService from "../services/notification-service.js";
import * as apnsStore from "../services/apns-store.js";
import * as fcmStore from "../services/fcm-store.js";
import { apnsService, defaultApnsEnvironment } from "../services/apns-service.js";
import { fcmService } from "../services/fcm-service.js";
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

// ── Native push devices: APNs (iOS) + FCM (Android) ─────────────────────────

const APNS_TOKEN_RE = /^[0-9a-fA-F]{32,512}$/;
/** FCM registration tokens are opaque URL-safe strings (`<instance>:APA91b…`), case-sensitive. */
const FCM_TOKEN_RE = /^[A-Za-z0-9_:.-]{32,1024}$/;
const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const apnsTokenSchema = z
  .string()
  .regex(APNS_TOKEN_RE, "hex token expected")
  .transform((t) => t.toLowerCase());
const fcmTokenSchema = z.string().regex(FCM_TOKEN_RE, "FCM registration token expected");
const apnsEnvironmentSchema = z.enum(["sandbox", "production"]);
const liveActivityKindSchema = z.enum(["watch"]);

const registerIosDeviceSchema = z
  .object({
    token: apnsTokenSchema.describe("APNs device token (hex)"),
    platform: z.enum(["ios"]).optional().default("ios"),
    environment: apnsEnvironmentSchema
      .optional()
      .describe("APNs host the token belongs to; defaults to the server's OPTIO_APNS_ENVIRONMENT"),
    bundleId: z.string().min(1).max(200),
    appVersion: z.string().max(50).optional(),
    deviceName: z.string().max(120).optional(),
  })
  .describe("An iOS device (APNs); `platform` may be omitted");

const registerAndroidDeviceSchema = z
  .object({
    token: fcmTokenSchema.describe("FCM registration token"),
    platform: z.literal("android"),
    appId: z.string().min(1).max(200).describe("Android application id, e.g. dev.optio.android"),
    appVersion: z.string().max(50).optional(),
    deviceName: z.string().max(120).optional(),
    serverId: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("The app's own id for this server; echoed as `serverId` in every FCM message"),
  })
  .describe("An Android device (FCM)");

const registerDeviceSchema = z
  .discriminatedUnion("platform", [registerIosDeviceSchema, registerAndroidDeviceSchema])
  .describe("Body for registering a device for native push (upsert by token)");

/** A raw APNs / FCM token, or a device `id` from the (masked) device list. */
const deviceRefSchema = z
  .string()
  .max(1024)
  .refine(
    (v) => APNS_TOKEN_RE.test(v) || FCM_TOKEN_RE.test(v) || DEVICE_ID_RE.test(v),
    "device token or id expected",
  );

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

const PushDeviceSchema = z
  .object({
    id: z.string(),
    token: z.string().describe("Masked; delete a listed device by `id`"),
    platform: z.enum(["ios", "android"]),
    environment: apnsEnvironmentSchema.optional().describe("iOS only"),
    bundleId: z.string().optional().describe("iOS only"),
    appId: z.string().optional().describe("Android only"),
    serverId: z
      .string()
      .nullable()
      .optional()
      .describe("Android only: the app's id for this server, as registered"),
    appVersion: z.string().nullable(),
    deviceName: z.string().nullable(),
    failureCount: z.number().int(),
    lastSeenAt: z.date(),
    createdAt: z.date(),
  })
  .describe("A registered iOS (APNs) or Android (FCM) device, token masked");

const PushProvidersSchema = z
  .object({
    apns: z.boolean().describe("iOS push is configured"),
    fcm: z.boolean().describe("Android push is configured"),
  })
  .describe("Which native push providers this server can send through");

const DeviceResponseSchema = z.object({ device: PushDeviceSchema });
const DevicesResponseSchema = z.object({
  devices: z.array(PushDeviceSchema),
  push: PushProvidersSchema,
});

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

  // ── Push devices (iOS APNs + Android FCM) ─────────────────────────────────

  app.post(
    "/api/notifications/devices",
    {
      ...member,
      schema: {
        operationId: "registerPushDevice",
        summary: "Register an iOS or Android device for push",
        description:
          "Upsert the caller's device token: an APNs token for `platform: ios` " +
          "(the default) or an FCM registration token for `platform: android`. " +
          "A token that re-registers under another user moves to them. Resets " +
          "the failure counter.",
        tags: ["Workspaces"],
        body: registerDeviceSchema,
        response: { 201: DeviceResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      const body = req.body;
      const workspaceId = req.user?.workspaceId ?? null;
      if (body.platform === "android") {
        const device = await fcmStore.registerFcmDevice(userId, {
          token: body.token,
          appId: body.appId,
          appVersion: body.appVersion,
          deviceName: body.deviceName,
          serverId: body.serverId,
          workspaceId,
        });
        return reply.status(201).send({ device });
      }
      const device = await apnsStore.registerDevice(userId, {
        token: body.token,
        platform: body.platform,
        environment: body.environment ?? defaultApnsEnvironment(),
        bundleId: body.bundleId,
        appVersion: body.appVersion,
        deviceName: body.deviceName,
        workspaceId,
      });
      return reply.status(201).send({ device });
    },
  );

  app.get(
    "/api/notifications/devices",
    {
      schema: {
        operationId: "listPushDevices",
        summary: "List my iOS and Android devices",
        description:
          "Return the caller's registered devices — iOS (APNs) and Android (FCM), " +
          "each with a `platform` — with masked tokens, plus which providers the " +
          "server is configured for.",
        tags: ["Workspaces"],
        response: { 200: DevicesResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      const [ios, android] = await Promise.all([
        apnsStore.listDevicesForUser(userId),
        fcmStore.listFcmDevicesForUser(userId),
      ]);
      return reply.send({
        devices: [...ios, ...android],
        push: { apns: apnsService.isConfigured(), fcm: fcmService.isConfigured() },
      });
    },
  );

  app.delete(
    "/api/notifications/devices/:token",
    {
      ...member,
      schema: {
        operationId: "unregisterPushDevice",
        summary: "Remove an iOS or Android device",
        description:
          "Delete one of the caller's devices by its raw token (APNs hex or FCM " +
          "registration token) or by its `id` from the device list. 204 even when absent.",
        tags: ["Workspaces"],
        params: z.object({ token: deviceRefSchema }),
        response: { 204: z.null(), 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      const ref = req.params.token;
      if (DEVICE_ID_RE.test(ref)) {
        await Promise.all([
          apnsStore.unregisterDeviceById(userId, ref),
          fcmStore.unregisterFcmDeviceById(userId, ref),
        ]);
      } else if (APNS_TOKEN_RE.test(ref)) {
        await apnsStore.unregisterDevice(userId, ref.toLowerCase());
      } else {
        await fcmStore.unregisterFcmDevice(userId, ref);
      }
      return reply.status(204).send(null);
    },
  );

  // ── Watch state (read model for widgets) ──────────────────────────────────

  app.get(
    "/api/glance/watch",
    {
      schema: {
        operationId: "getWatchState",
        summary: "The caller's Watch frame",
        description:
          "The same `WatchState` the server pushes to the iOS Live Activity: the " +
          "oldest session needing you, counts, and the session board tiles " +
          "(waiting / recurring / agents). Widgets read this so they can render " +
          "without the app running. Dates are Apple reference-date seconds.",
        tags: ["Workspaces"],
        response: { 200: z.record(z.unknown()), 401: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.status(401).send({ error: "Authentication required" });
      const { computeWatchState } = await import("../services/glance-service.js");
      const state = await computeWatchState(userId);
      return state as unknown as Record<string, unknown>;
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
        operationId: "sendTestDevicePush",
        summary: "Send a test push to my iOS and Android devices",
        description:
          "Deliver a test alert to every device the caller registered, through " +
          "APNs (iOS) and FCM (Android). `sent` counts accepted sends across both. " +
          "Returns 503 if neither provider is configured.",
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
      if (!apnsService.isConfigured() && !fcmService.isConfigured()) {
        return reply
          .status(503)
          .send({ error: "Push not configured (APNs for iOS, FCM for Android)" });
      }
      // sendAlert has no preference gate (glance-service applies it), so a test always ships.
      const test = (platform: string) => ({
        title: "Optio test notification",
        body: `If you see this, ${platform} push is working.`,
        category: "TEST" as const,
        threadId: "test",
        url: "optio://settings",
        kind: "test" as const,
        id: "test",
      });
      const [ios, android] = await Promise.all([
        apnsService.isConfigured() ? apnsService.sendAlert(userId, test("iOS")) : 0,
        fcmService.isConfigured() ? fcmService.sendAlert(userId, test("Android")) : 0,
      ]);
      return reply.send({ sent: ios + android });
    },
  );
}
