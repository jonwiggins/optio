import { logger } from "../logger.js";
import { assertSsrfSafe } from "../utils/ssrf.js";
import { readLimitedResponseText } from "../utils/http-response.js";
import type { TaskState } from "@optio/shared";
import type { RepoRecord } from "./repo-service.js";

const PUBLIC_URL = process.env.PUBLIC_URL ?? "http://localhost:3000";
const MAX_SLACK_ERROR_BODY_BYTES = 2_000;

/** Task states that can trigger Slack notifications */
export const NOTIFIABLE_STATES = ["completed", "failed", "needs_attention", "pr_opened"] as const;

export type NotifiableState = (typeof NOTIFIABLE_STATES)[number];

export function isNotifiableState(state: string): state is NotifiableState {
  return (NOTIFIABLE_STATES as readonly string[]).includes(state);
}

interface TaskInfo {
  id: string;
  title: string;
  repoUrl: string;
  state: TaskState;
  prUrl?: string | null;
  costUsd?: string | null;
  errorMessage?: string | null;
}

/**
 * Determine whether a Slack notification should be sent for a state transition.
 */
export function shouldNotifySlack(toState: string, repoConfig: RepoRecord | null): boolean {
  if (!repoConfig) return false;
  if (!repoConfig.slackEnabled) return false;
  if (!repoConfig.slackWebhookUrl) return false;
  if (!isNotifiableState(toState)) return false;

  // If slackNotifyOn is configured, check if this state is in the list
  if (repoConfig.slackNotifyOn && repoConfig.slackNotifyOn.length > 0) {
    return repoConfig.slackNotifyOn.includes(toState);
  }

  // Default: notify on all notifiable states
  return true;
}

/**
 * Get the global Slack webhook URL from secrets (fallback for repos without per-repo config).
 */
export async function getGlobalSlackWebhookUrl(): Promise<string | null> {
  try {
    const { retrieveSecret } = await import("./secret-service.js");
    return await retrieveSecret("SLACK_WEBHOOK_URL").catch(() => null);
  } catch {
    return null;
  }
}

/**
 * Resolve the Slack webhook URL for a given repo — repo-level takes precedence over global.
 */
export async function resolveSlackConfig(
  repoConfig: RepoRecord | null,
): Promise<{ webhookUrl: string; channel?: string } | null> {
  if (repoConfig?.slackEnabled && repoConfig.slackWebhookUrl) {
    return {
      webhookUrl: repoConfig.slackWebhookUrl,
      channel: repoConfig.slackChannel ?? undefined,
    };
  }

  // Fall back to global webhook URL from secrets
  const globalUrl = await getGlobalSlackWebhookUrl();
  if (globalUrl) {
    return { webhookUrl: globalUrl };
  }

  return null;
}

const STATE_EMOJI: Record<NotifiableState, string> = {
  completed: ":white_check_mark:",
  failed: ":x:",
  needs_attention: ":warning:",
  pr_opened: ":git-pull-request:",
};

const STATE_COLOR: Record<NotifiableState, string> = {
  completed: "#36a64f",
  failed: "#e01e5a",
  needs_attention: "#ecb22e",
  pr_opened: "#1264a3",
};

const STATE_LABEL: Record<NotifiableState, string> = {
  completed: "Completed",
  failed: "Failed",
  needs_attention: "Needs Attention",
  pr_opened: "PR Opened",
};

/**
 * Build a Slack Block Kit message for a task event.
 */
