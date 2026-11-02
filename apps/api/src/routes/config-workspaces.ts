/**
 * `/api/config/workspaces` — workspaces as code (docs/workspaces-as-code.md):
 * apply `kind: Workspace` manifests to the deployment (create or update
 * workspaces, their members and repos; `dryRun` plans), and export the
 * deployment's workspaces as manifests. Both act on every workspace, so both
 * take a deployment admin; every apply that writes is in the action log, once
 * for the deployment and once in each workspace it changed.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { ConfigApplyResult } from "@optio/shared";
import { requireDeploymentAdmin, requireRole } from "../plugins/auth.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import {
  ConfigApplyResultSchema,
  WorkspaceApplyBodySchema,
  WorkspaceExportQuerySchema,
  WorkspaceExportResponseSchema,
} from "../schemas/config.js";
import { manifestsToYaml } from "../services/config/export.js";
import { schemaUrl } from "./config.js";
import {
  applyWorkspaceManifests,
  exportWorkspaceManifests,
} from "../services/config/workspaces.js";
import { logAction } from "../services/optio-action-service.js";

const slugsOf = (query: string | undefined) =>
  query
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Per workspace the apply touched: its id and how many items changed something. */
function changedWorkspaces(
  result: ConfigApplyResult,
): Map<string, { id: string; changes: number }> {
  const out = new Map<string, { id: string; changes: number }>();
  for (const item of result.items) {
    if (item.kind === "Workspace" && item.workspace && item.resourceId) {
      out.set(item.workspace, { id: item.resourceId, changes: 0 });
    }
  }
  for (const item of result.items) {
    const ws = item.workspace ? out.get(item.workspace) : undefined;
    if (ws && item.action !== "unchanged" && item.action !== "error") ws.changes++;
  }
  return out;
}

export async function configWorkspaceRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  const deploymentAdmin = { preHandler: [requireRole("admin"), requireDeploymentAdmin] };

  app.post(
    "/api/config/workspaces/apply",
    {
      ...deploymentAdmin,
      schema: {
        operationId: "applyWorkspaceConfig",
        summary: "Apply workspace manifests to the deployment",
        description:
          "`kind: Workspace` manifests: each workspace is created when no workspace has its slug, " +
          "else its display name, description and the settings the file names are updated; the " +
          "members it lists (by verified email) are added or given the listed role; its repos are " +
          "registered and configured. Members the file doesn't list are kept unless it says " +
          "`prune: true`; workspaces and repos are never removed. `dryRun` plans only. Requires a " +
          "deployment admin.",
        tags: ["Config"],
        body: WorkspaceApplyBodySchema,
        response: { 200: ConfigApplyResultSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const dryRun = req.body.dryRun ?? false;
      const result = await applyWorkspaceManifests({
        manifests: req.body.manifests.map((m) => ({ path: m.path, document: m.document })),
        dryRun,
      });
      if (!dryRun) {
        const touched = changedWorkspaces(result);
        logAction({
          workspaceId: null,
          userId: req.user?.id,
          action: "config.workspaces.apply",
          params: { manifests: req.body.manifests.length, workspaces: [...touched.keys()] },
          result: { ...result.summary },
          success: result.summary.errors === 0,
        }).catch(() => {});
        for (const [slug, ws] of touched) {
          if (ws.changes === 0) continue;
          logAction({
            workspaceId: ws.id,
            userId: req.user?.id,
            action: "config.workspaces.apply",
            params: { workspace: slug },
            result: { changes: ws.changes },
            success: !result.items.some((i) => i.workspace === slug && i.action === "error"),
          }).catch(() => {});
        }
      }
      reply.send(result);
    },
  );

  app.get(
    "/api/config/workspaces/export",
    {
      ...deploymentAdmin,
      schema: {
        operationId: "exportWorkspaceConfig",
        summary: "The deployment's workspaces as manifests",
        description:
          "Every workspace (or the comma-separated `slug`s) as a `kind: Workspace` manifest: " +
          "display name, settings, members by verified email with their role, and repos. " +
          "Requires a deployment admin.",
        tags: ["Config"],
        querystring: WorkspaceExportQuerySchema,
        response: { 200: WorkspaceExportResponseSchema, 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      reply.send({ manifests: await exportWorkspaceManifests(slugsOf(req.query.slug)) });
    },
  );

  app.get(
    "/api/config/workspaces/export.yaml",
    {
      ...deploymentAdmin,
      schema: {
        operationId: "exportWorkspaceConfigYaml",
        summary: "The workspace export as one YAML file",
        description:
          "`GET /api/config/workspaces/export` as YAML text, manifests separated by `---`. " +
          "Requires a deployment admin.",
        tags: ["Config"],
        querystring: WorkspaceExportQuerySchema,
        response: { 200: z.string(), 403: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const manifests = await exportWorkspaceManifests(slugsOf(req.query.slug));
      reply.header("content-type", "application/yaml; charset=utf-8");
      reply.send(manifestsToYaml(manifests, schemaUrl()));
    },
  );
}
