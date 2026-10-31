import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  ROUND_TRIP_STEPS,
  ROUND_TRIP_SUPPORT,
  TICKET_FOLLOW_UP_MODES,
  normalizeRoundTrip,
  roundTripSettings,
  type RoundTripStep,
} from "@optio/shared";
import { getTicketRoundTrip, gitLabRoundTripConfig } from "@optio/ticket-providers";
import { db } from "../db/client.js";
import { ticketProviders } from "../db/schema.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { requireRole } from "../plugins/auth.js";
import { resolveProviderConfig } from "../services/ticket-sync-service.js";
import { followUpsWidened, mergeRoundTripSql } from "../services/ticket-round-trip-marks.js";
import { changeableProvider } from "./tickets.js";

/**
 * The ticket round trip's settings on a ticket provider
 * (docs/ticket-round-trip.md), on Settings → Integrations → Tickets, for
 * every source with a round trip (GitHub, GitLab, Jira, Linear, Notion).
 * Whoever may change the provider may change these (the deployment's: a
 * deployment admin; a workspace's: its admin; a team's: its team admins; a
 * person's: that person) — the same rule as tickets.ts; anyone else gets the
 * provider's 404 or 403.
 *
 * - `PUT  /api/tickets/providers/:id/round-trip` — on or off, comments, the
 *   work's link, follow-ups and the status mapping (`config.roundTrip`,
 *   merged around the marks the sync keeps there; switching it on or
 *   widening the follow-ups stamps `followUpsSince`, so comments from before
 *   don't count — services/ticket-round-trip-marks.ts).
 * - `GET  /api/tickets/providers/:id/round-trip/statuses` — the statuses to
 *   map to, as the service has them (GitHub's and GitLab's Open / Closed and
 *   labels, Jira's project or server statuses, Linear's workflow states,
 *   Notion's status options).
 * - `POST /api/tickets/providers/:id/round-trip/check` — the Test button: a
 *   ticket's status now and, for each mapped step, whether it can move there
 *   from it. Nothing moves.
 */

const StatusName = z.string().max(120);

const RoundTripBodySchema = z
  .object({
    /** Whether the round trip runs for the provider; saving settings without it switches it on. */
    enabled: z.boolean().optional(),
    comments: z.boolean(),
    remoteLink: z.boolean(),
    followUps: z.enum(TICKET_FOLLOW_UP_MODES as unknown as [string, ...string[]]),
    transitions: z.object({
      started: StatusName,
      mrOpened: StatusName,
      merged: StatusName,
      failed: StatusName,
    }),
  })
  .describe("What Optio writes back on the provider's tickets, and which comments resume work");

const RoundTripResponseSchema = z.object({
  roundTrip: RoundTripBodySchema.extend({ enabled: z.boolean() }),
});

const StatusesResponseSchema = z.object({
  statuses: z.array(z.object({ name: z.string(), category: z.string().optional() })),
  /** Whose statuses: a project's, every status on the server, a repository's, a team's, … */
  scope: z.enum(["project", "group", "server", "repository", "team", "workspace", "database"]),
});

const CheckBodySchema = z.object({
  /** The ticket as the service names it: `PLAT-1`, `12`, `ENG-1`, a Notion page id or link. */
  issueKey: z.string().trim().min(1).max(300),
  /** The mapping to test (the form's, not saved yet); the saved one when absent. */
  transitions: RoundTripBodySchema.shape.transitions.optional(),
});

const CheckResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  issueKey: z.string(),
  status: z.string().nullable().optional(),
  /** The statuses the issue can move to now. */
  available: z.array(z.string()).optional(),
  steps: z
    .array(
      z.object({
        step: z.enum(ROUND_TRIP_STEPS as unknown as [string, ...string[]]),
        status: z.string(),
        /** `ready`: a transition leads there now; `here`: it is there already; `unreachable`: not from here. */
        outcome: z.enum(["ready", "here", "unreachable"]),
      }),
    )
    .optional(),
});

