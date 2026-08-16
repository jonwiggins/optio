import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as sharedDirService from "../services/shared-directory-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { SharedDirectorySchema } from "../schemas/integration.js";
import { requireRole } from "../plugins/auth.js";

const dirIdParamsSchema = z
  .object({
    id: z.string().describe("Repo UUID"),
    dirId: z.string().describe("Shared directory UUID"),
  })
  .describe("Path parameters: repo id + shared directory id");

const createSharedDirectorySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9](-?[a-z0-9])*$/, "lowercase alphanumeric with optional hyphens"),
    description: z.string().optional(),
    mountLocation: z
      .enum(["workspace", "home"])
      .describe("Where in the agent container the directory is mounted"),
    mountSubPath: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9._/-]+$/, "alphanumeric with . _ / - only")
      .refine((p) => !p.startsWith("/"), "must not start with /")
      .refine((p) => !p.includes(".."), "must not contain path traversal"),
    sizeGi: z.number().int().min(1).max(100).default(10).describe("Volume size in Gi (1–100)"),
    scope: z.enum(["per-pod"]).default("per-pod"),
  })
  .describe("Body for creating a shared directory");

const updateSharedDirectorySchema = z
  .object({
    description: z.string().nullable().optional(),
    sizeGi: z.number().int().min(1).max(100).optional(),
  })
  .describe("Partial update to a shared directory");

const DirListResponseSchema = z.object({ directories: z.array(SharedDirectorySchema) });
const DirResponseSchema = z.object({ directory: SharedDirectorySchema });
const OkResponseSchema = z.object({ ok: z.boolean() });
const UsageResponseSchema = z.object({ usage: z.unknown() });
const RecycleResponseSchema = z.object({
  ok: z.boolean(),
  recycled: z.number().int().describe("Number of pods destroyed"),
});