export function buildSlackMessage(
  task: TaskInfo,
  toState: NotifiableState,
): { text: string; blocks: unknown[]; attachments: unknown[] } {
  const emoji = STATE_EMOJI[toState];
  const color = STATE_COLOR[toState];
  const label = STATE_LABEL[toState];
  const repoName = extractRepoName(task.repoUrl);
  const taskUrl = `${PUBLIC_URL}/tasks/${task.id}`;

  const fallbackText = `${emoji} *${label}*: ${task.title} (${repoName})`;

  const fields: { type: string; text: string }[] = [
    { type: "mrkdwn", text: `*Repository:*\n${repoName}` },
    { type: "mrkdwn", text: `*Status:*\n${emoji} ${label}` },
  ];

  if (task.costUsd) {
    fields.push({ type: "mrkdwn", text: `*Cost:*\n$${task.costUsd}` });
  }

  if (task.prUrl) {
    fields.push({ type: "mrkdwn", text: `*PR:*\n<${task.prUrl}|View PR>` });
  }

  const blocks: unknown[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *<${taskUrl}|${task.title}>*\n${label} in \`${repoName}\``,
      },
    },
    {
      type: "section",
      fields,
    },
  ];

  // Add error message for failed tasks
  if (toState === "failed" && task.errorMessage) {
    const truncatedError =
      task.errorMessage.length > 300 ? task.errorMessage.slice(0, 300) + "..." : task.errorMessage;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Error:*\n\`\`\`${truncatedError}\`\`\``,
      },
    });
  }

  // Action buttons
  const actions: {
    type: string;
    text: { type: string; text: string; emoji?: boolean };
    url?: string;
    action_id?: string;
    value?: string;
    style?: string;
  }[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "View Logs", emoji: true },
      url: taskUrl,
      action_id: "view_logs",
    },
  ];

  if (toState === "failed") {
    actions.push({
      type: "button",
      text: { type: "plain_text", text: "Retry", emoji: true },
      action_id: "retry_task",
      value: task.id,
      style: "primary",
    });
  }

  if (toState === "needs_attention" || toState === "failed") {
    actions.push({
      type: "button",
      text: { type: "plain_text", text: "Cancel", emoji: true },
      action_id: "cancel_task",
      value: task.id,
      style: "danger",
    });
  }

  blocks.push({
    type: "actions",
    elements: actions,
  });

  return {
    text: fallbackText,
    blocks,
    attachments: [{ color, blocks: [] }],
  };
}

/**
 * Send a notification to Slack via incoming webhook.
 */
export async function sendSlackNotification(
  webhookUrl: string,
  task: TaskInfo,
  toState: NotifiableState,
  channel?: string,
): Promise<void> {
  const message = buildSlackMessage(task, toState);

  const payload: Record<string, unknown> = {
    text: message.text,
    blocks: message.blocks,
    attachments: message.attachments,
  };

  if (channel) {
    payload.channel = channel;
  }

  // SSRF protection: verify URL does not resolve to a private/internal address
  await assertSsrfSafe(webhookUrl);

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "error",
  });

  if (!response.ok) {
    const body = (await readLimitedResponseText(response, MAX_SLACK_ERROR_BODY_BYTES)) ?? "";
    throw new Error(`Slack webhook returned ${response.status}: ${body}`);
  }

  logger.info({ taskId: task.id, state: toState }, "Slack notification sent");
}

/**
 * High-level function: send a Slack notification for a task state change.
 * Resolves config, checks if notification should be sent, and sends it.
 * Errors are logged but never thrown (fire-and-forget).
 */
export async function notifySlackOnTransition(
  task: TaskInfo,
  toState: string,
  repoConfig: RepoRecord | null,
): Promise<void> {
  try {
    if (!shouldNotifySlack(toState, repoConfig)) return;
    if (!isNotifiableState(toState)) return;

    const config = await resolveSlackConfig(repoConfig);
    if (!config) return;

    await sendSlackNotification(config.webhookUrl, task, toState, config.channel);
  } catch (err) {
    logger.warn({ err, taskId: task.id, state: toState }, "Failed to send Slack notification");
  }
}

/**
 * Handle a Slack interactive action (button click).
 */
export async function handleSlackAction(
  actionId: string,
  taskId: string,
): Promise<{ text: string }> {
  const { TaskState } = await import("@optio/shared");
  const taskService = await import("./task-service.js");

  switch (actionId) {
    case "retry_task": {
      const task = await taskService.getTask(taskId);
      if (!task) return { text: `:x: Task not found: ${taskId}` };

      try {
        await taskService.transitionTask(taskId, TaskState.QUEUED, "slack_retry");
        const { taskQueue } = await import("../workers/task-worker.js");
        await taskQueue.add(
          "process-task",
          { taskId },
          { jobId: `${taskId}-slack-retry-${Date.now()}`, attempts: 1 },
        );
        return {
          text: `:arrows_counterclockwise: Task *${task.title}* has been queued for retry.`,
        };
      } catch (err) {
        return {
          text: `:x: Failed to retry task: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    case "cancel_task": {
      const task = await taskService.getTask(taskId);
      if (!task) return { text: `:x: Task not found: ${taskId}` };

      try {
        await taskService.transitionTask(taskId, TaskState.CANCELLED, "slack_cancel");
        return { text: `:no_entry_sign: Task *${task.title}* has been cancelled.` };
      } catch (err) {
        return {
          text: `:x: Failed to cancel task: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    default:
      return { text: `Unknown action: ${actionId}` };
  }
}

function extractRepoName(repoUrl: string): string {
  const match = repoUrl.match(/([^/]+\/[^/]+)\/?$/);
  return match ? match[1] : repoUrl;
}
