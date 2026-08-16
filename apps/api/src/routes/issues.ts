import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import { repos, tasks, ticketProviders } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { normalizeRepoUrl, parseRepoUrl } from "@optio/shared";
import type { TicketSource } from "@optio/shared";
import { getTicketProvider } from "@optio/ticket-providers";
import { getGitPlatformForRepo } from "../services/git-token-service.js";
import { retrieveSecret } from "../services/secret-service.js";
import { getGitHubToken } from "../services/github-token-service.js";
import { logger } from "../logger.js";
import { ErrorResponseSchema } from "../schemas/common.js";
import { IssueSummarySchema } from "../schemas/session.js";
import { TaskSchema } from "../schemas/task.js";
import { requireRole } from "../plugins/auth.js";

const issuesQuerySchema = z
  .object({
    repoId: z.string().optional().describe("Restrict results to a single repo"),
    state: z.string().optional().describe("`open` (default) | `closed` | `all`"),
  })
  .describe("Query parameters for listing issues");

const assignIssueSchema = z
  .object({
    issueNumber: z.number().int().positive().describe("Ticket provider issue number"),
    repoId: z.string().min(1).describe("Repo UUID that owns the issue"),
    title: z.string().min(1),
    body: z.string().describe("Issue body (markdown)"),
    agentType: z.string().optional().describe("Agent runtime override"),
  })
  .describe("Body for assigning an issue to Optio");

const IssueListResponseSchema = z
  .object({
    issues: z.array(IssueSummarySchema),
  })
  .describe("List of issues aggregated across configured repos");

const TaskResponseSchema = z
  .object({
    task: TaskSchema,
  })
  .describe("Task envelope");

