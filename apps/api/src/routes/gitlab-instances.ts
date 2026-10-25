import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorResponseSchema } from "../schemas/common.js";
import {
  requesterIsDeploymentAdmin,
  refuseUnlessDeploymentAdmin,
} from "../services/deployment-admin-gates.js";
import {
  deleteGitLabInstance,
  listGitLabInstances,
  saveGitLabInstance,
  testGitLabInstance,
} from "../services/gitlab-instance-service.js";
import { requireRole } from "../plugins/auth.js";

const Input = z.object({
  baseUrl: z
    .string()
    .min(1)
    .max(2048)
    .describe("HTTPS base URL, including any port and path prefix"),
  displayName: z.string().trim().min(1).max(200),
  caPem: z
    .string()
    .max(100_000)
    .nullable()
    .optional()
    .describe("Optional private CA certificate bundle in PEM format"),
  token: z
    .string()
    .trim()
    .min(1)
    .max(10_000)
    .nullable()
    .optional()
    .describe("Default token; omitted preserves it, null removes it"),
});
const View = z.object({
  id: z.string(),
  baseUrl: z.string(),
  displayName: z.string(),
  caPem: z.string().nullable(),
  hasToken: z.boolean(),
  source: z.enum(["app", "environment"]),
});
const Params = z.object({ id: z.string().uuid() });
const errors = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};

export async function gitlabInstanceRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  app.addHook("preHandler", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "Authentication required" });
  });
  const admin = async (
    req: Parameters<typeof refuseUnlessDeploymentAdmin>[0],
    reply: Parameters<typeof refuseUnlessDeploymentAdmin>[1],
  ) => {
    await refuseUnlessDeploymentAdmin(
      req,
      reply,
      "Only a deployment admin manages GitLab instances",
    );
  };
  app.get(
    "/api/gitlab-instances",
    {
      schema: {
        operationId: "listGitLabInstances",
        summary: "List GitLab instances",
        tags: ["Setup & Settings"],
        response: {
          200: z.object({ instances: z.array(View), canEdit: z.boolean() }),
          401: ErrorResponseSchema,
        },
      },
    },
    async (req) => ({
      instances: await listGitLabInstances(),
      canEdit: await requesterIsDeploymentAdmin(req),
    }),
  );
  app.post(
    "/api/gitlab-instances",
    {
      preHandler: [requireRole("admin"), admin],
      schema: {
        operationId: "createGitLabInstance",
        summary: "Add a GitLab instance",
        tags: ["Setup & Settings"],
        body: Input,
        response: { 200: View, ...errors },
      },
    },
    async (req, reply) => {
      try {
        return await saveGitLabInstance(req.body);
      } catch {
        return reply.code(400).send({
          error:
            "Could not save GitLab instance. Check the HTTPS URL, CA certificates and duplicate URLs.",
        });
      }
    },
  );
  app.put(
    "/api/gitlab-instances/:id",
    {
      preHandler: [requireRole("admin"), admin],
      schema: {
        operationId: "updateGitLabInstance",
        summary: "Update a GitLab instance",
        tags: ["Setup & Settings"],
        params: Params,
        body: Input,
        response: { 200: View, ...errors },
      },
    },
    async (req, reply) => {
      const rows = await listGitLabInstances();
      if (!rows.some((v) => v.id === req.params.id))
        return reply.code(404).send({ error: "GitLab instance not found" });
      try {
        return await saveGitLabInstance(req.body, req.params.id);
      } catch {
        return reply.code(400).send({
          error:
            "Could not save GitLab instance. Check for duplicate URLs; re-enter or remove the token when changing the URL.",
        });
      }
    },
  );
  app.delete(
    "/api/gitlab-instances/:id",
    {
      preHandler: [requireRole("admin"), admin],
      schema: {
        operationId: "deleteGitLabInstance",
        summary: "Remove a GitLab instance",
        tags: ["Setup & Settings"],
        params: Params,
        response: { 200: z.object({ ok: z.boolean() }), ...errors },
      },
    },
    async (req, reply) => {
      if (!(await deleteGitLabInstance(req.params.id)))
        return reply.code(404).send({ error: "GitLab instance not found" });
      return { ok: true };
    },
  );
  app.post(
    "/api/gitlab-instances/test",
    {
      preHandler: [requireRole("admin"), admin],
      schema: {
        operationId: "testGitLabInstance",
        summary: "Test GitLab version and token identity",
        tags: ["Setup & Settings"],
        body: Input.extend({ id: z.string().uuid().optional() }),
        response: {
          200: z.object({
            ok: z.boolean(),
            version: z.string().optional(),
            username: z.string().optional(),
            error: z.string().optional(),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      try {
        return await testGitLabInstance(req.body, req.body.id);
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error &&
            /^(GitLab .* returned HTTP|Enter a token|Use an HTTPS|CA certificate)/.test(err.message)
              ? err.message
              : "Connection failed. Check the URL, token and CA certificate.",
        };
      }
    },
  );
}
