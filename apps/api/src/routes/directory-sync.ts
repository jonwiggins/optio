import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { refuseUnlessDeploymentAdmin } from "../services/deployment-admin-gates.js";
import {
  DirectorySyncError,
  LDAP_NEEDED,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  directorySyncSettings,
  lastDirectorySyncRun,
  ldapConfigured,
  runDirectorySync,
  saveDirectorySyncSettings,
} from "../services/directory-sync.js";
import {
  LastDeploymentAdminError,
  disableUser,
  enableUser,
  listDisabledPeople,
} from "../services/offboarding.js";
import { envDeploymentAdmins } from "../services/sign-in-config-service.js";
import { leaseHolder } from "../services/lease-service.js";

/**
 * Offboarding from the directory (docs/directory-sync.md), on Settings →
 * Access → Directory sync. Deployment admins only: an account
 * spans every workspace, and the directory is the deployment's.
 *
 * - `GET  /api/admin/directory-sync` — the settings, the last run, who is
 *   disabled now and the automations Optio paused for them (named where the
 *   caller may see them).
 * - `PUT  /api/admin/directory-sync` — on / off and the interval (null = the
 *   deployment's default).
 * - `POST /api/admin/directory-sync/run` — "Run now" (`force`: "Disable them
 *   anyway" after a held run); answers the run.
 * - `POST /api/admin/users/disable` — "Disable and sign out everywhere", by
 *   id or email; `POST /api/admin/users/:id/enable` — enable again.
 */

const REFUSAL = "Only a deployment admin manages directory sync and disabled accounts";

const SettingsSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number(),
  source: z.object({
    enabled: z.enum(["app", "environment"]),
    intervalMinutes: z.enum(["app", "environment"]),
  }),
  environment: z.object({
    enabled: z.boolean(),
    intervalMinutes: z.number(),
    maxDisablePercent: z.number(),
  }),
  maxDisablePercent: z.number(),
});

const RunSchema = z.object({
  id: z.string(),
  trigger: z.enum(["schedule", "manual"]),
  startedBy: z.string().nullable(),
  forced: z.boolean(),
  status: z.enum(["running", "ok", "held", "failed"]),
  checked: z.number(),
  changed: z.number(),
  disabled: z.number(),
  enabled: z.number(),
  errors: z.number(),
  error: z.string().nullable(),
  details: z.array(
    z.object({
      userId: z.string(),
      email: z.string(),
      outcome: z.string(),
      reason: z.string().optional(),
    }),
  ),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});

const DisabledPersonSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  disabledAt: z.string(),
  reason: z.string().nullable(),
  reasonLabel: z.string(),
  byHand: z.boolean(),
  disabledBy: z.object({ id: z.string(), displayName: z.string() }).nullable(),
  paused: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      path: z.string(),
      workspaceId: z.string().nullable(),
    }),
  ),
  pausedHidden: z.number(),
});

const ViewSchema = z.object({
  settings: SettingsSchema,
  ldapConfigured: z.boolean(),
  /** Why the sync can't run here, when it can't. */
  note: z.string().nullable(),
  running: z.boolean(),
  lastRun: RunSchema.nullable(),
  disabledPeople: z.array(DisabledPersonSchema),
  limits: z.object({ minIntervalMinutes: z.number(), maxIntervalMinutes: z.number() }),
});

const UpdateSchema = z
  .object({
    enabled: z.boolean().nullable().optional().describe("null = the deployment's default"),
    intervalMinutes: z
      .number()
      .int()
      .min(MIN_INTERVAL_MINUTES)
      .max(MAX_INTERVAL_MINUTES)
      .nullable()
      .optional()
      .describe("Minutes between runs; null = the deployment's default"),
  })
  .describe("Directory sync settings to change");

const RunBodySchema = z
  .object({
    force: z
      .boolean()
      .optional()
      .describe("Disable the leavers even when there are more than the limit allows"),
  })
  // No body at all (curl, a script) is a plain run.
  .nullish();

const DisableBodySchema = z
  .object({
    userId: z.string().uuid().optional(),
    email: z.string().min(3).max(320).optional(),
  })
  .refine((b) => !!b.userId !== !!b.email, { message: "Give the person's id or email" })
  .describe("Who to disable and sign out everywhere");

const AccountSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  disabled: z.boolean(),
  revokedSessions: z.number().optional(),
  revokedApiKeys: z.number().optional(),
  paused: z.number().optional(),
  resumed: z.number().optional(),
});

async function view(req: FastifyRequest) {
  const configured = await ldapConfigured();
  return {
    settings: await directorySyncSettings(),
    ldapConfigured: configured,
    note: configured ? null : LDAP_NEEDED,
    running: !!(await leaseHolder("directory-sync")),
    lastRun: await lastDirectorySyncRun(),
    disabledPeople: await listDisabledPeople(req.user?.id ?? null),
    limits: { minIntervalMinutes: MIN_INTERVAL_MINUTES, maxIntervalMinutes: MAX_INTERVAL_MINUTES },
  };
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof DirectorySyncError)
    return reply.status(err.status).send({ error: err.message });
  throw err;
}