export async function issueRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/issues",
    {
      schema: {
        operationId: "listIssues",
        summary: "List issues from configured repos",
        description:
          "Aggregate open issues across every configured repository in the " +
          "current workspace (GitHub or GitLab). Each issue is decorated " +
          "with a `hasOptioLabel` flag and, if Optio is already working on " +
          "it, the corresponding `optioTask` reference. Sorted " +
          "unassigned-first, then by update recency.",
        tags: ["Reviews & PRs"],
        querystring: issuesQuerySchema,
        response: {
          200: IssueListResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const query = req.query;

      const wsId = req.user?.workspaceId;
      let repoList;
      if (query.repoId) {
        const [repo] = await db.select().from(repos).where(eq(repos.id, query.repoId));
        if (!repo) return reply.send({ issues: [] });
        if (wsId && repo.workspaceId !== wsId) {
          return reply.send({ issues: [] });
        }
        repoList = [repo];
      } else if (wsId) {
        repoList = await db.select().from(repos).where(eq(repos.workspaceId, wsId));
      } else {
        repoList = await db.select().from(repos);
      }

      const taskSelect = {
        ticketSource: tasks.ticketSource,
        ticketExternalId: tasks.ticketExternalId,
        repoUrl: tasks.repoUrl,
        id: tasks.id,
        state: tasks.state,
      };
      const existingTasks = wsId
        ? await db.select(taskSelect).from(tasks).where(eq(tasks.workspaceId, wsId))
        : await db.select(taskSelect).from(tasks);

      // Repo-scoped task lookup (github/gitlab issues live under a specific repo,
      // and issue numbers can repeat across repos — must include the repo URL in the key).
      const repoTaskMap = new Map(
        existingTasks
          .filter(
            (t) =>
              (t.ticketSource === "github" || t.ticketSource === "gitlab") && t.ticketExternalId,
          )
          .map((t) => [
            `${normalizeRepoUrl(t.repoUrl)}:${t.ticketExternalId}`,
            { taskId: t.id, state: t.state },
          ]),
      );

      // Source-scoped task lookup for external trackers (Linear/Jira/Notion).
      // External IDs are globally unique within a source (e.g. "ENG-123", "PROJ-42").
      const externalTaskMap = new Map(
        existingTasks
          .filter(
            (t) =>
              t.ticketSource &&
              t.ticketSource !== "github" &&
              t.ticketSource !== "gitlab" &&
              t.ticketExternalId,
          )
          .map((t) => [
            `${t.ticketSource}:${t.ticketExternalId}`,
            { taskId: t.id, state: t.state },
          ]),
      );

      const allIssues: Array<Record<string, unknown>> = [];

      for (const repo of repoList) {
        try {
          const ri = parseRepoUrl(repo.repoUrl);
          if (!ri) continue;

          const { platform } = await getGitPlatformForRepo(repo.repoUrl, {
            userId: req.user?.id,
            server: !req.user,
          }).catch(() => ({ platform: null }));
          if (!platform) continue;

          const issueState = query.state ?? "open";
          const issues = await platform.listIssues(ri, { state: issueState, perPage: 50 });
          const repoSource: TicketSource =
            ri.platform === "gitlab" ? ("gitlab" as TicketSource) : ("github" as TicketSource);

          for (const issue of issues) {
            if (issue.isPullRequest) continue;

            const hasOptioLabel = issue.labels.includes("optio");
            const existingTask = repoTaskMap.get(
              `${normalizeRepoUrl(repo.repoUrl)}:${issue.number}`,
            );

            allIssues.push({
              id: issue.id,
              number: issue.number,
              externalId: String(issue.number),
              source: repoSource,
              title: issue.title,
              body: issue.body,
              state: issue.state,
              url: issue.url,
              labels: issue.labels,
              hasOptioLabel,
              author: issue.author || null,
              assignee: issue.assignee,
              repo: {
                id: repo.id,
                fullName: repo.fullName,
                repoUrl: repo.repoUrl,
              },
              createdAt: issue.createdAt,
              updatedAt: issue.updatedAt,
              optioTask: existingTask ?? null,
            });
          }
        } catch (err) {
          logger.warn({ err, repo: repo.fullName }, "Error fetching issues");
        }
      }

      // Fan out to configured external ticket providers (Linear, Jira, Notion).
      // GitHub / GitLab providers are skipped here since the repo loop above
      // already covers their issues via getGitPlatformForRepo.
      if (!query.repoId) {
        const providerRows = await db
          .select()
          .from(ticketProviders)
          .where(eq(ticketProviders.enabled, true));

        for (const providerRow of providerRows) {
          if (providerRow.source === "github" || providerRow.source === "gitlab") continue;
          try {
            let mergedConfig = { ...((providerRow.config as Record<string, unknown>) ?? {}) };
            try {
              const secretJson = await retrieveSecret(
                `ticket-provider:${providerRow.id}`,
                "ticket-provider",
              );
              mergedConfig = { ...mergedConfig, ...JSON.parse(secretJson) };
            } catch {
              // No stored secret — use config as-is.
            }

            const provider = getTicketProvider(providerRow.source as TicketSource);
            const tickets = await provider.fetchActionableTickets(mergedConfig);

            for (const ticket of tickets) {
              const meta = (ticket.metadata ?? {}) as Record<string, unknown>;
              const createdAt =
                (meta.createdAt as string | undefined) ??
                (meta.created as string | undefined) ??
                (meta.createdTime as string | undefined) ??
                null;
              const updatedAt =
                (meta.updatedAt as string | undefined) ??
                (meta.updated as string | undefined) ??
                (meta.lastEditedTime as string | undefined) ??
                createdAt;

              const existingTask = externalTaskMap.get(`${ticket.source}:${ticket.externalId}`);

              allIssues.push({
                id: `${ticket.source}:${ticket.externalId}`,
                number: ticket.externalId,
                externalId: ticket.externalId,
                source: ticket.source,
                title: ticket.title,
                body: ticket.body,
                // fetchActionableTickets already filters to active/open tickets.
                state: "open",
                url: ticket.url,
                labels: ticket.labels,
                hasOptioLabel: true,
                author: null,
                assignee: ticket.assignee ?? null,
                repo: {
                  id: null,
                  fullName: ticket.repo ?? `${ticket.source} provider`,
                  repoUrl: null,
                  providerId: providerRow.id,
                },
                createdAt,
                updatedAt,
                optioTask: existingTask ?? null,
              });
            }
          } catch (err) {
            logger.warn(
              { err, providerSource: providerRow.source, providerId: providerRow.id },
              "Error fetching tickets from external provider",
            );
          }
        }
      }

      allIssues.sort((a, b) => {
        if (a.optioTask && !b.optioTask) return 1;
        if (!a.optioTask && b.optioTask) return -1;
        return (
          new Date(b.updatedAt as string).getTime() - new Date(a.updatedAt as string).getTime()
        );
      });

      reply.send({ issues: allIssues });
    },
  );

  app.post(
    "/api/issues/assign",
    {
      preHandler: [requireRole("member")],
      schema: {
        operationId: "assignIssueToOptio",
        summary: "Assign an issue to Optio",
        description:
          "Add the `optio` label to the issue, create a task with the " +
          "issue body (plus comments) as its prompt, enqueue it, and post " +
          "a confirmation comment back on the issue.",
        tags: ["Reviews & PRs"],
        body: assignIssueSchema,
        response: {
          201: TaskResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const body = req.body;

      const [repo] = await db.select().from(repos).where(eq(repos.id, body.repoId));
      if (!repo) return reply.status(404).send({ error: "Repo not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && repo.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }

      const ri = parseRepoUrl(repo.repoUrl);
      if (!ri) return reply.status(400).send({ error: "Cannot parse repo URL" });

      const { platform } = await getGitPlatformForRepo(repo.repoUrl, {
        userId: req.user?.id,
        server: !req.user,
      }).catch(() => ({ platform: null }));
      if (!platform) {
        return reply.status(503).send({ error: "No git token configured" });
      }

      try {
        await platform.createLabel(ri, {
          name: "optio",
          color: "6d28d9",
          description: "Assigned to Optio AI agent",
        });
        await platform.addLabelsToIssue(ri, body.issueNumber, ["optio"]);
      } catch (err) {
        logger.warn({ err }, "Failed to add optio label");
      }

      let commentsSection = "";
      try {
        const issueComments = await platform.getIssueComments(ri, body.issueNumber);
        if (issueComments.length > 0) {
          commentsSection =
            "\n\n## Comments\n\n" +
            issueComments.map((c) => `**${c.author}** (${c.createdAt}):\n${c.body}`).join("\n\n");
        }
      } catch (err) {
        logger.warn({ err, issueNumber: body.issueNumber }, "Failed to fetch issue comments");
      }

      const ticketSource = ri.platform === "gitlab" ? "gitlab" : "github";

      const issueUrl =
        ri.platform === "gitlab"
          ? `https://${ri.host}/${ri.owner}/${ri.repo}/-/issues/${body.issueNumber}`
          : `https://${ri.host}/${ri.owner}/${ri.repo}/issues/${body.issueNumber}`;

      const taskServiceModule = await import("../services/task-service.js");
      const { TaskState } = await import("@optio/shared");
      const { taskQueue } = await import("../workers/task-worker.js");

      const task = await taskServiceModule.createTask({
        title: body.title,
        prompt: `${body.title}\n\n${body.body}${commentsSection}`,
        repoUrl: repo.repoUrl,
        agentType: body.agentType ?? repo.defaultAgentType ?? "claude-code",
        ticketSource,
        ticketExternalId: String(body.issueNumber),
        metadata: { issueUrl },
        createdBy: req.user?.id,
        workspaceId: req.user?.workspaceId ?? null,
      });

      await taskServiceModule.transitionTask(task.id, TaskState.QUEUED, "issue_assigned");
      await taskQueue.add(
        "process-task",
        { taskId: task.id },
        {
          jobId: task.id,
          priority: task.priority ?? 100,
          attempts: task.maxRetries + 1,
          backoff: { type: "exponential", delay: 5000 },
        },
      );

      try {
        await platform.createIssueComment(
          ri,
          body.issueNumber,
          `**Optio** is working on this issue.\n\nTask ID: \`${task.id}\`\nAgent: ${body.agentType ?? "claude-code"}`,
        );
      } catch {
        /* non-critical */
      }

      reply.status(201).send({ task });
    },
  );
}
