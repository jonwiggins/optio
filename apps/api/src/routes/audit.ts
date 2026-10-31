/**
 * The audit trail's API (docs/audit.md), behind the Audit page:
 *
 *   GET /api/audit                 a filtered page of entries, newest first
 *   GET /api/audit/export          every matching entry as CSV, JSON lines or JSON
 *   GET /api/activity/export       the same export (Activity → Export)
 *   GET /api/audit/settings        retention and the SIEM copy
 *   PUT /api/audit/settings        retention, in days (deployment admins)
 *
 * Workspace admins read their workspace's entries; deployment admins read
 * every workspace's and the deployment-wide ones (`?workspace=all`, their
 * default, `current`, or a workspace id). Members and viewers get a 403.
 */
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AUDIT_RETENTION_MAX_DAYS } from "@optio/shared";
import { ErrorResponseSchema } from "../schemas/common.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import { isDeploymentAdmin } from "../services/sign-in-config-service.js";
import { auditEvent } from "../services/audit.js";
import {
  auditEntries,
  csvHeader,
  csvRow,
  jsonLine,
  listAudit,
  type AuditFilters,
  type AuditItem,
  type AuditScope,
} from "../services/audit-query.js";
import {
  AuditSettingsError,
  getAuditRetention,
  setAuditRetention,
} from "../services/audit-retention.js";
import { auditStdoutEnabled } from "../services/audit-stdout.js";

const READ_REFUSAL = "Only workspace admins can read the audit trail";
const CHANGE_REFUSAL = "Only a deployment admin can change how long the audit trail is kept";

const filterSchema = {
  workspace: z
    .string()
    .max(64)
    .optional()
    .describe(
      "Deployment admins: `all` (default), `current`, or a workspace id. Workspace admins always read their own.",
    ),
  userId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "A person: what they did, and entries naming them (membership, a merge they confirmed)",
    ),
  action: z
    .string()
    .max(1000)
    .optional()
    .describe("Comma-separated action names or prefixes of whole segments (`auth`, `team.join`)"),
  from: z
    .string()
    .max(40)
    .optional()
    .describe("From this time (ISO 8601; a date means its start, UTC)"),
  to: z
    .string()
    .max(40)
    .optional()
    .describe("Up to this time (ISO 8601; a date means its end, UTC)"),
  outcome: z.enum(["success", "failure"]).optional(),
};

