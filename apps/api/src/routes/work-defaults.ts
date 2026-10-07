import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { isAuthDisabled } from "../services/oauth/index.js";

/**
 * The settings a person last used in the New work form — where it ran (a pod,
 * or which machine and directory), the runtime, and for each runtime its
 * agent options (model, effort, model provider, …) — so the form starts from
 * them next time, on any device. Per user. With auth disabled everyone is the
 * one "Local Dev" person, whose settings are kept on a users row of their
 * own, so the form remembers on a single-person install too.
 */

const optionsSchema = z
  .record(z.string().max(64), z.union([z.string().max(300), z.boolean()]))
  .refine((o) => Object.keys(o).length <= 40, "Too many options");

const locationSchema = z
  .object({
    runTarget: z.enum(["cluster", "local"]).describe("A pod, or a machine"),
    localHostId: z.string().max(64).optional().describe("The machine picked last"),
    localDir: z.string().max(1024).optional().describe("The directory picked last on it"),
  })
  .describe("Where the work ran last");

const workDefaultsSchema = z
  .object({
    runtime: z.string().max(40).optional().describe("The runtime picked last"),
    agentOptions: z
      .record(z.string().max(40), optionsSchema)
      .refine((o) => Object.keys(o).length <= 12, "Too many runtimes")
      .optional()
      .describe("Per runtime: its agent options as last saved"),
    location: locationSchema.optional(),
  })
  .describe("The New work form's last-used settings");

export type WorkDefaultsBody = z.infer<typeof workDefaultsSchema>;

/**
 * The merge rule: Where and the runtime replace what was saved; a runtime's
 * options replace its own; other runtimes' options are kept.
 */
export function mergeWorkDefaults(
  current: WorkDefaultsBody | null | undefined,
  body: WorkDefaultsBody,
): WorkDefaultsBody {
  const next: WorkDefaultsBody = {
    agentOptions: { ...(current?.agentOptions ?? {}), ...(body.agentOptions ?? {}) },
  };
  const runtime = body.runtime ?? current?.runtime;
  if (runtime) next.runtime = runtime;
  const location = body.location ?? current?.location;
  if (location) next.location = location;
  return next;
}

/** The synthetic "Local Dev" person's users row (auth disabled), made on first use. */
const LOCAL_DEV = { provider: "local", externalId: "local" } as const;

export async function localDevUserId(): Promise<string> {
  const where = and(
    eq(users.provider, LOCAL_DEV.provider),
    eq(users.externalId, LOCAL_DEV.externalId),
  );
  const [found] = await db.select({ id: users.id }).from(users).where(where);
  if (found) return found.id;
  const [made] = await db
    .insert(users)
    .values({ ...LOCAL_DEV, email: "dev@localhost", displayName: "Local Dev" })
    .returning({ id: users.id });
  return made.id;
}

/** Whose settings a request reads and writes; null when there is nobody to keep them for. */
async function settingsUserId(req: { user?: { id: string } | null }): Promise<string | null> {
  if (req.user?.id) return req.user.id;
  if (isAuthDisabled()) return localDevUserId();
  return null;
}

export async function workDefaultsRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/me/work-defaults",
    {
      schema: {
        operationId: "getWorkDefaults",
        summary: "My last-used work settings",
        description:
          "Where the caller's work ran last (pod or machine + directory), and the runtime and per-runtime agent options they last used in the New work form. Empty when none are saved.",
        tags: ["Auth"],
        response: { 200: z.object({ defaults: workDefaultsSchema }) },
      },
    },
    async (req, reply) => {
      const userId = await settingsUserId(req);
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
        summary: "Remember my work settings",
        description:
          "Merge the given Where, runtime and per-runtime agent options into the caller's saved New work form settings: Where and the runtime replace what was saved; a runtime's options replace what was saved for that runtime; other runtimes are kept.",
        tags: ["Auth"],
        body: workDefaultsSchema,
        response: { 200: z.object({ defaults: workDefaultsSchema }) },
      },
    },
    async (req, reply) => {
      const userId = await settingsUserId(req);
      if (!userId) return reply.send({ defaults: {} });
      const [row] = await db
        .select({ workDefaults: users.workDefaults })
        .from(users)
        .where(eq(users.id, userId));
      const next = mergeWorkDefaults(row?.workDefaults, req.body);
      await db.update(users).set({ workDefaults: next }).where(eq(users.id, userId));
      reply.send({ defaults: next });
    },
  );
}
