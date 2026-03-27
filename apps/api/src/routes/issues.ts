import type { FastifyInstance } from "fastify";
import { db } from "../db/client.js";
import { repos, tasks } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { getGitHubToken } from "../services/github-token-service.js";
import { logger } from "../logger.js";

export async function issueRoutes(app: FastifyInstance) {
  // List GitHub issues from all configured repos
  app.get("/api/issues", async (req, reply) => {
    const query = req.query as { repoId?: string; state?: string };

    const githubToken = await getGitHubToken({ userId: req.user!.id }).catch(() => null);
    if (!githubToken) {
      return reply.status(503).send({ issues: [], error: "No GitHub token configured" });
    }

    const headers = {
      Authorization: `Bearer ${githubToken}`,
      "User-Agent": "Optio",
      Accept: "application/vnd.github.v3+json",
    };

    // Get repos to fetch issues from (scoped to workspace)
    const workspaceId = req.user?.workspaceId;
    let repoList: (typeof repos.$inferSelect)[];
    if (query.repoId) {
      const [repo] = await db.select().from(repos).where(eq(repos.id, query.repoId));
      if (repo && workspaceId && repo.workspaceId !== workspaceId) {
        repoList = [];
      } else {
        repoList = repo ? [repo] : [];
      }
    } else if (workspaceId) {
      repoList = await db.select().from(repos).where(eq(repos.workspaceId, workspaceId));
    } else {
      repoList = await db.select().from(repos);
    }

    if (repoList.length === 0) {
      return reply.send({ issues: [] });
    }

    // Get existing Optio tasks to know which issues are already assigned (scoped to workspace)
    const taskConditions = [];
    if (workspaceId) taskConditions.push(eq(tasks.workspaceId, workspaceId));
    const existingTasks = await db
      .select({
        ticketSource: tasks.ticketSource,
        ticketExternalId: tasks.ticketExternalId,
        id: tasks.id,
        state: tasks.state,
      })
      .from(tasks)
      .where(taskConditions.length > 0 ? and(...taskConditions) : undefined);

    const taskMap = new Map(
      existingTasks
        .filter((t) => t.ticketSource === "github" && t.ticketExternalId)
        .map((t) => [`${t.ticketExternalId}`, { taskId: t.id, state: t.state }]),
    );

    const allIssues: any[] = [];

    for (const repo of repoList) {
      try {
        const match = repo.repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
        if (!match) continue;
        const [, owner, repoName] = match;

        const issueState = query.state ?? "open";
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${repoName}/issues?state=${issueState}&per_page=50&sort=updated&direction=desc`,
          { headers },
        );

        if (!res.ok) {
          logger.warn({ repo: repo.fullName, status: res.status }, "Failed to fetch issues");
          continue;
        }

        const issues = (await res.json()) as any[];

        for (const issue of issues) {
          // Skip pull requests (GitHub API returns PRs in issues endpoint)
          if (issue.pull_request) continue;

          const labels = (issue.labels ?? []).map((l: any) => (typeof l === "string" ? l : l.name));
          const hasOptioLabel = labels.includes("optio");
          const existingTask = taskMap.get(String(issue.number));

          allIssues.push({
            id: issue.id,
            number: issue.number,
            title: issue.title,
            body: issue.body ?? "",
            state: issue.state,
            url: issue.html_url,
            labels,
            hasOptioLabel,
            assignee: issue.assignee?.login,
            repo: {
              id: repo.id,
              fullName: repo.fullName,
              repoUrl: repo.repoUrl,
            },
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
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

    const githubToken = await getGitHubToken({ userId: req.user!.id }).catch(() => null);
    if (!githubToken) {
      return reply.status(503).send({ error: "No GitHub token configured" });
    }

    const match = repo.repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (!match) return reply.status(400).send({ error: "Cannot parse repo URL" });
    const [, owner, repoName] = match;

    const headers = {
      Authorization: `Bearer ${githubToken}`,
      "User-Agent": "Optio",
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    };

    // Add the "optio" label to the issue
    try {
      // Ensure the label exists
      await fetch(`https://api.github.com/repos/${owner}/${repoName}/labels`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "optio",
          color: "6d28d9",
          description: "Assigned to Optio AI agent",
        }),
      }); // Ignore errors (label may already exist)

      // Add label to issue
      await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/issues/${body.issueNumber}/labels`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ labels: ["optio"] }),
        },
      );
    } catch (err) {
      logger.warn({ err }, "Failed to add optio label");
    }

    // Create the Optio task
    const taskServiceModule = await import("../services/task-service.js");
    const { TaskState } = await import("@optio/shared");
    const { taskQueue } = await import("../workers/task-worker.js");

    const task = await taskServiceModule.createTask({
      title: body.title,
      prompt: `${body.title}\n\n${body.body}`,
      repoUrl: repo.repoUrl,
      agentType: body.agentType ?? "claude-code",
      ticketSource: "github",
      ticketExternalId: String(body.issueNumber),
      metadata: { issueUrl: `https://github.com/${owner}/${repoName}/issues/${body.issueNumber}` },
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
      await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/issues/${body.issueNumber}/comments`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            body: `**Optio** is working on this issue.\n\nTask ID: \`${task.id}\`\nAgent: ${body.agentType ?? "claude-code"}`,
          }),
        },
      );
    } catch {}

    reply.status(201).send({ task });
  });
}
