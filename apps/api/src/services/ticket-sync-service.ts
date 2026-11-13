import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { ticketProviders, repos, ticketSyncClaims } from "../db/schema.js";
import { getTicketProvider } from "@optio/ticket-providers";
import type { TicketSource } from "@optio/shared";
import { TaskState, normalizeRepoUrl } from "@optio/shared";
import * as taskService from "./task-service.js";
import { taskQueue } from "../workers/task-worker.js";
import { retrieveSecret } from "./secret-service.js";
import { getGitHubToken } from "./github-token-service.js";
import { logger } from "../logger.js";
import { buildCommentsSection } from "./ticket-context.js";
import { recordAuthEvent } from "./auth-failure-detector.js";

/** Auto-disable a provider after this many consecutive failures. */
const MAX_CONSECUTIVE_FAILURES = 5;

/** A task-less claim older than this was left by a sweep that died mid-way. */
const ABANDONED_CLAIM = "10 minutes";

/**
 * Claims (source, ticket, repo) for this sweep: the insert lands once,
 * however many sweeps overlap (docs/plans/scale-out.md §3). True iff this
 * caller holds the claim and may create the task. A claim whose task never
 * got created (`task_id` null) is released by `releaseTicketClaim`, so it
 * does not block the ticket forever; one whose sweep died before that is
 * taken over after ten minutes, and one whose task was deleted is taken
 * over at once (a deleted task is re-created, as before claims existed).
 * The takeover is the same one statement, so two racing sweeps still get
 * one claim.
 */
export async function claimTicketForSync(
  source: string,
  externalId: string,
  repoUrl: string,
): Promise<boolean> {
  const rows = await db.execute<{ ticket_external_id: string }>(sql`
    INSERT INTO "ticket_sync_claims" ("ticket_source", "ticket_external_id", "repo_url")
    VALUES (${source}, ${externalId}, ${repoUrl})
    ON CONFLICT ("ticket_source", "ticket_external_id", "repo_url") DO UPDATE
      SET "task_id" = NULL, "created_at" = now()
      WHERE ("ticket_sync_claims"."task_id" IS NULL
             AND "ticket_sync_claims"."created_at" < now() - ${ABANDONED_CLAIM}::interval)
         OR ("ticket_sync_claims"."task_id" IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM "tasks" t WHERE t."id" = "ticket_sync_claims"."task_id"))
    RETURNING "ticket_external_id"`);
  return rows.length > 0;
}

/** Records the task a claim produced. */
export async function recordTicketClaimTask(
  source: string,
  externalId: string,
  repoUrl: string,
  taskId: string,
): Promise<void> {
  await db
    .update(ticketSyncClaims)
    .set({ taskId })
    .where(
      and(
        eq(ticketSyncClaims.ticketSource, source),
        eq(ticketSyncClaims.ticketExternalId, externalId),
        eq(ticketSyncClaims.repoUrl, repoUrl),
      ),
    );
}

/** Gives a claim back when creating its task failed (only a task-less claim is released). */
export async function releaseTicketClaim(
  source: string,
  externalId: string,
  repoUrl: string,
): Promise<void> {
  await db
    .delete(ticketSyncClaims)
    .where(
      and(
        eq(ticketSyncClaims.ticketSource, source),
        eq(ticketSyncClaims.ticketExternalId, externalId),
        eq(ticketSyncClaims.repoUrl, repoUrl),
        isNull(ticketSyncClaims.taskId),
      ),
    )
    .catch((err) => logger.warn({ err, source, externalId }, "Could not release ticket claim"));
}

export function ticketCallConfig(
  ticket: { source: string; repo?: string },
  mergedConfig: Record<string, unknown>,
): Record<string, unknown> {
  if (ticket.source === "gitlab" && !mergedConfig.projectPath && ticket.repo) {
    return { ...mergedConfig, projectPath: ticket.repo };
  }
  return mergedConfig;
}

