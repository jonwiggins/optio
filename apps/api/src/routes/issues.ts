import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { repos, tasks } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { normalizeRepoUrl, parseRepoUrl } from "@optio/shared";
import { getGitPlatformForRepo } from "../services/git-token-service.js";
import { logger } from "../logger.js";

export async function issueRoutes(app: FastifyInstance) {
  // List issues from all configured repos (GitHub or GitLab)
  app.get("/api/issues", async (req, reply) => {
    const query = req.query as { repoId?: string; state?: string };

    const wsId = req.user?.workspaceId;
    let repoList;
    if (query.repoId) {
      const [repo] = await db.select().from(repos).where(eq(repos.id, query.repoId));
      if (!repo) return reply.status(404).send({ error: "Repo not found" });
      if (wsId && repo.workspaceId !== wsId) {
        return reply.status(404).send({ error: "Repo not found" });
      }
      repoList = [repo];
    } else if (wsId) {
      repoList = await db.select().from(repos).where(eq(repos.workspaceId, wsId));
    } else {
      repoList = await db.select().from(repos);
    }

    // Get existing tasks for cross-reference
    const existingTasks = wsId
      ? await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.workspaceId, wsId)))
      : await db.select().from(tasks);

    const taskMap = new Map(
      existingTasks
        .filter(
          (t) => (t.ticketSource === "github" || t.ticketSource === "gitlab") && t.ticketExternalId,
        )
        .map((t) => [
          `${normalizeRepoUrl(t.repoUrl)}:${t.ticketExternalId}`,
          { taskId: t.id, state: t.state },
        ]),
    );

    const allIssues: any[] = [];

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

        for (const issue of issues) {
          // Skip pull requests (GitHub API returns PRs in issues endpoint)
          if (issue.isPullRequest) continue;

          const hasOptioLabel = issue.labels.includes("optio");
          const existingTask = taskMap.get(`${normalizeRepoUrl(repo.repoUrl)}:${issue.number}`);

          allIssues.push({
            id: issue.id,
            number: issue.number,
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
            // Optio task info if exists
            optioTask: existingTask ?? null,
          });
        }
      } catch (err) {
        logger.warn({ err, repo: repo.fullName }, "Error fetching issues");
      }
    }

    // Sort: unassigned first, then by updated date
    allIssues.sort((a, b) => {
      if (a.optioTask && !b.optioTask) return 1;
      if (!a.optioTask && b.optioTask) return -1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    reply.send({ issues: allIssues });
  });

  // Assign an issue to Optio (add label + create task)
  app.post("/api/issues/assign", async (req, reply) => {
    const body = req.body as {
      issueNumber: number;
      repoId: string;
      title: string;
      body: string;
      agentType?: string;
    };

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

    // Add the "optio" label to the issue
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

    // Fetch issue comments for context
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

    // Determine ticket source from platform
    const ticketSource = ri.platform === "gitlab" ? "gitlab" : "github";

    // Construct issue URL from repo URL and issue number
    const issueUrl =
      ri.platform === "gitlab"
        ? `https://${ri.host}/${ri.owner}/${ri.repo}/-/issues/${body.issueNumber}`
        : `https://${ri.host}/${ri.owner}/${ri.repo}/issues/${body.issueNumber}`;

    // Create the Optio task
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

    // Comment on the issue
    try {
      await platform.createIssueComment(
        ri,
        body.issueNumber,
        `**Optio** is working on this issue.\n\nTask ID: \`${task.id}\`\nAgent: ${body.agentType ?? "claude-code"}`,
      );
    } catch {}

    reply.status(201).send({ task });
  });
}
