import type { ChatFormat } from "@optio/shared";
import {
  clip,
  clipBytes,
  htmlText,
  mdFence,
  mdLines,
  mdText,
  mdUrl,
  rocketText,
  safeUrl,
  slackText,
} from "./chat-text.js";

/**
 * One chat message in neutral parts, and its body for each chat service an
 * incoming webhook takes (docs/notifications.md "Chat services"):
 *
 *   discord     { embeds: [one embed], allowed_mentions: { parse: [] } }
 *   googlechat  { cardsV2: [one card] }  (header, widgets, link buttons)
 *   rocketchat  { text, attachments }    (title links, fields, colour)
 *   slack       { text, blocks }         (a person's own hook; an
 *                                         outbound webhook keeps its own)
 *   webex       { markdown }
 *   zulip       { text }                 (Zulip's Slack-compatible webhook)
 *
 * Mattermost and Microsoft Teams keep their own builders (chat-formats.ts,
 * chat-messages.ts). Every string in a post but the fact labels and action
 * titles may be anyone's text; each format shows it as written
 * (chat-text.ts). Every URL in `link` and `actions` is a plain
 * http(s) URL (`safeUrl`) or null.
 */

export type ChatTone = "good" | "warning" | "attention" | "neutral";

export interface ChatPost {
  /** The first line: `Task failed`, a notice's subject. */
  title: string;
  tone: ChatTone;
  /** The work it is about … */
  name?: string | null;
  /** … and its page in Optio. */
  link?: string | null;
  /** Free text (a notice's body); its line breaks are kept. */
  text?: string | null;
  facts?: Array<[string, string]>;
  /** The merge request: linked when it is a plain URL, text otherwise. */
  prUrl?: string | null;
  /** Shown monospaced. */
  error?: string | null;
  /** Links after everything else (`Open in Optio`). */
  actions?: Array<{ title: string; url: string }>;
}

/** The formats this module shapes (the rest have their own builders). */
export type PostFormat = Extract<
  ChatFormat,
  "discord" | "googlechat" | "rocketchat" | "slack" | "webex" | "zulip"
>;

export const POST_FORMATS: readonly PostFormat[] = [
  "discord",
  "googlechat",
  "rocketchat",
  "slack",
  "webex",
  "zulip",
];

export function isPostFormat(v: unknown): v is PostFormat {
  return typeof v === "string" && (POST_FORMATS as readonly string[]).includes(v);
}

/** The body to POST to an incoming webhook of `format`. */
export function renderPost(format: PostFormat, post: ChatPost): Record<string, unknown> {
  switch (format) {
    case "discord":
      return discordPost(post);
    case "googlechat":
      return googleChatPost(post);
    case "rocketchat":
      return rocketChatPost(post);
    case "slack":
      return slackPost(post);
    case "webex":
      return webexPost(post);
    case "zulip":
      return zulipPost(post);
  }
}

// ── Shared pieces ───────────────────────────────────────────────────────────

/** The actions not already linked from the work's name. */
const extraActions = (p: ChatPost) => (p.actions ?? []).filter((a) => a.url !== p.link);

/** A Markdown message (Webex, Zulip): headline, linked name, facts, text, error, links. */
function markdownLines(p: ChatPost, error: (e: string) => string): string[] {
  const lines = [`**${mdText(p.title)}**`];
  if (p.name) lines.push(p.link ? `**[${mdText(p.name)}](${p.link})**` : `**${mdText(p.name)}**`);
  const facts = (p.facts ?? []).map(([k, v]) => `${k}: ${mdText(v)}`);
  if (p.prUrl) facts.push(`Merge request: ${mdUrl(p.prUrl)}`);
  if (facts.length) lines.push(facts.join(" · "));
  if (p.text?.trim()) lines.push(mdLines(p.text.trim()));
  if (p.error) lines.push(error(p.error));
  const links = extraActions(p).map((a) => `[${a.title}](${a.url})`);
  if (links.length) lines.push("", links.join(" · "));
  return lines;
}

// ── Discord ─────────────────────────────────────────────────────────────────

const DISCORD_COLOR: Record<ChatTone, number> = {
  good: 0x2eb67d,
  warning: 0xe8a33d,
  attention: 0xd83a3a,
  neutral: 0x8a8f98,
};

/** Discord's embed limits (characters). */
const DISCORD = { title: 256, description: 4096, fields: 25, name: 256, value: 1024, total: 6000 };

/**
 * Discord: one embed (title linked to the work, the name, facts as inline
 * fields, the error in a code block), and
 * `allowed_mentions: { parse: [] }` so nothing in it pings anyone. Anyone's
 * text is escaped for Markdown (chat-text.ts `mdText`).
 */
