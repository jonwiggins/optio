/**
 * `/api/config` — config as code (docs/config-as-code.md): the manifest JSON
 * Schema, the configuration directory's status and a sync of it, an apply of
 * manifests the CLI read, an export of the workspace as manifests, and
 * detaching a managed resource.
 *
 * Who may call what: the schema is public (it holds no data); status and
 * export need a member (export writes the organization's resources only, and
 * never a secret's value); sync, apply and detach need a workspace admin.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { isManifestKind, type ManifestKind } from "@optio/shared";
import { requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import {
  ApplyBodySchema,
  ConfigApplyResultSchema,
  ConfigStatusSchema,
  ExportQuerySchema,
  ExportResponseSchema,
  SyncQuerySchema,
  manifestJsonSchema,
} from "../schemas/config.js";
import { applyManifests, detachObject } from "../services/config/apply.js";
import { exportManifests, manifestsToYaml } from "../services/config/export.js";
import { configStatus, syncEnvSource } from "../services/config/source.js";
import { logAction } from "../services/optio-action-service.js";

const SCHEMA_PATH = "/api/config/schema.json";

/** Where a browser (and the yaml-language-server) fetches the schema: through the web app's proxy. */
function schemaUrl(): string {
  const base = (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}${SCHEMA_PATH}`;
}

function kindsOf(query: string | undefined): ManifestKind[] | undefined {
  if (!query) return undefined;
  const kinds = query
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const bad = kinds.find((k) => !isManifestKind(k));
  if (bad) throw new KindError(bad);
  return kinds as ManifestKind[];
}

class KindError extends Error {
  constructor(readonly kind: string) {
    super(`Unknown manifest kind "${kind}"`);
  }
}

export async function configRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const admin = { preHandler: [requireRole("admin")] };
  const schema = manifestJsonSchema();

  app.get(
    SCHEMA_PATH,
    {
      schema: {
        operationId: "getManifestSchema",
        summary: "The JSON Schema of a manifest",
        description:
          "Every manifest kind (Work, Prompt, Repo, McpServer, Skill, Connection) as JSON Schema, " +
          "for `# yaml-language-server: $schema=` in a file and for validation in CI. Public.",
        tags: ["Config"],
        response: { 200: z.record(z.unknown()) },
      },
    },
    async (_req, reply) => {
      reply.header("cache-control", "public, max-age=300");
      reply.send(schema);
    },
  );

  app.get(
    "/api/config/status",
    {
      schema: {
        operationId: "getConfigStatus",
        summary: "The configuration directory and its last sync",
        description:
          "Whether `OPTIO_CONFIG_DIR` feeds the current workspace, and how the last sync went " +
          "(counts, per-file errors). `source` is null when config as code is off or points " +
          "at another workspace.",
        tags: ["Config"],
        response: { 200: ConfigStatusSchema },
      },
    },
    async (req, reply) => {
      reply.send(await configStatus(req.user?.workspaceId ?? null, schemaUrl()));
    },
  );

  app.post(
    "/api/config/source/sync",
    {
      ...admin,
      schema: {
        operationId: "syncConfigSource",
        summary: "Read the configuration directory now",
        description:
          "Applies the directory at once instead of waiting for the next interval; " +
          "`?dryRun=true` only plans it. Requires `admin` role.",
        tags: ["Config"],
        querystring: SyncQuerySchema,
        response: { 200: ConfigApplyResultSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const result = await syncEnvSource({ dryRun: req.query.dryRun === "true" });
      if (!result) {
        return reply
          .status(404)
          .send({ error: "Config as code is off: OPTIO_CONFIG_DIR is not set" });
      }
      reply.send(result);
    },
  );

  app.post(
    "/api/config/apply",
    {
      ...admin,
      schema: {
        operationId: "applyConfig",
        summary: "Apply manifests to the current workspace",
        description:
          "What `optio apply` posts: documents the CLI read (file fields inlined). Each manifest " +
          "is created, updated or left alone by name; an existing resource with the name is " +
          "taken over. A CLI apply manages nothing and never prunes. `dryRun` plans only. " +
          "Requires `admin` role.",
        tags: ["Config"],
        body: ApplyBodySchema,
        response: { 200: ConfigApplyResultSchema },
      },
    },
    async (req, reply) => {
      const result = await applyManifests({
        workspaceId: req.user?.workspaceId ?? null,
        manifests: req.body.manifests.map((m) => ({ path: m.path, document: m.document })),
        dryRun: req.body.dryRun ?? false,
      });
      if (!result.dryRun) {
        logAction({
          workspaceId: req.user?.workspaceId ?? null,
          userId: req.user?.id,
          action: "config.apply",
          params: { manifests: req.body.manifests.length },
          result: { ...result.summary },
          success: result.summary.errors === 0,
        }).catch(() => {});
      }
      reply.send(result);
    },
  );

  app.get(
    "/api/config/export",
    {
      schema: {
        operationId: "exportConfig",
        summary: "The organization's resources as manifests",
        description:
          "Every Work definition, prompt, repo, MCP server, skill and connection of the current " +
          "workspace as a manifest, with the file each would be saved as. `kind` narrows the kinds, " +
          "`id` picks one resource. Never anyone's private resources, never a secret's value.",
        tags: ["Config"],
        querystring: ExportQuerySchema,
        response: { 200: ExportResponseSchema, 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const manifests = await exportManifests(req.user?.workspaceId ?? null, {
          kinds: kindsOf(req.query.kind),
          id: req.query.id,
        });
        reply.send({ manifests });
      } catch (err) {
        if (err instanceof KindError) return reply.status(400).send({ error: err.message });
        throw err;
      }
    },
  );

  app.get(
    "/api/config/export.yaml",
    {
      schema: {
        operationId: "exportConfigYaml",
        summary: "The export as one YAML file",
        description: "`GET /api/config/export` as YAML text, manifests separated by `---`.",
        tags: ["Config"],
        querystring: ExportQuerySchema.extend({
          download: z.string().optional().describe("Any value: send as an attachment"),
        }),
        response: { 200: z.string(), 400: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      try {
        const manifests = await exportManifests(req.user?.workspaceId ?? null, {
          kinds: kindsOf(req.query.kind),
          id: req.query.id,
        });
        reply.header("content-type", "application/yaml; charset=utf-8");
        if (req.query.download !== undefined) {
          const name =
            manifests.length === 1 ? manifests[0].path.split("/").pop()! : "optio-config.yaml";
          reply.header("content-disposition", `attachment; filename="${name}"`);
        }
        reply.send(manifestsToYaml(manifests, schemaUrl()));
      } catch (err) {
        if (err instanceof KindError) return reply.status(400).send({ error: err.message });
        throw err;
      }
    },
  );

  app.post(
    "/api/config/objects/:id/detach",
    {
      ...admin,
      schema: {
        operationId: "detachConfigObject",
        summary: "Stop managing a resource",
        description:
          "Drops the bookkeeping that ties a resource to its manifest; the resource stays and is " +
          "edited by hand from then on. If its manifest is still in the directory, the next sync " +
          "takes it over again. Requires `admin` role.",
        tags: ["Config"],
        params: IdParamsSchema,
        response: { 204: z.null(), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const detached = await detachObject(req.params.id, req.user?.workspaceId ?? null);
      if (!detached) return reply.status(404).send({ error: "Not a managed resource" });
      reply.status(204).send(null);
    },
  );
}
