import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireRole } from "../plugins/auth.js";
import * as sharing from "../services/session-sharing-service.js";
import { ErrorResponseSchema } from "../schemas/common.js";

const targetParams = z.object({ kind: z.enum(["pod", "local"]), id: z.string().uuid() });
const shareSchema = z.object({
  id: z.string(),
  expiresAt: z.coerce.date(),
  revokedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});

export async function sessionSharingRoutes(raw: FastifyInstance) {
  const app = raw.withTypeProvider<ZodTypeProvider>();
  app.post(
    "/api/session-shares/redeem",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "redeemSessionShare",
        summary: "Join a shared session",
        tags: ["Sessions"],
        body: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
        response: {
          200: z.object({
            kind: z.enum(["pod", "local"]),
            targetId: z.string(),
            expiresAt: z.coerce.date(),
          }),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      reply.header("Cache-Control", "no-store");
      const result = req.user && (await sharing.redeemSessionShare(req.body.token, req.user));
      if (!result)
        return reply.status(404).send({
          error:
            "Link unavailable. Sign in to the session's organization; the link may have expired or been revoked.",
        });
      return result;
    },
  );
  app.get(
    "/api/session-shares/:kind/:id",
    {
      schema: {
        operationId: "listSessionShares",
        summary: "List collaboration links",
        tags: ["Sessions"],
        params: targetParams,
        response: { 200: z.object({ shares: z.array(shareSchema) }), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const target = await sharing.shareTarget(req.params.kind, req.params.id);
      if (
        !target ||
        !req.user ||
        target.userId !== req.user.id ||
        target.workspaceId !== req.user.workspaceId
      )
        return reply.status(404).send({ error: "Session not found" });
      return { shares: await sharing.listSessionShares(req.params.kind, target.id) };
    },
  );
  app.post(
    "/api/session-shares/:kind/:id",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "createSessionShare",
        summary: "Create a collaboration link",
        tags: ["Sessions"],
        params: targetParams,
        body: z.object({ hours: z.number().int().min(1).max(168).default(24) }),
        response: {
          201: z.object({ id: z.string(), expiresAt: z.coerce.date(), path: z.string() }),
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const target = await sharing.shareTarget(req.params.kind, req.params.id);
      if (!target || !req.user) return reply.status(404).send({ error: "Session not found" });
      try {
        const share = await sharing.createSessionShare(
          req.params.kind,
          target,
          req.user,
          req.body.hours,
        );
        reply.header("Cache-Control", "no-store");
        return reply.status(201).send({
          id: share.id,
          expiresAt: share.expiresAt,
          path: `/shared-session#${share.token}`,
        });
      } catch (err) {
        return reply
          .status(403)
          .send({ error: err instanceof Error ? err.message : "Unable to share session" });
      }
    },
  );
  app.delete(
    "/api/session-shares/:kind/:id/:shareId",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "revokeSessionShare",
        summary: "Revoke a collaboration link",
        tags: ["Sessions"],
        params: targetParams.extend({ shareId: z.string().uuid() }),
        response: { 200: z.object({}), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const target = await sharing.shareTarget(req.params.kind, req.params.id);
      if (
        !target ||
        !req.user ||
        target.userId !== req.user.id ||
        target.workspaceId !== req.user.workspaceId
      )
        return reply.status(404).send({ error: "Session not found" });
      await sharing.revokeSessionShare(req.params.kind, target.id, req.params.shareId);
      return {};
    },
  );
}
