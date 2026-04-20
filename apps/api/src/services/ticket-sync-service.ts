import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { ticketProviders, repos } from "../db/schema.js";
import { getTicketProvider } from "@optio/ticket-providers";
import type { TicketSource } from "@optio/shared";
import { TaskState, normalizeRepoUrl } from "@optio/shared";
import * as taskService from "./task-service.js";
import * as taskConfigService from "./task-config-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { retrieveSecret } from "./secret-service.js";
import { getGitHubToken } from "./github-token-service.js";
import { logger } from "../logger.js";
import { recordAuthEvent } from "./auth-failure-detector.js";

/** Auto-disable a provider after this many consecutive failures. */
const MAX_CONSECUTIVE_FAILURES = 5;

export async function syncAllTickets(): Promise<number> {
  const providers = await db
    .select()
    .from(ticketProviders)
    .where(eq(ticketProviders.enabled, true));

  // Fetch configured repos once before the provider loop (avoids redundant queries)
  const configuredRepos = await db.select({ repoUrl: repos.repoUrl }).from(repos);

  let totalSynced = 0;

  for (const providerConfig of providers) {
    try {
      // Merge encrypted credentials from secrets store into provider config
      let mergedConfig = { ...((providerConfig.config as Record<string, unknown>) ?? {}) };
      try {
        const secretJson = await retrieveSecret(
          `ticket-provider:${providerConfig.id}`,
          "ticket-provider",
        );
        const credentials = JSON.parse(secretJson);
        mergedConfig = { ...mergedConfig, ...credentials };
      } catch {
        // No secrets stored for this provider — use config as-is
      }

      // GitHub fallback: if no token was supplied via config or provider secret,
      // resolve one via the centralized token service (GitHub App installation
      // token → PAT). Lets users run ticket sync with only a GitHub App configured.
      if (providerConfig.source === "github" && !(mergedConfig as { token?: string }).token) {
        try {
          (mergedConfig as { token?: string }).token = await getGitHubToken({ server: true });
        } catch (err) {
          logger.warn(
            { err, providerId: providerConfig.id },
            "[ticket-sync] No GitHub token available from app/PAT fallback",
          );
        }
      }

      const provider = getTicketProvider(providerConfig.source as TicketSource);
      const tickets = await provider.fetchActionableTickets(mergedConfig);

      // Success — clear any previous error state
      if ((providerConfig as any).consecutiveFailures > 0 || (providerConfig as any).lastError) {
        await db
          .update(ticketProviders)
          .set({
            lastError: null,
            lastErrorAt: null,
            consecutiveFailures: 0,
          })
          .where(eq(ticketProviders.id, providerConfig.id));
      }

      for (const ticket of tickets) {
        // Construct repo URL: use the ticket's repo field, or fall back to provider config
        // ticket.repo can be "owner/repo", a partial path, or a full URL
        let repoUrl: string | undefined;
        if (ticket.repo) {
          const repo = ticket.repo;
          if (repo.startsWith("http://") || repo.startsWith("https://")) {
            repoUrl = normalizeRepoUrl(repo);
          } else {
            // Try to match against configured repos by path suffix (handles subgroups, orgs)
            const match = configuredRepos.find((r) =>
              r.repoUrl.toLowerCase().endsWith(`/${repo.toLowerCase()}`),
            );
            if (match) {
              repoUrl = normalizeRepoUrl(match.repoUrl);
            } else if (providerConfig.source === "gitlab") {
              // Use provider config baseUrl for self-hosted GitLab instances
              const baseUrl =
                (mergedConfig as Record<string, unknown>).baseUrl ?? "https://gitlab.com";
              repoUrl = normalizeRepoUrl(`${baseUrl}/${repo}`);
            } else {
              repoUrl = normalizeRepoUrl(`https://github.com/${repo}`);
            }
          }
        } else {
          repoUrl = (mergedConfig as any).repoUrl;
        }

        if (!repoUrl) {
          logger.warn({ ticketId: ticket.externalId }, "No repo URL found for ticket, skipping");
          continue;
        }

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

        // Fetch comments for context
        let commentsSection = "";
        try {
          const comments = await provider.fetchTicketComments(ticket.externalId, mergedConfig);
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
            mergedConfig,
          );
        } catch (commentErr) {
          logger.warn(
            { err: commentErr, ticketId: ticket.externalId },
            "Failed to comment on ticket",
          );
        }

        totalSynced++;

        // Fire any task_config ticket triggers that match this ticket. These
        // spawn additional tasks alongside the repo-scoped task above — e.g.
        // a "security" workspace-wide task_config that runs on every ticket
        // labeled cve.
        try {
          await taskConfigService.fireTicketTriggers({
            source: ticket.source,
            externalId: ticket.externalId,
            title: ticket.title,
            body: ticket.body,
            labels: ticket.labels,
            url: ticket.url,
          });
        } catch (triggerErr) {
          logger.warn(
            { err: triggerErr, ticketId: ticket.externalId },
            "Failed to fire ticket triggers for task_configs",
          );
        }
      }
    } catch (err: any) {
      const errorMessage = err?.message ?? String(err);
      const prevFailures = (providerConfig as any).consecutiveFailures ?? 0;
      const newFailures = prevFailures + 1;
      const prevError = (providerConfig as any).lastError;

      // Rate-limit logging: downgrade to debug when the same error repeats
      const isRepeat = prevFailures > 0 && prevError === errorMessage;
      if (isRepeat) {
        logger.debug(
          { err, provider: providerConfig.source },
          "Repeated failure to sync tickets from provider",
        );
      } else {
        logger.error(
          { err, provider: providerConfig.source },
          "Failed to sync tickets from provider",
        );
      }

      // Persist the error on the provider row
      const updateFields: Record<string, unknown> = {
        lastError: errorMessage,
        lastErrorAt: new Date(),
        consecutiveFailures: newFailures,
      };

      // Auto-disable after N consecutive failures
      if (newFailures >= MAX_CONSECUTIVE_FAILURES) {
        updateFields.enabled = false;
        logger.warn(
          { provider: providerConfig.source, providerId: providerConfig.id, failures: newFailures },
          "Auto-disabled ticket provider after repeated failures",
        );
      }

      await db
        .update(ticketProviders)
        .set(updateFields)
        .where(eq(ticketProviders.id, providerConfig.id));

      if (err?.status === 401 || err?.message?.includes("Bad credentials")) {
        recordAuthEvent(
          "github",
          err.message ?? "GitHub 401",
          `ticket-sync:${providerConfig.id}`,
        ).catch(() => {});
      }
    }
  }

  return totalSynced;
}
