import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";

/**
 * The agent settings a person last used in the New work form — the runtime,
 * and for each runtime its agent options (model, effort, model provider, …)
 * — so the form starts from them next time, on any device. Per user; with
 * auth disabled there is no user and nothing is kept.
 */

const optionsSchema = z
  .record(z.string().max(64), z.union([z.string().max(300), z.boolean()]))
  .refine((o) => Object.keys(o).length <= 40, "Too many options");

const workDefaultsSchema = z
  .object({
    runtime: z.string().max(40).optional().describe("The runtime picked last"),
    agentOptions: z
      .record(z.string().max(40), optionsSchema)
      .refine((o) => Object.keys(o).length <= 12, "Too many runtimes")
      .optional()
      .describe("Per runtime: its agent options as last saved"),
  })
  .describe("The New work form's last-used agent settings");

export async function workDefaultsRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/me/work-defaults",
    {
      schema: {
        operationId: "getWorkDefaults",
        summary: "My last-used agent settings",
        description:
          "The runtime and per-runtime agent options the caller last used in the New work form. Empty when none are saved (or auth is disabled).",
        tags: ["Auth"],
        response: { 200: z.object({ defaults: workDefaultsSchema }) },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.send({ defaults: {} });
      const [row] = await db
        .select({ workDefaults: users.workDefaults })
        .from(users)
        .where(eq(users.id, userId));
      reply.send({ defaults: row?.workDefaults ?? {} });
    },
  );

  app.put(
    "/api/me/work-defaults",
    {
      schema: {
        operationId: "putWorkDefaults",
        summary: "Remember my agent settings",
        description:
          "Merge the given runtime and per-runtime agent options into the caller's saved New work form settings: a runtime's options replace what was saved for that runtime; other runtimes are kept.",
        tags: ["Auth"],
        body: workDefaultsSchema,
        response: { 200: z.object({ defaults: workDefaultsSchema }) },
      },
    },
    async (req, reply) => {
      const userId = req.user?.id;
      if (!userId) return reply.send({ defaults: {} });
      const [row] = await db
        .select({ workDefaults: users.workDefaults })
        .from(users)
        .where(eq(users.id, userId));
      const current = row?.workDefaults ?? {};
      const next = {
        runtime: req.body.runtime ?? current.runtime,
        agentOptions: { ...(current.agentOptions ?? {}), ...(req.body.agentOptions ?? {}) },
      };
      await db.update(users).set({ workDefaults: next }).where(eq(users.id, userId));
      reply.send({ defaults: next });
    },
  );
}
