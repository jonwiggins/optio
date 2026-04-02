import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { ticketProviders } from "../db/schema.js";
import { getTicketProvider } from "@optio/ticket-providers";
import type { TicketSource } from "@optio/shared";
import { TaskState, TicketSource as TicketSourceEnum, normalizeRepoUrl } from "@optio/shared";
import * as taskService from "./task-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { logger } from "../logger.js";

export async function syncAllTickets(): Promise<number> {
  const providers = await db
    .select()
    .from(ticketProviders)
    .where(eq(ticketProviders.enabled, true));

  let totalSynced = 0;

  for (const providerConfig of providers) {
    try {
      const provider = getTicketProvider(providerConfig.source as TicketSource);
      const tickets = await provider.fetchActionableTickets(providerConfig.config);

      for (const ticket of tickets) {
        // Construct repo URL: use the ticket's repo field, or fall back to provider config
        // For GitHub tickets, ticket.repo is "owner/repo"; for others, use provider config
        const repoUrl = ticket.repo
          ? normalizeRepoUrl(
              ticket.source === TicketSourceEnum.GITLAB
                ? `https://gitlab.com/${ticket.repo}`
                : `https://github.com/${ticket.repo}`,
            )
          : (providerConfig.config as any).repoUrl;

        // Check if task already exists for this ticket (scoped by repo + issue number)
        const existingTasks = await taskService.listTasks({ limit: 500 });
        const normalizedRepoUrl = normalizeRepoUrl(repoUrl);
        const alreadyExists = existingTasks.some(
          (t: any) =>
            t.ticketSource === ticket.source &&
            t.ticketExternalId === ticket.externalId &&
            normalizeRepoUrl(t.repoUrl) === normalizedRepoUrl,
        );

        if (alreadyExists) continue;

        if (!repoUrl) {
          logger.warn({ ticketId: ticket.externalId }, "No repo URL found for ticket, skipping");
          continue;
        }

        // Fetch comments for context
        let commentsSection = "";
        try {
          const comments = await provider.fetchTicketComments(
            ticket.externalId,
            providerConfig.config,
          );
          if (comments.length > 0) {
            commentsSection =
              "\n\n## Comments\n\n" +
              comments.map((c) => `**${c.author}** (${c.createdAt}):\n${c.body}`).join("\n\n");
          }
        } catch (err) {
          logger.warn({ err, ticketId: ticket.externalId }, "Failed to fetch ticket comments");
        }

        // Include attachments if available (e.g. from Jira)
        let attachmentsSection = "";
        if (ticket.attachments && ticket.attachments.length > 0) {
          attachmentsSection =
            "\n\n## Attachments\n\n" +
            ticket.attachments
              .map((a) => `- [${a.filename}](${a.url})${a.mimeType ? ` (${a.mimeType})` : ""}`)
              .join("\n");
        }

        // Resolve agent type: ticket label > repo default > "claude-code"
        const { getRepoByUrl } = await import("./repo-service.js");
        const repoConfig = await getRepoByUrl(repoUrl);
        const labelAgent = ticket.labels.includes("codex")
          ? "codex"
          : ticket.labels.includes("copilot")
            ? "copilot"
            : null;
        const agentType = labelAgent ?? repoConfig?.defaultAgentType ?? "claude-code";

        const task = await taskService.createTask({
          title: ticket.title,
          prompt: `${ticket.title}\n\n${ticket.body}${commentsSection}${attachmentsSection}`,
          repoUrl,
          agentType,
          ticketSource: ticket.source,
          ticketExternalId: ticket.externalId,
          metadata: { ticketUrl: ticket.url },
        });

        await taskService.transitionTask(task.id, TaskState.QUEUED, "ticket_sync");
        await taskQueue.add(
          "process-task",
          { taskId: task.id },
          {
            jobId: task.id,
            attempts: task.maxRetries + 1,
            backoff: { type: "exponential", delay: 5000 },
          },
        );

        // Comment on the ticket
        try {
          await provider.addComment(
            ticket.externalId,
            `🤖 **Optio** is working on this issue.\n\nTask ID: \`${task.id}\`\nAgent: ${agentType}`,
            providerConfig.config,
          );
        } catch (commentErr) {
          logger.warn(
            { err: commentErr, ticketId: ticket.externalId },
            "Failed to comment on ticket",
          );
        }

        totalSynced++;
      }
    } catch (err) {
      logger.error(
        { err, provider: providerConfig.source },
        "Failed to sync tickets from provider",
      );
    }
  }

  return totalSynced;
}
