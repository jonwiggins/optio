/**
 * The chat services Optio can post to through an incoming webhook, by the
 * `format` an outbound webhook (`webhooks.format`) or a person's or team's
 * chat hook (`notify_chat_hooks.format`) keeps (docs/notifications.md
 * "Chat services"). Listed alphabetically by name; the API shapes the body
 * for each in apps/api/src/services/notify/chat-formats.ts.
 */
export const CHAT_SERVICES = [
  { format: "discord", label: "Discord" },
  { format: "googlechat", label: "Google Chat" },
  { format: "mattermost", label: "Mattermost" },
  { format: "msteams", label: "Microsoft Teams" },
  { format: "rocketchat", label: "Rocket.Chat" },
  { format: "slack", label: "Slack" },
  { format: "webex", label: "Webex" },
  { format: "zulip", label: "Zulip" },
] as const;

/** A chat service's body format. */
export type ChatFormat = (typeof CHAT_SERVICES)[number]["format"];

export const CHAT_FORMAT_IDS: readonly ChatFormat[] = CHAT_SERVICES.map((s) => s.format);

/** An outbound webhook's body: Optio's own JSON (`generic`) or a chat service's. */
export type WebhookFormat = "generic" | ChatFormat;

export const WEBHOOK_FORMAT_IDS: readonly WebhookFormat[] = ["generic", ...CHAT_FORMAT_IDS];

export function isChatFormat(v: unknown): v is ChatFormat {
  return typeof v === "string" && (CHAT_FORMAT_IDS as readonly string[]).includes(v);
}

export function isWebhookFormat(v: unknown): v is WebhookFormat {
  return typeof v === "string" && (WEBHOOK_FORMAT_IDS as readonly string[]).includes(v);
}

/** "Rocket.Chat" for `rocketchat`; the value itself when it is no chat format. */
export function chatFormatLabel(format: string): string {
  return CHAT_SERVICES.find((s) => s.format === format)?.label ?? format;
}

/**
 * The chat format a webhook URL can only be, or null when its host and path
 * don't say (a self-hosted server, a proxy, a workflow that takes any JSON).
 * Only URLs that are one service's incoming webhook and nothing else count:
 *
 *   hooks.slack.com/…                                   slack
 *   discord.com/api/webhooks/<id>/<token>               discord  (not …/slack or …/github)
 *   chat.googleapis.com/v1/spaces/<space>/messages      googlechat
 *   webexapis.com/v1/webhooks/incoming/<id>             webex
 *   <tenant>.webhook.office.com/webhookb2/…             msteams  (an Office 365 connector)
 *   <name>.cloud.mattermost.com/hooks/<id>              mattermost
 *   <name>.rocket.chat/hooks/<id>/<token>               rocketchat
 *   …/api/v1/external/slack_incoming                    zulip    (any host: Zulip's own route)
 *
 * An explicit format always wins over this; it fills in when none is chosen.
 */
export function detectChatFormat(raw: string | null | undefined): ChatFormat | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const path = url.pathname;
  const under = (domain: string) => host === domain || host.endsWith(`.${domain}`);

  if (host === "hooks.slack.com") return "slack";
  if (
    (under("discord.com") || under("discordapp.com")) &&
    /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+\/?$/.test(path)
  ) {
    return "discord";
  }
  if (host === "chat.googleapis.com" && /^\/v1\/spaces\/[^/]+\/messages\/?$/.test(path)) {
    return "googlechat";
  }
  if (
    (host === "webexapis.com" || host === "api.ciscospark.com") &&
    /^\/v1\/webhooks\/incoming\/[^/]+\/?$/.test(path)
  ) {
    return "webex";
  }
  if (under("webhook.office.com") && path.startsWith("/webhookb2/")) return "msteams";
  if (under("cloud.mattermost.com") && /^\/hooks\/[^/]+\/?$/.test(path)) return "mattermost";
  if (under("rocket.chat") && /^\/hooks\/[^/]+\/[^/]+\/?$/.test(path)) return "rocketchat";
  if (/^\/api\/v1\/external\/slack_incoming\/?$/.test(path)) return "zulip";
  return null;
}