export async function directorySyncRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/admin/directory-sync",
    {
      schema: {
        operationId: "getDirectorySync",
        summary: "Directory sync: settings, last run, disabled accounts",
        description:
          "Deployment admins only. Paused automations are named only in workspaces the caller administers.",
        tags: ["Setup & Settings"],
        response: { 200: ViewSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (await refuseUnlessDeploymentAdmin(req, reply, REFUSAL)) return;
      reply.send(await view(req));
    },
  );

  app.put(
    "/api/admin/directory-sync",
    {
      schema: {
        operationId: "updateDirectorySync",
        summary: "Turn directory sync on or off, or change its interval",
        tags: ["Setup & Settings"],
        body: UpdateSchema,
        response: { 200: ViewSchema, 400: ErrorResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      if (await refuseUnlessDeploymentAdmin(req, reply, REFUSAL)) return;
      try {
        await saveDirectorySyncSettings(req.body, req.user?.id ?? null);
      } catch (err) {
        return sendError(reply, err);
      }

      reply.send(await view(req));
    },
  );

  app.post(
    "/api/admin/directory-sync/run",
    {
      schema: {
        operationId: "runDirectorySync",
        summary: "Run the directory sync now",
        description:
          "Reads every LDAP-sourced person's entry and groups now and applies them; answers " +
          "the run. 409 while another run is in progress.",
        tags: ["Setup & Settings"],
        body: RunBodySchema,
        response: {
          200: RunSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (await refuseUnlessDeploymentAdmin(req, reply, REFUSAL)) return;
      if (!(await ldapConfigured())) return reply.status(400).send({ error: LDAP_NEEDED });
      try {
        const run = await runDirectorySync({
          trigger: "manual",
          startedBy: req.user?.id ?? null,
          force: req.body?.force === true,
        });
        reply.send(run);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    "/api/admin/users/disable",
    {
      schema: {
        operationId: "disableUser",
        summary: "Disable an account and sign it out everywhere",
        description:
          "Revokes its sessions and API keys and pauses its own automations. " +
          "The directory sync never enables an account disabled " +
          "this way.",
        tags: ["Setup & Settings"],
        body: DisableBodySchema,
        response: {
          200: AccountSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (await refuseUnlessDeploymentAdmin(req, reply, REFUSAL)) return;
      const [target] = await db
        .select()
        .from(users)
        .where(
          req.body.userId
            ? eq(users.id, req.body.userId)
            : sql`lower(${users.email}) = ${req.body.email!.trim().toLowerCase()}`,
        )
        .limit(1);
      if (!target) return reply.status(404).send({ error: "No one with that id or email" });
      if (target.id === req.user?.id) {
        return reply.status(400).send({ error: "You can't disable your own account" });
      }
      if (target.disabledAt) return reply.status(409).send({ error: "Already disabled" });
      if (await isLastDeploymentAdmin(target)) {
        return reply.status(409).send({
          error: "That's the last deployment admin — make someone else one first",
        });
      }
      let account;
      try {
        account = await disableUser(target.id, {
          reason: "admin",
          byUserId: req.user?.id ?? null,
          protectLastAdmin: true,
        });
      } catch (err) {
        if (!(err instanceof LastDeploymentAdminError)) throw err;
        return reply.status(409).send({ error: err.message });
      }
      if (!account) return reply.status(409).send({ error: "Already disabled" });

      reply.send({
        id: account.userId,
        email: account.email,
        displayName: account.displayName,
        disabled: true,
        revokedSessions: account.revokedSessions,
        revokedApiKeys: account.revokedApiKeys,
        paused: account.paused.length,
      });
    },
  );

  app.post(
    "/api/admin/users/:id/enable",
    {
      schema: {
        operationId: "enableUser",
        summary: "Enable a disabled account again",
        description:
          "The person signs in again (their old sessions and keys stay revoked); the " +
          "automations Optio paused for them come back on. If the directory still says they " +
          "left, the next directory sync disables them again.",
        tags: ["Setup & Settings"],
        params: z.object({ id: z.string().uuid() }),
        response: {
          200: AccountSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (await refuseUnlessDeploymentAdmin(req, reply, REFUSAL)) return;
      const account = await enableUser(req.params.id);
      if (!account) return reply.status(404).send({ error: "No disabled account with that id" });

      reply.send({
        id: account.userId,
        email: account.email,
        displayName: account.displayName,
        disabled: false,
        resumed: account.resumed.length,
      });
    },
  );
}

/** Whether `target` is the only enabled deployment admin left. */
async function isLastDeploymentAdmin(target: typeof users.$inferSelect): Promise<boolean> {
  const env = envDeploymentAdmins();
  const isAdmin =
    target.deploymentAdmin || (target.emailVerified && env.has(target.email.toLowerCase()));
  if (!isAdmin) return false;
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      emailVerified: users.emailVerified,
      flag: users.deploymentAdmin,
    })
    .from(users)
    .where(sql`${users.disabledAt} IS NULL AND ${users.id} <> ${target.id}`);
  return !rows.some((r) => r.flag || (r.emailVerified && env.has(r.email.toLowerCase())));
}
