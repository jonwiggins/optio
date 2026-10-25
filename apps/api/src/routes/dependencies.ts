import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as dependencyService from "../services/dependency-service.js";
import * as taskService from "../services/task-service.js";
import { actorOf } from "../services/ownership.js";
import { canSeeWork } from "../services/work-visibility.js";
import { ErrorResponseSchema, IdParamsSchema } from "../schemas/common.js";
import { TaskDependencySchema } from "../schemas/task.js";
import { requireRole } from "../plugins/auth.js";

type Edge = Awaited<ReturnType<typeof dependencyService.getDependencies>>[number];

/** The edges to tasks `actor` may see, without the owner fields used to decide. */
function visibleEdges(edges: Edge[], actor: ReturnType<typeof actorOf>) {
  return edges
    .filter((e) => canSeeWork(e, actor))
    .map(({ id, title, state, dependencyId }) => ({ id, title, state, dependencyId }));
}

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
      reply.send({
        dependencies: visibleEdges(await dependencyService.getDependencies(id), actorOf(req)),
      });
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
      reply.send({
        dependents: visibleEdges(await dependencyService.getDependents(id), actorOf(req)),
      });
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

      // Only to work the person may see in this workspace: an edge would show its title and state.
      for (const depId of body.dependsOnIds) {
        const dep = await taskService.getTask(depId);
        if (!dep || dep.workspaceId !== task.workspaceId || !canSeeWork(dep, actorOf(req))) {
          return reply.status(404).send({ error: `Task not found: ${depId}` });
        }
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
      const removed = await dependencyService.removeDependency(id, depTaskId);
      if (!removed) return reply.status(404).send({ error: "Dependency not found" });
      reply.status(204).send(null);
    },
  );
}