export async function ticketRoundTripRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  /** The provider `id` and its round trip when the caller may change it; otherwise the reply is sent. */
  const changeable = async (id: string, req: FastifyRequest, reply: FastifyReply) => {
    const row = await changeableProvider(id, req, reply);
    if (!row) return null;
    const rt = getTicketRoundTrip(row.source);
    if (!rt) {
      reply.status(400).send({ error: `${row.source} providers have no round trip` });
      return null;
    }
    return { row, rt };
  };

  app.put(
    "/api/tickets/providers/:id/round-trip",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "saveTicketProviderRoundTrip",
        summary: "Save a ticket provider's round trip",
        description:
          "Whether the round trip runs (`enabled`, default true when left out), what Optio " +
          "writes back on the provider's tickets — comments at start, MR, merge and failure; " +
          "the work's link; a status per step (empty: none) — and which ticket comments " +
          "resume the work (any person's, only ones mentioning Optio, or none).",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: RoundTripBodySchema,
        response: {
          200: RoundTripResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const found = await changeable(req.params.id, req, reply);
      if (!found) return;
      const { row } = found;
      const before = roundTripSettings(row.config);
      const roundTrip = normalizeRoundTrip({ ...req.body, enabled: req.body.enabled ?? true });
      // Off reads no comments: switching on widens like Off → Any.
      const widened = followUpsWidened(
        before.enabled ? before.followUps : "off",
        roundTrip.enabled ? roundTrip.followUps : "off",
      );
      await db
        .update(ticketProviders)
        .set({
          config: mergeRoundTripSql({
            ...roundTrip,
            ...(widened ? { followUpsSince: new Date().toISOString() } : {}),
          }),
          updatedAt: new Date(),
        })
        .where(eq(ticketProviders.id, row.id));
      reply.send({ roundTrip });
    },
  );

  app.get(
    "/api/tickets/providers/:id/round-trip/statuses",
    {
      schema: {
        operationId: "listTicketProviderRoundTripStatuses",
        summary: "The statuses a provider's tickets can move to",
        description:
          "What the round trip's status mapping picks from, as the service has them: " +
          "GitHub's and GitLab's Open / Closed and labels, Jira's project statuses (every " +
          "status on the server when the provider names no project), Linear's workflow " +
          "states, the options of a Notion database's status property.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: {
          200: StatusesResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
          502: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const found = await changeable(req.params.id, req, reply);
      if (!found) return;
      const config = await resolveProviderConfig(found.row);
      try {
        reply.send(await found.rt.statuses(config));
      } catch (err) {
        reply.status(502).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post(
    "/api/tickets/providers/:id/round-trip/check",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "checkTicketProviderRoundTrip",
        summary: "Test a provider's status mapping on one ticket",
        description:
          "Read the ticket's status and where it can go, and say for each mapped step whether " +
          "it can move to its status from there. Nothing is moved. A service that can't be " +
          "reached is a 200 with `ok: false` and the reason; a ticket id the service can't " +
          "take is a 400.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: CheckBodySchema,
        response: {
          200: CheckResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const found = await changeable(req.params.id, req, reply);
      if (!found) return;
      const { row, rt } = found;
      const issueKey = rt.normalizeTicketId(req.body.issueKey);
      if (!issueKey) {
        const { name, example } = ROUND_TRIP_SUPPORT[rt.source];
        return reply.status(400).send({ error: `Not a ticket id ${name} takes (like ${example})` });
      }
      const settings = req.body.transitions
        ? normalizeRoundTrip({ transitions: req.body.transitions })
        : roundTripSettings(row.config);
      const config = await resolveProviderConfig(row);
      try {
        const ticketConfig =
          row.source === "gitlab" ? gitLabRoundTripConfig(config, req.body.issueKey) : config;
        const { status, current, available } = await rt.issueStatus(issueKey, ticketConfig);
        const has = (list: string[], name: string) =>
          list.some((x) => x.toLowerCase() === name.toLowerCase());
        const steps = (ROUND_TRIP_STEPS as readonly RoundTripStep[])
          .filter((step) => settings.transitions[step])
          .map((step) => {
            const target = settings.transitions[step];
            const outcome: "ready" | "here" | "unreachable" = has(current, target)
              ? "here"
              : has(available, target)
                ? "ready"
                : "unreachable";
            return { step, status: target, outcome };
          });
        reply.send({ ok: true, issueKey, status, available, steps });
      } catch (err) {
        reply.send({
          ok: false,
          issueKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}
