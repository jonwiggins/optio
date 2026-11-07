import {
  WEBHOOK_FORMAT_IDS,
  isWebhookFormat as isKnownWebhookFormat,
  type WebhookFormat as KnownWebhookFormat,
} from "@optio/shared";
import { isPostFormat, renderPost, type ChatPost } from "./chat-posts.js";
import { mdText, mdUrl, noMentions, teamsText } from "./chat-text.js";
import { publicWebUrl, repoName, workPath } from "./templates.js";

export { mdText, teamsText };

/**
 * The body of an outbound webhook (webhook-service.ts `deliverWebhook`),
 * shaped for where it goes. The webhook's `format` picks it:
 *
 *   generic     { event, timestamp, data }       (the original JSON; signatures unchanged)
 *   slack       the original Slack blocks (webhook-service.ts)
 *   mattermost  { text }  Markdown, as a Mattermost incoming webhook takes it
 *   msteams     a message with an Adaptive Card attachment, as a Teams
 *               incoming webhook or a Workflows "webhook request" trigger takes it
 *   discord, googlechat, rocketchat, webex, zulip
 *               that service's incoming webhook body (chat-posts.ts)
 *
 * A webhook with no format (null) keeps the original rule (Slack blocks for a
 * hooks.slack.com URL), and otherwise gets the format of a URL only one chat
 * service uses (`detectChatFormat`, @optio/shared), else the generic JSON.
 * Links point at PUBLIC_URL: a Task at /work/:id, a Job run at
 * /jobs/:job/runs/:run.
 */

export type WebhookFormat = KnownWebhookFormat;

/** `generic`, then the chat formats alphabetically. */
export const WEBHOOK_FORMATS: readonly WebhookFormat[] = WEBHOOK_FORMAT_IDS;

export const isWebhookFormat = isKnownWebhookFormat;

type Data = Record<string, unknown>;
type SlackBuilder = (event: never, data: Data) => Record<string, unknown>;

/** What a chat message says about one event, whatever the format. */
export interface ChatSummary {
  /** `Merge request opened`, `Job run failed`, … */
  headline: string;
  tone: "good" | "warning" | "attention" | "neutral";
  /** The Task's title or the Job's name. */
  name: string;
  /** Optio's page about it, when PUBLIC_URL is set. */
  link: string | null;
  facts: Array<[string, string]>;
  prUrl: string | null;
  error: string | null;
}

