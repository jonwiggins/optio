import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorResponseSchema } from "../schemas/common.js";
import { refuseUnlessDeploymentAdmin } from "../services/deployment-admin-gates.js";
import { isAuthDisabled } from "../services/oauth/index.js";
import { logAction } from "../services/optio-action-service.js";
import {
  CREDENTIAL_KINDS,
  CREDENTIAL_SCOPES,
  CREDENTIAL_USE_LIMIT,
  credentialFingerprint,
  credentialUseCsv,
  searchCredentialUse,
  type CredentialUseFilter,
} from "../services/run-credentials.js";

/**
 * Settings → Access → Credential use: which runs were given a credential
 * (services/run-credentials.ts). Deployment admins only, since it spans
 * every workspace. POST so that a pasted value travels in the body, never
 * in a URL or an access log; it is hashed and dropped. Every search and
 * export is in the action log, with the fingerprint searched for.
 */

const SearchBodySchema = z
  .object({
    value: z
      .string()
      .max(10_000)
      .optional()
      .describe("A credential's value, matched by fingerprint; never stored or logged"),
    fingerprint: z
      .string()
      .regex(/^[0-9a-fA-F]{16}$/)
      .optional()
      .describe("A fingerprint shown in an earlier result"),
    name: z.string().max(300).optional().describe("The credential's name, exactly"),
    credentialId: z.string().uuid().optional().describe("The stored secret's or provider's id"),
    kind: z.enum(CREDENTIAL_KINDS).optional(),
    scope: z.enum(CREDENTIAL_SCOPES).optional(),
    from: z.string().datetime({ offset: true }).optional().describe("Used at or after"),
    to: z.string().datetime({ offset: true }).optional().describe("Used at or before"),
    limit: z.number().int().min(1).max(CREDENTIAL_USE_LIMIT).optional(),
  })
  .describe("What to search the record of run credentials for");

const CredentialUseRowSchema = z.object({
  id: z.string(),
  runKind: z.string().describe("task | job-run | review | agent-turn | session"),
  runId: z.string(),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  userId: z.string().nullable().describe("Whose work it was; null for the organization's"),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
  repoUrl: z.string().nullable(),
  kind: z.string().describe("git-token | model-key | secret | github-app | model-provider"),
  scope: z.string().describe("personal | workspace | deployment | repo | environment"),
  name: z.string(),
  credentialId: z.string().nullable(),
  host: z.string().nullable(),
  fingerprint: z.string().nullable(),
  usedAt: z.string(),
});

const SearchResponseSchema = z.object({
  rows: z.array(CredentialUseRowSchema),
  truncated: z.boolean().describe("More runs matched than the limit"),
  fingerprint: z
    .string()
    .nullable()
    .describe("The pasted value's fingerprint (null when none was pasted)"),
});

type SearchBody = z.infer<typeof SearchBodySchema>;

function filterOf(body: SearchBody): CredentialUseFilter {
  return {
    value: body.value,
    fingerprint: body.fingerprint,
    name: body.name?.trim() || undefined,
    credentialId: body.credentialId,
    kind: body.kind,
    scope: body.scope,
    from: body.from ? new Date(body.from) : undefined,
    to: body.to ? new Date(body.to) : undefined,
    limit: body.limit,
  };
}

async function refused(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (!req.user && !isAuthDisabled()) {
    void reply.status(401).send({ error: "Authentication required" });
    return true;
  }
  return refuseUnlessDeploymentAdmin(
    req,
    reply,
    "Only a deployment admin searches the credentials runs used",
  );
}

/**
 * The action-log entry: what was searched for, never a value. Written
 * before the answer goes out; a failure to write it is logged, not fatal.
 */
async function logSearch(
  req: FastifyRequest,
  action: string,
  body: SearchBody,
  fingerprint: string | null,
  matched: number,
) {
  await logAction({
    workspaceId: req.user?.workspaceId ?? null,
    userId: req.user?.id,
    action,
    params: { name: body.name },
    result: {
      matched,
      fingerprint: fingerprint ?? body.fingerprint ?? null,
      byValue: body.value !== undefined,
      credentialId: body.credentialId ?? null,
      kind: body.kind ?? null,
      scope: body.scope ?? null,
      from: body.from ?? null,
      to: body.to ?? null,
    },
    success: true,
  }).catch((err) => req.log.warn({ err }, "Failed to log a credential use search"));
}

export async function credentialUseRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.post(
    "/api/credential-use/search",
    {
      schema: {
        operationId: "searchCredentialUse",
        summary: "Search the runs that used a credential",
        description:
          "Deployment admins only. Runs (tasks, Job runs, reviews, agent turns, sessions) " +
          "that were given a credential, matched by a pasted value (hashed, never stored), " +
          "a fingerprint, a name or a stored id, within a time range. Newest first.",
        tags: ["Setup & Settings"],
        body: SearchBodySchema,
        response: {
          200: SearchResponseSchema,
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (await refused(req, reply)) return reply;
      const fingerprint =
        req.body.value !== undefined ? credentialFingerprint(req.body.value) : null;
      const { rows, truncated } = await searchCredentialUse(filterOf(req.body));
      await logSearch(req, "credential_use.search", req.body, fingerprint, rows.length);
      reply.send({ rows, truncated, fingerprint });
    },
  );

  app.post(
    "/api/credential-use/export",
    {
      schema: {
        operationId: "exportCredentialUse",
        summary: "Export the runs that used a credential as CSV",
        description:
          "Deployment admins only. The same search as `searchCredentialUse`, as a CSV " +
          "attachment (text/csv), up to the search limit.",
        tags: ["Setup & Settings"],
        body: SearchBodySchema,
        response: {
          200: z.string().describe("CSV, one row per credential a run was given"),
          401: ErrorResponseSchema,
          403: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      if (await refused(req, reply)) return reply;
      const fingerprint =
        req.body.value !== undefined ? credentialFingerprint(req.body.value) : null;
      const { rows } = await searchCredentialUse({
        ...filterOf(req.body),
        limit: req.body.limit ?? CREDENTIAL_USE_LIMIT,
      });
      await logSearch(req, "credential_use.export", req.body, fingerprint, rows.length);
      const day = new Date().toISOString().slice(0, 10);
      reply
        .header("Cache-Control", "no-store")
        .header("Content-Disposition", `attachment; filename="credential-use-${day}.csv"`)
        .type("text/csv; charset=utf-8")
        .send(credentialUseCsv(rows));
    },
  );
}