export async function syncAllTickets(): Promise<number> {
  const providers = await db
    .select()
    .from(ticketProviders)
    .where(eq(ticketProviders.enabled, true));

  // Fetch configured repos once before the provider loop (avoids redundant
  // queries). A provider matches its own workspace's repos only.
  const allRepos = await db
    .select({ repoUrl: repos.repoUrl, workspaceId: repos.workspaceId })
    .from(repos);

  let totalSynced = 0;

  for (const providerConfig of providers) {
    const providerWorkspaceId = providerConfig.workspaceId ?? null;
    const configuredRepos = providerWorkspaceId
      ? allRepos.filter((r) => r.workspaceId === providerWorkspaceId)
      : allRepos;
    try {
      // Merge encrypted credentials from secrets store into provider config
      let mergedConfig = { ...(providerConfig.config ?? {}) };
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
          (mergedConfig as { token?: string }).token = await getGitHubToken({
            server: true,
            workspaceId: providerWorkspaceId,
          });
        } catch (err) {
          logger.warn(
            { err, providerId: providerConfig.id },
            "[ticket-sync] No GitHub token available from app/PAT fallback",
          );
        }
      }

      const provider = getTicketProvider(providerConfig.source as TicketSource);
      const tickets = await provider.fetchActionableTickets(mergedConfig);

      // First sweep after the provider was configured: everything it matches
      // is pre-existing backlog, not a ticket the user filed expecting an
      // agent. Auto-queueing the whole backlog starts work (and spends
      // tokens) nobody initiated — issue #579. Backfilled tasks are created
      // in `pending` for review and must be started explicitly; syncs after
      // the initial_sync_at stamp auto-queue as before.
      const isFirstSync = providerConfig.initialSyncAt == null;

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
              // A self-hosted GitLab: the provider config names its base URL,
              // or its host (the GitLab provider talks to https://<host>).
              const { baseUrl, host } = mergedConfig as { baseUrl?: string; host?: string };
              const base = baseUrl
                ? baseUrl.replace(/\/+$/, "")
                : `https://${(host || "gitlab.com").replace(/^https?:\/\//i, "").replace(/\/+$/, "")}`;
              repoUrl = normalizeRepoUrl(`${base}/${repo}`);
            } else {
              repoUrl = normalizeRepoUrl(`https://github.com/${repo}`);
            }
          }
        } else {
          const configured = (mergedConfig as { repoUrl?: string }).repoUrl;
          if (configured) repoUrl = normalizeRepoUrl(configured);
        }

        if (!repoUrl) {
          logger.warn({ ticketId: ticket.externalId }, "No repo URL found for ticket, skipping");
          continue;
        }

        // A workspace's provider starts work only in that workspace's repos.
        const resolvedRepoUrl = normalizeRepoUrl(repoUrl);
        if (
          providerWorkspaceId &&
          !configuredRepos.some((r) => normalizeRepoUrl(r.repoUrl) === resolvedRepoUrl)
        ) {
          logger.debug(
            { ticketId: ticket.externalId, repoUrl, providerId: providerConfig.id },
            "[ticket-sync] Ticket's repo isn't one of the provider's workspace's repos, skipping",
          );
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

        // Claim the ticket for this repo before creating anything: two
        // sweeps that overlap (two API instances, or a slow sweep and the
        // next tick) both get past the scan above, and only the one whose
        // claim row lands creates the task.
        if (!(await claimTicketForSync(ticket.source, ticket.externalId, normalizedRepoUrl))) {
          logger.debug(
            { ticketId: ticket.externalId, repoUrl: normalizedRepoUrl },
            "[ticket-sync] Ticket already claimed by another sweep",
          );
          continue;
        }

        // Fetch comments for context
        let commentsSection = "";
        try {
          const comments = await provider.fetchTicketComments(
            ticket.externalId,
            ticketCallConfig(ticket, mergedConfig),
          );
          commentsSection = buildCommentsSection(comments);
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
        const repoConfig = await getRepoByUrl(repoUrl, providerWorkspaceId);

        const labelAgent = ticket.labels.includes("codex")
          ? "codex"
          : ticket.labels.includes("copilot")
            ? "copilot"
            : null;
        const agentType = labelAgent ?? repoConfig?.defaultAgentType ?? "claude-code";

        let task: Awaited<ReturnType<typeof taskService.createTask>>;
        try {
          task = await taskService.createTask({
            title: ticket.title,
            prompt: `${ticket.title}\n\n${ticket.body}${commentsSection}${attachmentsSection}`,
            repoUrl,
            agentType,
            ticketSource: ticket.source,
            ticketExternalId: ticket.externalId,
            metadata: { ticketUrl: ticket.url },
            // Inherit the repo's workspace so webhook/poll-created tasks are
            // visible in the (workspace-scoped) UI — see issue #544.
            workspaceId: repoConfig?.workspaceId ?? null,
          });
        } catch (err) {
          // The claim is only good with a task behind it: give it back so
          // the next sweep tries again.
          await releaseTicketClaim(ticket.source, ticket.externalId, normalizedRepoUrl);
          throw err;
        }
        // The task exists: a failure to note it on the claim must not strand
        // it (or stop this provider's sweep). The claim stays task-less and
        // is taken over after a while; the scan above still finds the task.
        await recordTicketClaimTask(
          ticket.source,
          ticket.externalId,
          normalizedRepoUrl,
          task.id,
        ).catch((err) =>
          logger.warn(
            { err, taskId: task.id, ticketId: ticket.externalId },
            "[ticket-sync] Could not record the task on its ticket claim",
          ),
        );

        if (isFirstSync) {
          // Backfill: leave the task pending for the user to start, don't
          // announce work on the ticket, and don't mass-fire ticket triggers.
          logger.info(
            { taskId: task.id, ticketId: ticket.externalId, providerId: providerConfig.id },
            "[ticket-sync] Initial sweep: created backfill task in pending (not auto-started)",
          );
          totalSynced++;
          continue;
        }

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
            ticketCallConfig(ticket, mergedConfig),
          );
        } catch (commentErr) {
          logger.warn(
            { err: commentErr, ticketId: ticket.externalId },
            "Failed to comment on ticket",
          );
        }

        totalSynced++;

        // Fire every ticket trigger that matches this ticket, whatever it
        // targets — a workspace-wide "security" scheduled Task that runs on
        // every ticket labeled cve, a Job, a Local automation, a persistent
        // agent. These spawn alongside the repo-scoped task above.
        try {
          const { fireTicketTriggers } = await import("./trigger-dispatch.js");
          await fireTicketTriggers(
            {
              source: ticket.source,
              externalId: ticket.externalId,
              title: ticket.title,
              body: ticket.body,
              labels: ticket.labels,
              url: ticket.url,
            },
            { repoUrl, workspaceId: providerWorkspaceId },
          );
        } catch (triggerErr) {
          logger.warn(
            { err: triggerErr, ticketId: ticket.externalId },
            "Failed to fire ticket triggers",
          );
        }
      }

      // The sweep completed: from now on, matching tickets auto-queue.
      if (isFirstSync) {
        await db
          .update(ticketProviders)
          .set({ initialSyncAt: new Date() })
          .where(eq(ticketProviders.id, providerConfig.id));
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