export function discordPost(p: ChatPost): Record<string, unknown> {
  const description: string[] = [];
  if (p.name) {
    description.push(p.link ? `**[${mdText(p.name)}](${p.link})**` : `**${mdText(p.name)}**`);
  }
  if (p.text?.trim()) description.push(mdLines(p.text.trim()));
  if (p.error) description.push(mdFence(p.error));
  const links = extraActions(p).map((a) => `[${a.title}](${a.url})`);
  if (links.length) description.push(links.join(" · "));

  const fields: Array<{ name: string; value: string; inline: boolean }> = [];
  for (const [k, v] of p.facts ?? []) {
    fields.push({ name: k, value: clip(mdText(v), DISCORD.value), inline: true });
  }
  if (p.prUrl) {
    fields.push({
      name: "Merge request",
      value: clip(mdUrl(p.prUrl), DISCORD.value),
      inline: false,
    });
  }

  const title = clip(p.title, DISCORD.title);
  // At most 25 fields, and only as many as fit in the embed's 6000 characters.
  const kept: typeof fields = [];
  let fieldChars = 0;
  for (const f of fields.slice(0, DISCORD.fields)) {
    const size = f.name.length + f.value.length;
    if (title.length + fieldChars + size > DISCORD.total) break;
    kept.push(f);
    fieldChars += size;
  }
  // The whole embed stays within 6000 characters: the description gives way.
  const room = Math.max(0, DISCORD.total - title.length - fieldChars);
  const text = clip(description.join("\n"), Math.min(DISCORD.description, room));
  const url = p.link ?? extraActions(p)[0]?.url ?? null;
  return {
    embeds: [
      {
        title,
        ...(url ? { url } : {}),
        ...(text ? { description: text } : {}),
        color: DISCORD_COLOR[p.tone],
        ...(kept.length ? { fields: kept } : {}),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

// ── Google Chat ─────────────────────────────────────────────────────────────

/** A link in card text (`<a href>`), the URL escaped for the attribute. */
const htmlLink = (url: string, text: string) => `<a href="${htmlText(url)}">${text}</a>`;

/**
 * Google Chat: a message with one card (`cardsV2`): the title and the
 * work's name in the header (plain text there), facts as decorated text,
 * the error, and buttons that open Optio and the merge
 * request. Card text takes a few HTML tags, so anyone's text is
 * HTML-escaped.
 */
export function googleChatPost(p: ChatPost): Record<string, unknown> {
  const widgets: Record<string, unknown>[] = [];
  if (p.text?.trim())
    widgets.push({ textParagraph: { text: htmlText(clip(p.text.trim(), 4000)) } });
  for (const [k, v] of p.facts ?? []) {
    widgets.push({ decoratedText: { topLabel: k, text: htmlText(v) } });
  }
  const pr = p.prUrl ? safeUrl(p.prUrl) : null;
  if (p.prUrl) {
    widgets.push({
      decoratedText: {
        topLabel: "Merge request",
        text: pr ? htmlLink(pr, htmlText(pr)) : htmlText(p.prUrl),
      },
    });
  }
  if (p.error) {
    widgets.push({ textParagraph: { text: `<font color="#b3261e">${htmlText(p.error)}</font>` } });
  }
  // The header can't link, so the work and its merge request are buttons.
  const buttons = [
    ...(p.link ? [{ title: "Open in Optio", url: p.link }] : []),
    ...(pr ? [{ title: "Open the merge request", url: pr }] : []),
    ...extraActions(p),
  ].map((a) => ({ text: a.title, onClick: { openLink: { url: a.url } } }));
  if (buttons.length) widgets.push({ buttonList: { buttons } });

  // A card has at least one section with a widget.
  const sections = [
    { widgets: widgets.length ? widgets : [{ textParagraph: { text: htmlText(p.title) } }] },
  ];
  return {
    cardsV2: [
      {
        cardId: "optio-notification",
        card: {
          header: {
            title: clip(p.title, 200),
            ...(p.name ? { subtitle: clip(p.name, 200) } : {}),
          },
          sections,
        },
      },
    ],
  };
}

// ── Rocket.Chat ─────────────────────────────────────────────────────────────

const ROCKET_COLOR: Record<ChatTone, string> = {
  good: "#2eb67d",
  warning: "#e8a33d",
  attention: "#d83a3a",
  neutral: "#8a8f98",
};

/**
 * Rocket.Chat: `{ text, attachments }`: the title as the message, then an
 * attachment with the work's name linked to Optio, its facts as fields,
 * and the error. Mentions and links in
 * anyone's text are disarmed (`rocketText`).
 */
export function rocketChatPost(p: ChatPost): Record<string, unknown> {
  const color = ROCKET_COLOR[p.tone];
  const main: Record<string, unknown> = { color };
  if (p.name) {
    main.title = clip(p.name.replace(/\s*[\r\n]+\s*/g, " "), 500);
    if (p.link) main.title_link = p.link;
  }
  const text: string[] = [];
  if (p.text?.trim()) text.push(p.text.trim().split(/\r?\n/).map(rocketText).join("\n"));
  if (p.error) text.push(mdFence(p.error));
  const links = extraActions(p)
    .map((a) => `[${a.title}](${a.url})`)
    .join(" · ");
  if (links) text.push(links);
  if (text.length) main.text = text.join("\n");
  const fields = (p.facts ?? []).map(([title, value]) => ({
    short: true,
    title,
    value: rocketText(value),
  }));
  if (p.prUrl) {
    const pr = safeUrl(p.prUrl);
    fields.push({ short: false, title: "Merge request", value: pr ?? rocketText(p.prUrl) });
  }
  if (fields.length) main.fields = fields;

  const attachments: Record<string, unknown>[] = [];
  if (Object.keys(main).length > 1) attachments.push(main);
  return {
    text: `*${rocketText(p.title)}*`,
    ...(attachments.length ? { attachments } : {}),
  };
}

// ── Slack ───────────────────────────────────────────────────────────────────

/** `<url|text>`: only for a URL Slack's link syntax can't misread. */
const slackLink = (url: string, text: string) => (/[|<>]/.test(url) ? text : `<${url}|${text}>`);

/**
 * Slack, for a person's own hook: `{ text, blocks }` — a header,
 * the work's name linked, its facts as fields, the error,
 * links. Anyone's text is escaped as Slack asks (`&`, `<`, `>`), so it
 * never links or mentions. (An outbound webhook of format `slack` keeps
 * webhook-service.ts's own blocks.)
 */
export function slackPost(p: ChatPost): Record<string, unknown> {
  const mrkdwn = (text: string) => ({
    type: "section",
    text: { type: "mrkdwn", text: clip(text, 3000) },
  });
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: clip(p.title, 150), emoji: false } },
  ];
  if (p.name) {
    const name = slackText(p.name);
    blocks.push(mrkdwn(`*${p.link ? slackLink(p.link, name) : name}*`));
  }
  if (p.text?.trim()) blocks.push(mrkdwn(slackText(p.text.trim())));
  const fields = (p.facts ?? []).map(([k, v]) => ({
    type: "mrkdwn",
    text: clip(`*${k}:*\n${slackText(v)}`, 2000),
  }));
  if (p.prUrl) {
    const pr = safeUrl(p.prUrl);
    fields.push({
      type: "mrkdwn",
      text: clip(
        `*Merge request:*\n${pr ? slackLink(pr, slackText(pr)) : slackText(p.prUrl)}`,
        2000,
      ),
    });
  }
  if (fields.length) blocks.push({ type: "section", fields: fields.slice(0, 10) });
  if (p.error) blocks.push(mrkdwn(`\`\`\`${slackText(clip(p.error, 2900))}\`\`\``));
  const links = extraActions(p).map((a) => slackLink(a.url, a.title));
  if (links.length) blocks.push(mrkdwn(links.join(" · ")));
  return {
    text: clip(slackText(p.name ? `${p.title}: ${p.name}` : p.title), 3000),
    blocks,
  };
}

// ── Webex ───────────────────────────────────────────────────────────────────

/**
 * A Webex message's limits: 5,400 characters a post (the Webex app's), and
 * 7,439 bytes of `markdown` (the Messages API's).
 */
const WEBEX_MAX_CHARS = 5400;
const WEBEX_MAX_BYTES = 7439;

/** Webex: `{ markdown }`: Markdown, with anyone's text escaped (chat-text.ts `mdText`). */
export function webexPost(p: ChatPost): Record<string, unknown> {
  const markdown = clip(markdownLines(p, mdFence).join("\n"), WEBEX_MAX_CHARS);
  return { markdown: clipBytes(markdown, WEBEX_MAX_BYTES) };
}

// ── Zulip ───────────────────────────────────────────────────────────────────

/** A Zulip message's limit (characters). */
const ZULIP_MAX = 10_000;

/**
 * Zulip, through its Slack-compatible incoming webhook
 * (`/api/v1/external/slack_incoming`): `{ text }` in Zulip's Markdown.
 * Zulip turns Slack's `*bold*`, `_italic_`, `~strike~` and `<url|text>` in
 * it into its own; escaped characters (`\*`) are left alone, so anyone's
 * text stays as written. The error is one escaped line rather than a code
 * block, which that conversion would reach into.
 */
export function zulipPost(p: ChatPost): Record<string, unknown> {
  const error = (e: string) => `Error: ${mdText(e)}`;
  return { text: clip(markdownLines(p, error).join("\n"), ZULIP_MAX) };
}
