import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as notificationService from "../services/notification-service.js";

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().optional(),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

const preferencesSchema = z.record(z.string(), z.object({ push: z.boolean() }));

export async function notificationRoutes(app: FastifyInstance) {
  /**
   * GET /api/notifications/vapid-public-key
   * Returns the VAPID public key (no auth required).
   * Returns 503 when VAPID keys are not configured.
   */
  app.get("/api/notifications/vapid-public-key", async (_req, reply) => {
    const publicKey = notificationService.getVapidPublicKey();
    if (!publicKey) {
      return reply.status(503).send({ error: "Push notifications not configured" });
    }
    return reply.send({ publicKey });
  });

  /**
   * POST /api/notifications/subscribe
   * Register a push subscription for the authenticated user.
   */
  app.post("/api/notifications/subscribe", async (req, reply) => {
    const body = subscribeSchema.parse(req.body);
    const userId = req.user?.id;
    if (!userId) return reply.status(401).send({ error: "Authentication required" });

    await notificationService.subscribe(userId, body, body.userAgent);
    return reply.status(201).send({ ok: true });
  });

  /**
   * DELETE /api/notifications/subscribe
   * Remove a push subscription for the authenticated user.
   */
  app.delete("/api/notifications/subscribe", async (req, reply) => {
    const body = unsubscribeSchema.parse(req.body);
    const userId = req.user?.id;
    if (!userId) return reply.status(401).send({ error: "Authentication required" });

    await notificationService.unsubscribe(userId, body.endpoint);
    return reply.status(204).send();
  });

  /**
   * GET /api/notifications/subscriptions
   * List all push subscriptions for the authenticated user.
   */
  app.get("/api/notifications/subscriptions", async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) return reply.status(401).send({ error: "Authentication required" });

    const subscriptions = await notificationService.listSubscriptions(userId);
    return reply.send({ subscriptions });
  });

  /**
   * GET /api/notifications/preferences
   * Get notification preferences for the authenticated user.
   */
  app.get("/api/notifications/preferences", async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) return reply.status(401).send({ error: "Authentication required" });

    const preferences = await notificationService.getPreferences(userId);
    return reply.send({ preferences });
  });

  /**
   * PUT /api/notifications/preferences
   * Update notification preferences for the authenticated user.
   */
  app.put("/api/notifications/preferences", async (req, reply) => {
    const body = preferencesSchema.parse(req.body);
    const userId = req.user?.id;
    if (!userId) return reply.status(401).send({ error: "Authentication required" });

    const preferences = await notificationService.updatePreferences(userId, body);
    return reply.send({ preferences });
  });

  /**
   * POST /api/notifications/test
   * Send a test push notification to all of the caller's subscriptions.
   */
  app.post("/api/notifications/test", async (req, reply) => {
    const userId = req.user?.id;
    if (!userId) return reply.status(401).send({ error: "Authentication required" });

    if (!notificationService.isVapidConfigured()) {
      return reply.status(503).send({ error: "Push notifications not configured" });
    }

    const sent = await notificationService.sendTestNotification(userId);
    return reply.send({ sent });
  });
}