const HEADLINES: Record<string, { text: string; tone: ChatSummary["tone"]; emoji: string }> = {
  "task.completed": { text: "Task completed", tone: "good", emoji: ":white_check_mark:" },
  "task.failed": { text: "Task failed", tone: "attention", emoji: ":x:" },
  "task.needs_attention": { text: "Task needs attention", tone: "warning", emoji: ":warning:" },
  "task.pr_opened": { text: "Merge request opened", tone: "neutral", emoji: ":rocket:" },
  "review.completed": { text: "Review completed", tone: "good", emoji: ":mag:" },
  "workflow_run.queued": {
    text: "Job run queued",
    tone: "neutral",
    emoji: ":hourglass_flowing_sand:",
  },
  "workflow_run.started": { text: "Job run started", tone: "neutral", emoji: ":arrow_forward:" },
  "workflow_run.completed": {
    text: "Job run completed",
    tone: "good",
    emoji: ":white_check_mark:",
  },
  "workflow_run.failed": { text: "Job run failed", tone: "attention", emoji: ":x:" },
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The parts every chat format shows, from the event's data (task or Job run). */
export function summarize(event: string, data: Data, base = publicWebUrl()): ChatSummary {
  const head = HEADLINES[event] ?? { text: event, tone: "neutral" as const, emoji: "" };
  const facts: Array<[string, string]> = [];
  let name: string;
  let path: string | null = null;
  if (event.startsWith("workflow_run.")) {
    name = str(data.workflowName) ?? "Job";
    const runId = str(data.runId);
    const workId = str(data.workflowId);
    if (runId && workId) path = workPath({ id: runId, kind: "standalone", workId });
    if (str(data.modelUsed)) facts.push(["Model", str(data.modelUsed)!]);
    const cost = Number(data.costUsd);
    if (data.costUsd != null && Number.isFinite(cost)) facts.push(["Cost", `$${cost.toFixed(2)}`]);
    if (typeof data.durationMs === "number") {
      facts.push(["Duration", `${Math.round(data.durationMs / 1000)}s`]);
    }
  } else {
    name = str(data.taskTitle) ?? "Task";
    const taskId = str(data.taskId);
    if (taskId) path = workPath({ id: taskId, kind: "repo" });
    const repo = repoName(str(data.repoUrl));
    if (repo) facts.push(["Repository", repo]);
    if (str(data.repoBranch)) facts.push(["Branch", str(data.repoBranch)!]);
  }
  // Only the first line: stderr and tool output that follow it stay in Optio.
  const error = str(str(data.errorMessage)?.split(/\r?\n/, 1)[0]);
  return {
    headline: head.text,
    tone: head.tone,
    name,
    link: base && path ? `${base}${path}` : null,
    facts,
    prUrl: str(data.prUrl),
    error: error ? (error.length > 500 ? `${error.slice(0, 499)}…` : error) : null,
  };
}

/**
 * The same summary as a chat post (chat-posts.ts): the headline, the name
 * linked to Optio, the facts, the merge request and the error.
 */
export function workPost(event: string, data: Data, base = publicWebUrl()): ChatPost {
  const s = summarize(event, data, base);
  return {
    title: s.headline,
    tone: s.tone,
    name: s.name,
    link: s.link,
    facts: s.facts,
    prUrl: s.prUrl,
    error: s.error,
  };
}

/** Mattermost: `{ text }` in Markdown (headline, linked name, facts, error). */
export function mattermostBody(
  event: string,
  data: Data,
  base = publicWebUrl(),
): Record<string, unknown> {
  const s = summarize(event, data, base);
  const emoji = HEADLINES[event]?.emoji;
  const lines = [
    `#### ${emoji ? `${emoji} ` : ""}${mdText(s.headline)}`,
    s.link ? `**[${mdText(s.name)}](${s.link})**` : `**${mdText(s.name)}**`,
  ];
  const facts = [...s.facts.map(([k, v]) => `${k}: ${mdText(v)}`)];
  if (s.prUrl) facts.push(`Merge request: ${mdUrl(s.prUrl)}`);
  if (facts.length) lines.push(facts.join(" · "));
  // Inside the fence Markdown is shown as written; only the fence and mentions need care.
  if (s.error) lines.push("```", noMentions(s.error.replace(/```/g, "'''")), "```");
  return { text: lines.join("\n") };
}

const TEAMS_COLOR: Record<ChatSummary["tone"], string> = {
  good: "Good",
  warning: "Warning",
  attention: "Attention",
  neutral: "Default",
};

/** Microsoft Teams: a message carrying one Adaptive Card (1.4). */
export function teamsBody(
  event: string,
  data: Data,
  base = publicWebUrl(),
): Record<string, unknown> {
  const s = summarize(event, data, base);
  const body: Record<string, unknown>[] = [
    {
      type: "TextBlock",
      text: s.headline,
      weight: "Bolder",
      size: "Medium",
      color: TEAMS_COLOR[s.tone],
      wrap: true,
    },
    { type: "TextBlock", text: teamsText(s.name), wrap: true },
  ];
  const facts = [...s.facts];
  if (s.prUrl) facts.push(["Merge request", s.prUrl]);
  if (facts.length) {
    body.push({
      type: "FactSet",
      facts: facts.map(([title, value]) => ({ title, value: teamsText(value) })),
    });
  }
  if (s.error) {
    body.push({
      type: "TextBlock",
      text: teamsText(s.error),
      wrap: true,
      fontType: "Monospace",
      isSubtle: true,
    });
  }
  const actions: Record<string, unknown>[] = [];
  if (s.link) actions.push({ type: "Action.OpenUrl", title: "Open in Optio", url: s.link });
  if (s.prUrl)
    actions.push({ type: "Action.OpenUrl", title: "Open the merge request", url: s.prUrl });
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body,
          ...(actions.length ? { actions } : {}),
        },
      },
    ],
  };
}

/**
 * The body for a webhook of `format`, or null to keep the original rule
 * (format unset or unknown). `slack` is webhook-service.ts's own builder, passed in.
 * (`slack` here is that builder; chat-posts.ts's Slack body is for a
 * person's own hook.)
 */
export function renderWebhookBody(
  format: string | null | undefined,
  event: string,
  data: Data,
  slack: SlackBuilder,
): Record<string, unknown> | null {
  switch (format) {
    case "generic":
      return { event, timestamp: new Date().toISOString(), data };
    case "slack":
      return slack(event as never, data);
    case "mattermost":
      return mattermostBody(event, data);
    case "msteams":
      return teamsBody(event, data);
    default:
      return isPostFormat(format) ? renderPost(format, workPost(event, data)) : null;
  }
}
