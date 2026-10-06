import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { canJoinSession, shareTarget } from "../services/session-sharing-service.js";
import { sessionRecovery } from "../services/session-recovery-service.js";
import { ErrorResponseSchema } from "../schemas/common.js";

export async function sessionRecoveryRoutes(raw: FastifyInstance) {
  const app = raw.withTypeProvider<ZodTypeProvider>();
  app.get(
    "/api/session-recovery/:kind/:id",
    {
      schema: {
        operationId: "getSessionRecovery",
        summary: "Get session recovery status",
        tags: ["Sessions"],
        params: z.object({ kind: z.enum(["pod", "local"]), id: z.string().uuid() }),
        response: {
          200: z.object({
            state: z.enum(["live", "reconnecting", "resumable", "lost", "ended"]),
            message: z.string(),
            automaticReplay: z.literal(false),
          }),
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const target = await shareTarget(req.params.kind, req.params.id);
      if (!target || !(await canJoinSession(req.params.kind, target, req.user)))
        return reply.status(404).send({ error: "Session not found" });
      reply.header("Cache-Control", "no-store");
      return sessionRecovery(req.params.kind, target.id);
    },
  );
}
