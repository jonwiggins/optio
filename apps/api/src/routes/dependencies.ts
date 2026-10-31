import { actorOf, canSee, canChange } from "../services/ownership.js";
import { canSeeWork } from "../services/work-visibility.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as dependencyService from "../services/dependency-service.js";
import * as taskService from "../services/task-service.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { TaskDependencySchema } from "../schemas/task.js";
import { requireRole } from "../plugins/auth.js";

const depParamsSchema = z
  .object({
    id: z.string().describe("Parent task UUID"),
    depTaskId: z.string().describe("Dependency task UUID to remove"),
  })
  .describe("Path parameters for dependency deletion");

const addDependenciesBodySchema = z
  .object({
    dependsOnIds: z
      .array(z.string().uuid().describe("Task UUID"))
      .min(1)
      .describe("Task IDs that the current task should depend on"),
  })
  .describe("Body for adding dependencies to a task");

const DependencyListResponseSchema = z
  .object({
    dependencies: z.array(TaskDependencySchema),
  })
  .describe("List of tasks that the queried task depends on");

const DependentListResponseSchema = z
  .object({
    dependents: z.array(TaskDependencySchema),
  })
  .describe("List of tasks that depend on the queried task");

const DependencyAddedResponseSchema = z
  .object({
    ok: z.boolean(),
  })
  .describe("Dependencies added successfully");

export async function dependencyRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/tasks/:id/dependencies",
    {
      schema: {
        operationId: "listTaskDependencies",
        summary: "List dependencies for a task",
        description: "Return the tasks that the queried task depends on (upstream).",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: DependencyListResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if ((wsId && task.workspaceId !== wsId) || !canSeeWork(task, actorOf(req))) {
        return reply.status(404).send({ error: "Task not found" });
      }
      const dependencies = await dependencyService.getDependencies(id);
      reply.send({ dependencies: await visibleDependencies(dependencies, task, req) });
    },
  );

  app.get(
    "/api/tasks/:id/dependents",
    {
      schema: {
        operationId: "listTaskDependents",
        summary: "List dependents for a task",
        description: "Return the tasks that depend on the queried task (downstream).",
        tags: ["Tasks"],
        params: IdParamsSchema,
        response: {
          200: DependentListResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if ((wsId && task.workspaceId !== wsId) || !canSeeWork(task, actorOf(req))) {
        return reply.status(404).send({ error: "Task not found" });
      }
      const dependents = await dependencyService.getDependents(id);
      reply.send({ dependents: await visibleDependencies(dependents, task, req) });
    },
  );

  app.post(
    "/api/tasks/:id/dependencies",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "addTaskDependencies",
        summary: "Add dependencies to a task",
        description:
          "Add one or more dependency edges. Fails with 400 if adding any " +
          "edge would introduce a cycle in the dependency graph.",
        tags: ["Tasks"],
        params: IdParamsSchema,
        body: addDependenciesBodySchema,
        response: {
          201: DependencyAddedResponseSchema,
          403: ErrorResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const body = req.body;

      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if ((wsId && task.workspaceId !== wsId) || !canSeeWork(task, actorOf(req))) {
        return reply.status(404).send({ error: "Task not found" });
      }

      if (
        !canChange(task.ownerUserId, actorOf(req), true, "edit", {
          ownerTeamId: task.ownerTeamId,
          orgNeeds: "member",
        })
      ) {
        return reply.status(403).send({ error: "Only its owner can change private work" });
      }

      try {
        await dependencyService.addDependencies(id, body.dependsOnIds);
        reply.status(201).send({ ok: true });
      } catch (err) {
        reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.delete(
    "/api/tasks/:id/dependencies/:depTaskId",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "removeTaskDependency",
        summary: "Remove a dependency edge",
        description: "Delete a single dependency edge. Returns 204 on success.",
        tags: ["Tasks"],
        params: depParamsSchema,
        response: {
          204: z.null().describe("Dependency edge removed"),
          403: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { id, depTaskId } = req.params;
      const task = await taskService.getTask(id);
      if (!task) return reply.status(404).send({ error: "Task not found" });
      const wsId = req.user?.workspaceId;
      if ((wsId && task.workspaceId !== wsId) || !canSeeWork(task, actorOf(req))) {
        return reply.status(404).send({ error: "Task not found" });
      }
      if (
        !canChange(task.ownerUserId, actorOf(req), true, "edit", {
          ownerTeamId: task.ownerTeamId,
          orgNeeds: "member",
        })
      ) {
        return reply.status(403).send({ error: "Only its owner can change private work" });
      }
      const removed = await dependencyService.removeDependency(id, depTaskId);
      if (!removed) return reply.status(404).send({ error: "Dependency not found" });
      reply.status(204).send(null);
    },
  );
}

/** Historic edges may predate tenant checks; never expose their other endpoint. */
async function visibleDependencies<T extends { id: string }>(
  rows: T[],
  task: { workspaceId?: string | null },
  req: FastifyRequest,
): Promise<T[]> {
  const actor = actorOf(req);
  const visible = await Promise.all(
    rows.map(async (row) => {
      const target = await taskService.getTask(row.id);
      return (
        target &&
        (target.workspaceId ?? null) === (task.workspaceId ?? null) &&
        canSeeWork(target, actor)
      );
    }),
  );
  return rows.filter((_, i) => visible[i]);
}