const listQuerySchema = z.object({
  ...filterSchema,
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const exportQuerySchema = z.object({
  ...filterSchema,
  format: z
    .enum(["csv", "jsonl", "json"])
    .default("csv")
    .describe("csv, jsonl (one JSON object per line) or json (an array)"),
});

const AuditItemSchema = z.object({
  id: z.string(),
  time: z.string(),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  actor: z
    .object({ id: z.string(), email: z.string().nullable(), name: z.string().nullable() })
    .nullable(),
  action: z.string(),
  label: z.string(),
  success: z.boolean(),
  clientIp: z.string().nullable(),
  details: z.record(z.unknown()),
});

const RetentionSchema = z.object({
  days: z.number().int(),
  source: z.enum(["app", "environment", "default"]),
  environmentDays: z.number().int(),
  lastPrunedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

const SettingsResponseSchema = z.object({
  retention: RetentionSchema,
  /** Each entry is also printed to stdout as a JSON line (OPTIO_AUDIT_STDOUT=json). */
  stdout: z.boolean(),
  /** The viewer may change the retention (a deployment admin). */
  canChange: z.boolean(),
});

interface Reader {
  scope: AuditScope;
  deploymentAdmin: boolean;
}

/** Who may read, and what: null for everyone but workspace and deployment admins. */
async function readerOf(req: FastifyRequest): Promise<Reader | null> {
  if (isAuthDisabled()) return { scope: { kind: "all" }, deploymentAdmin: true };
  if (!req.user) return null;
  if (await isDeploymentAdmin(req.user)) return { scope: { kind: "all" }, deploymentAdmin: true };
  if (req.user.workspaceRole === "admin" && req.user.workspaceId) {
    return {
      scope: { kind: "workspace", workspaceId: req.user.workspaceId },
      deploymentAdmin: false,
    };
  }
  return null;
}

class BadFilter extends Error {}

/** `from` / `to`: an ISO time, or a date (its start for `from`, its end for `to`, UTC). */
export function parseBound(value: string | undefined, edge: "from" | "to"): Date | undefined {
  if (!value) return undefined;
  const v = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(dateOnly ? `${v}T${edge === "from" ? "00:00:00.000" : "23:59:59.999"}Z` : v);
  if (Number.isNaN(d.getTime())) throw new BadFilter(`"${v}" isn't a date or time`);
  return d;
}

type FilterQuery = { [K in keyof typeof filterSchema]?: string };

function filtersOf(q: FilterQuery, req: FastifyRequest, reader: Reader): AuditFilters {
  const filters: AuditFilters = {
    userId: q.userId,
    actions: q.action
      ? q.action
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean)
      : undefined,
    from: parseBound(q.from, "from"),
    to: parseBound(q.to, "to"),
    outcome: q.outcome as AuditFilters["outcome"],
  };
  if (reader.scope.kind === "all" && q.workspace && q.workspace !== "all") {
    const ws = q.workspace === "current" ? req.user?.workspaceId : q.workspace;
    if (ws) {
      if (!z.string().uuid().safeParse(ws).success)
        throw new BadFilter("workspace is all, current or an id");
      filters.workspaceId = ws;
    }
  }
  return filters;
}

const EXPORT_TYPES = {
  csv: "text/csv; charset=utf-8",
  jsonl: "application/x-ndjson; charset=utf-8",
  json: "application/json; charset=utf-8",
} as const;

async function* exportBody(
  format: keyof typeof EXPORT_TYPES,
  entries: AsyncGenerator<AuditItem>,
): AsyncGenerator<string> {
  if (format === "csv") yield csvHeader();
  if (format === "json") yield "[";
  let first = true;
  for await (const item of entries) {
    if (format === "csv") yield csvRow(item);
    else if (format === "jsonl") yield jsonLine(item);
    else {
      yield (first ? "" : ",") + JSON.stringify(item);
      first = false;
    }
  }
  if (format === "json") yield "]\n";
}

export async function auditRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/audit",
    {
      schema: {
        operationId: "listAuditTrail",
        summary: "The audit trail: who did what, from where",
        description:
          "Sign-ins, merges, tokens, membership and settings changes, and every other action " +
          "Optio records, newest first. Workspace admins read their workspace's; deployment " +
          "admins every workspace's and the deployment-wide entries.",
        tags: ["System"],
        querystring: listQuerySchema,
        response: {
          200: z.object({
            items: z.array(AuditItemSchema),
            total: z.number().int(),
            limit: z.number().int(),
            offset: z.number().int(),
            scope: z.enum(["workspace", "all"]),
          }),
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const reader = await readerOf(req);
      if (!reader) return reply.status(403).send({ error: READ_REFUSAL });
      let filters: AuditFilters;
      try {
        filters = filtersOf(req.query, req, reader);
      } catch (err) {
        if (err instanceof BadFilter) return reply.status(400).send({ error: err.message });
        throw err;
      }
      const { limit, offset } = req.query;
      const page = await listAudit(reader.scope, filters, { limit, offset });
      return reply.send({ ...page, limit, offset, scope: reader.scope.kind });
    },
  );

  const exportHandler = async (
    req: FastifyRequest<{ Querystring: z.infer<typeof exportQuerySchema> }>,
    reply: FastifyReply,
  ) => {
    const reader = await readerOf(req);
    if (!reader) return reply.status(403).send({ error: READ_REFUSAL });
    let filters: AuditFilters;
    try {
      filters = filtersOf(req.query, req, reader);
    } catch (err) {
      if (err instanceof BadFilter) return reply.status(400).send({ error: err.message });
      throw err;
    }
    const format = req.query.format;
    // An export of the caller's own workspace is that workspace's entry; one
    // of all workspaces (or another one) is deployment-wide, which only
    // deployment admins read.
    const exported =
      reader.scope.kind === "workspace" ? reader.scope.workspaceId : filters.workspaceId;
    void auditEvent({
      req,
      action: "audit.export",
      workspaceId: exported && exported === req.user?.workspaceId ? exported : null,
      details: { kind: format, scope: filters.workspaceId ?? reader.scope.kind },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    const ext = format === "jsonl" ? "jsonl" : format;
    return reply
      .header("content-type", EXPORT_TYPES[format])
      .header("content-disposition", `attachment; filename="optio-audit-${stamp}.${ext}"`)
      .header("cache-control", "no-store")
      .send(Readable.from(exportBody(format, auditEntries(reader.scope, filters))));
  };

  const exportSchema = {
    summary: "Export the audit trail",
    description:
      "Every entry the filters match (no paging), as CSV, JSON lines or a JSON array. " +
      "Admins only, like the list; the export itself is recorded (`audit.export`).",
    tags: ["System"],
    querystring: exportQuerySchema,
    response: { 400: ErrorResponseSchema, 403: ErrorResponseSchema },
  };
  app.get(
    "/api/audit/export",
    { schema: { ...exportSchema, operationId: "exportAuditTrail" } },
    exportHandler,
  );
  app.get(
    "/api/activity/export",
    { schema: { ...exportSchema, operationId: "exportActivity" } },
    exportHandler,
  );

  app.get(
    "/api/audit/settings",
    {
      schema: {
        operationId: "getAuditSettings",
        summary: "How long the audit trail is kept, and whether it goes to stdout",
        tags: ["System"],
        response: { 200: SettingsResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const reader = await readerOf(req);
      if (!reader) return reply.status(403).send({ error: READ_REFUSAL });
      return reply.send({
        retention: await getAuditRetention(),
        stdout: auditStdoutEnabled(),
        canChange: reader.deploymentAdmin,
      });
    },
  );

  app.put(
    "/api/audit/settings",
    {
      schema: {
        operationId: "setAuditSettings",
        summary: "Set how long the audit trail is kept (deployment admins)",
        description:
          "`retentionDays` between 1 and 36500; null goes back to OPTIO_AUDIT_RETENTION_DAYS " +
          "(default 365). A shorter retention is applied at the next housekeeping tick.",
        tags: ["System"],
        body: z.object({
          retentionDays: z.number().int().min(1).max(AUDIT_RETENTION_MAX_DAYS).nullable(),
        }),
        response: {
          200: SettingsResponseSchema,
          400: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const reader = await readerOf(req);
      if (!reader?.deploymentAdmin) return reply.status(403).send({ error: CHANGE_REFUSAL });
      try {
        const retention = await setAuditRetention(req.body.retentionDays, req.user?.id ?? null);
        // Retention is the deployment's: a deployment-wide entry.
        void auditEvent({
          req,
          action: "audit.settings",
          workspaceId: null,
          details: { retentionDays: req.body.retentionDays },
        });
        return reply.send({ retention, stdout: auditStdoutEnabled(), canChange: true });
      } catch (err) {
        if (err instanceof AuditSettingsError)
          return reply.status(400).send({ error: err.message });
        throw err;
      }
    },
  );
}