export async function sharedDirectoryRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/repos/:id/shared-directories",
    {
      schema: {
        operationId: "listSharedDirectories",
        summary: "List shared directories for a repo",
        description:
          "Return all shared directories configured for the repo. Shared " +
          "directories are persistent PVCs mounted into agent pods for " +
          "caching tool output (npm, pip, cargo, etc.).",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: DirListResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { getRepo } = await import("../services/repo-service.js");
      const repo = await getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });

      const wsId = req.user?.workspaceId;
      if (wsId && repo.workspaceId && repo.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }

      const directories = await sharedDirService.listSharedDirectories(id);
      reply.send({ directories });
    },
  );

  app.post(
    "/api/repos/:id/shared-directories",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "createSharedDirectory",
        summary: "Create a shared directory",
        description:
          "Register a new shared directory for a repo. `name` and " +
          "`mountSubPath` are aggressively sanitized — no path traversal, " +
          "no absolute paths, no special characters. Fails with 409 if " +
          "the name is already used by another directory in the same repo.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        body: createSharedDirectorySchema,
        response: {
          201: DirResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { getRepo } = await import("../services/repo-service.js");
      const repo = await getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });

      const wsId = req.user?.workspaceId;
      if (wsId && repo.workspaceId && repo.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }

      const input = req.body;

      const validationError = sharedDirService.validateSharedDirectoryInput(input);
      if (validationError) {
        return reply.status(400).send({ error: validationError });
      }

      try {
        const directory = await sharedDirService.createSharedDirectory({
          repoId: id,
          workspaceId: repo.workspaceId,
          name: input.name,
          description: input.description,
          mountLocation: input.mountLocation,
          mountSubPath: input.mountSubPath,
          sizeGi: input.sizeGi,
          scope: input.scope,
          createdBy: req.user?.id,
        });
        reply.status(201).send({ directory });
      } catch (err: unknown) {
        const e = err as { message?: string; code?: string };
        if (e?.message?.includes("unique") || e?.code === "23505") {
          return reply.status(409).send({
            error: `A shared directory named '${input.name}' already exists for this repo`,
          });
        }
        if (e?.message?.includes("total cache size")) {
          return reply.status(400).send({ error: e.message });
        }
        throw err;
      }
    },
  );

  app.patch(
    "/api/repos/:id/shared-directories/:dirId",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "updateSharedDirectory",
        summary: "Update a shared directory",
        description: "Update the description or size of a shared directory.",
        tags: ["Repos & Integrations"],
        params: dirIdParamsSchema,
        body: updateSharedDirectorySchema,
        response: { 200: DirResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id, dirId } = req.params;
      const { getRepo } = await import("../services/repo-service.js");
      const repo = await getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });

      const wsId = req.user?.workspaceId;
      if (wsId && repo.workspaceId && repo.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }

      const existing = await sharedDirService.getSharedDirectory(dirId);
      if (!existing || existing.repoId !== id) {
        return reply.status(404).send({ error: "Shared directory not found" });
      }

      const directory = await sharedDirService.updateSharedDirectory(dirId, req.body);
      reply.send({ directory });
    },
  );

  app.delete(
    "/api/repos/:id/shared-directories/:dirId",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "deleteSharedDirectory",
        summary: "Delete a shared directory",
        description: "Delete a shared directory configuration. Returns 204 on success.",
        tags: ["Repos & Integrations"],
        params: dirIdParamsSchema,
        response: { 204: z.null(), 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id, dirId } = req.params;
      const { getRepo } = await import("../services/repo-service.js");
      const repo = await getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });

      const wsId = req.user?.workspaceId;
      if (wsId && repo.workspaceId && repo.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }

      const existing = await sharedDirService.getSharedDirectory(dirId);
      if (!existing || existing.repoId !== id) {
        return reply.status(404).send({ error: "Shared directory not found" });
      }

      await sharedDirService.deleteSharedDirectory(dirId);
      reply.status(204).send(null);
    },
  );

  app.post(
    "/api/repos/:id/shared-directories/:dirId/clear",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "clearSharedDirectory",
        summary: "Clear a shared directory's contents",
        description: "Empty the persistent volume behind a shared directory.",
        tags: ["Repos & Integrations"],
        params: dirIdParamsSchema,
        response: { 200: OkResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id, dirId } = req.params;
      const { getRepo } = await import("../services/repo-service.js");
      const repo = await getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });

      const wsId = req.user?.workspaceId;
      if (wsId && repo.workspaceId && repo.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }

      const existing = await sharedDirService.getSharedDirectory(dirId);
      if (!existing || existing.repoId !== id) {
        return reply.status(404).send({ error: "Shared directory not found" });
      }

      await sharedDirService.clearSharedDirectory(existing, repo.repoUrl);
      reply.send({ ok: true });
    },
  );

  app.post(
    "/api/repos/:id/shared-directories/:dirId/usage",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "getSharedDirectoryUsage",
        summary: "Get usage of a shared directory",
        description:
          "Report current size + inode count for a shared directory, " +
          "by running `du` inside a helper pod.",
        tags: ["Repos & Integrations"],
        params: dirIdParamsSchema,
        response: { 200: UsageResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id, dirId } = req.params;
      const { getRepo } = await import("../services/repo-service.js");
      const repo = await getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });

      const wsId = req.user?.workspaceId;
      if (wsId && repo.workspaceId && repo.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }

      const existing = await sharedDirService.getSharedDirectory(dirId);
      if (!existing || existing.repoId !== id) {
        return reply.status(404).send({ error: "Shared directory not found" });
      }

      const usage = await sharedDirService.getSharedDirectoryUsage(existing, repo.repoUrl);
      reply.send({ usage });
    },
  );

  app.post(
    "/api/repos/:id/pods/recycle",
    {
      preHandler: [requireRole("admin")],
      schema: {
        operationId: "recycleRepoPods",
        summary: "Recycle all ready pods for a repo",
        description:
          "Destroy any pods currently in `ready` state with zero active " +
          "tasks so they're recreated with fresh shared-directory mounts. " +
          "Used after adding or removing a shared directory.",
        tags: ["Repos & Integrations"],
        params: IdParamsSchema,
        response: { 200: RecycleResponseSchema, 404: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { getRepo } = await import("../services/repo-service.js");
      const repo = await getRepo(id);
      if (!repo) return reply.status(404).send({ error: "Repo not found" });

      const wsId = req.user?.workspaceId;
      if (wsId && repo.workspaceId && repo.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }

      const { listRepoPodsForRepo } = await import("../services/repo-pool-service.js");
      const { getRuntime } = await import("../services/container-service.js");
      const { deleteNetworkPolicy, deleteEnvoyConfigMap } =
        await import("../services/repo-pool-service.js");
      const { db: dbClient } = await import("../db/client.js");
      const { repoPods: repoPodsTable } = await import("../db/schema.js");
      const { eq: eqOp } = await import("drizzle-orm");

      const pods = await listRepoPodsForRepo(repo.repoUrl);
      const rt = getRuntime();
      let recycled = 0;

      for (const pod of pods) {
        if (pod.state !== "ready" || pod.activeTaskCount > 0) continue;
        try {
          if (pod.podName) {
            await deleteNetworkPolicy(pod.podName).catch(() => {});
            await deleteEnvoyConfigMap(pod.podName).catch(() => {});
            await rt.destroy({ id: pod.podId ?? pod.podName, name: pod.podName });
          }
          await dbClient.delete(repoPodsTable).where(eqOp(repoPodsTable.id, pod.id));
          recycled++;
        } catch {
          // Skip pods that can't be recycled
        }
      }

      reply.send({ ok: true, recycled });
    },
  );
}
