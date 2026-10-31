import { CHAT_FORMAT_IDS, isChatFormat, type ChatFormat } from "@optio/shared";
import { mattermostBody, mdText, teamsBody, teamsText, workPost } from "./chat-formats.js";
import { isPostFormat, renderPost, type ChatPost } from "./chat-posts.js";
import { mdLines, safeUrl } from "./chat-text.js";
import { absoluteLink, publicWebUrl, type WorkSummary } from "./templates.js";

/**
 * What Optio posts to a person's own chat hook
 * (docs/notifications.md "Your own chat hook"), kept as
 * data until it is sent, then shaped for the hook's format at that moment
 * (a hook changed from Mattermost to Teams meanwhile gets a card):
 *
 *   work    a work event — the same bodies as an outbound webhook of that
 *           format (chat-formats.ts), from the work's summary
 *   notice  what `notify()` says (someone who left, a held directory sync)
 *   test    "Optio can post here"
 *
 * Anyone's text in it (a Task's title, a person's name) is shown as written:
 * escaped for Markdown, links disarmed in a Teams card, HTML-escaped in a
 * Google Chat card (chat-text.ts).
 *
 * A hook's format is any chat service's (@optio/shared `CHAT_SERVICES`):
 * Mattermost and Teams have their builders here, the others chat-posts.ts.
 */

export type ChatHookFormat = ChatFormat;

/** The chat formats, alphabetically by the service's name. */
export const CHAT_HOOK_FORMATS: readonly ChatHookFormat[] = CHAT_FORMAT_IDS;

export function isChatHookFormat(v: unknown): v is ChatHookFormat {
  return isChatFormat(v);
}

export type ChatMessage =
  | { type: "work"; event: string; data: Record<string, unknown> }
  | { type: "notice"; subject: string; body: string; link?: string | null }
  | { type: "test"; sentBy: string | null; where: string };

/**
 * The first line of a failure, as the email gives it (templates.ts): agent
 * stderr and later tool output never reach a chat post or the outbox.
 */
function failureLine(kind: string, work: WorkSummary): string | null {
  if (kind !== "task.failed" && kind !== "task.needs_attention") return null;
  const first = work.errorMessage?.trim().split(/\r?\n/, 1)[0]?.trim();
  return first || null;
}

/** A work event as chat-formats.ts reads an outbound webhook's data. */
export function workChatMessage(kind: string, work: WorkSummary): ChatMessage {
  const errorMessage = failureLine(kind, work);
  if (work.kind === "standalone") {
    // A Job run is news only when it failed (dispatch.ts).
    const event = kind === "task.failed" ? "workflow_run.failed" : kind;
    return {
      type: "work",
      event,
      data: {
        runId: work.id,
        workflowId: work.workId ?? null,
        workflowName: work.title || "Job",
        errorMessage,
      },
    };
  }
  return {
    type: "work",
    event: kind,
    data: {
      taskId: work.id,
      taskTitle: work.title || "Task",
      repoUrl: work.repoUrl ?? null,
      prUrl: work.prUrl ?? null,
      errorMessage,
    },
  };
}

/** One line naming the message (the outbox's summary, a log line). */
export function chatMessageSummary(msg: ChatMessage): string {
  switch (msg.type) {
    case "work": {
      const name = msg.data.taskTitle ?? msg.data.workflowName ?? "";
      return `${msg.event}: ${String(name)}`.slice(0, 300);
    }
    case "notice":
      return msg.subject.slice(0, 300);
    case "test":
      return "Test message";
  }
}

function mattermost(msg: ChatMessage, base: string | null): Record<string, unknown> {
  switch (msg.type) {
    case "work":
      return mattermostBody(msg.event, msg.data, base);
    case "notice": {
      const link = safeUrl(absoluteLink(msg.link, base));
      const lines = [`#### ${mdText(msg.subject)}`, mdLines(msg.body.trim())];
      if (link) lines.push(`[Open in Optio](${link})`);
      return { text: lines.join("\n") };
    }
    case "test":
      return {
        text: `#### Optio can post here\nThis is a test message for ${mdText(msg.where)}${
          msg.sentBy ? `, sent by ${mdText(msg.sentBy)}` : ""
        }.`,
      };
  }
}

function card(body: Record<string, unknown>[], actions: Record<string, unknown>[]) {
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

const heading = (text: string) => ({
  type: "TextBlock",
  text: teamsText(text),
  weight: "Bolder",
  size: "Medium",
  wrap: true,
});

const openAction = (url: string | null, title = "Open in Optio") =>
  url ? [{ type: "Action.OpenUrl", title, url }] : [];

function teams(msg: ChatMessage, base: string | null): Record<string, unknown> {
  switch (msg.type) {
    case "work":
      return teamsBody(msg.event, msg.data, base);
    case "notice":
      return card(
        [heading(msg.subject), { type: "TextBlock", text: teamsText(msg.body.trim()), wrap: true }],
        openAction(safeUrl(absoluteLink(msg.link, base))),
      );
    case "test":
      return card(
        [
          heading("Optio can post here"),
          {
            type: "TextBlock",
            text: teamsText(
              `This is a test message for ${msg.where}${msg.sentBy ? `, sent by ${msg.sentBy}` : ""}.`,
            ),
            wrap: true,
          },
        ],
        [],
      );
  }
}

/** The message in neutral parts, for the formats chat-posts.ts shapes. */
export function chatPost(msg: ChatMessage, base: string | null = publicWebUrl()): ChatPost {
  switch (msg.type) {
    case "work":
      return workPost(msg.event, msg.data, base);
    case "notice": {
      const link = safeUrl(absoluteLink(msg.link, base));
      return {
        title: msg.subject,
        tone: "neutral",
        text: msg.body.trim(),
        actions: link ? [{ title: "Open in Optio", url: link }] : [],
      };
    }
    case "test":
      return {
        title: "Optio can post here",
        tone: "good",
        text: `This is a test message for ${msg.where}${msg.sentBy ? `, sent by ${msg.sentBy}` : ""}.`,
      };
  }
}

/**
 * The body to POST to a hook of `format`: Mattermost's and Teams' are built
 * here, the other services' in chat-posts.ts.
 */
export function renderChat(
  format: ChatHookFormat,
  msg: ChatMessage,
  base: string | null = publicWebUrl(),
): Record<string, unknown> {
  if (format === "msteams") return teams(msg, base);
  if (isPostFormat(format)) return renderPost(format, chatPost(msg, base));
  return mattermost(msg, base);
}
