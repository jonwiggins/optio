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
 *   slack       { text, blocks }         (a person's or a team's hook; an
 *                                         outbound webhook keeps its own)
 *   webex       { markdown }
 *   zulip       { text }                 (Zulip's Slack-compatible webhook)
 *
 * Mattermost and Microsoft Teams keep their own builders (chat-formats.ts,
 * chat-messages.ts). Every string in a post but the fact labels and action
 * titles may be anyone's text; each format shows it as written
 * (chat-text.ts). Every URL in `link`, `actions` and section items is a plain
 * http(s) URL (`safeUrl`) or null.
 */

export type ChatTone = "good" | "warning" | "attention" | "neutral";

export interface ChatPostItem {
  name: string;
  link: string | null;
  detail?: string | null;
}

export interface ChatPostSection {
  title: string;
  items: ChatPostItem[];
  /** How many more there were than listed. */
  more: number;
}

export interface ChatPost {
  /** The first line: `Task failed`, a notice's subject, the digest's title. */
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
  sections?: ChatPostSection[];
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

/**
 * A section's lines, as many as fit in `budget` characters, then
 * "and N more" (what didn't fit is counted with what wasn't listed).
 */
function sectionLines(
  s: ChatPostSection,
  line: (item: ChatPostItem) => string,
  budget: number,
  more: (n: number) => string,
): string[] {
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const item of s.items) {
    const l = line(item);
    // Room for this line and an "and N more" after it.
    if (used + l.length + 1 > budget - 40) break;
    lines.push(l);
    used += l.length + 1;
    shown++;
  }
  const rest = s.items.length - shown + s.more;
  if (rest > 0) lines.push(more(rest));
  return lines;
}

const count = (s: ChatPostSection) => s.items.length + s.more;

/** `[name](link)` in Markdown, with the name's brackets dropped so it can't close the link early. */
const mdItem = (item: ChatPostItem, text: (s: string) => string = mdText) => {
  const detail = item.detail ? ` · ${text(item.detail)}` : "";
  return item.link
    ? `- [${text(item.name).replace(/\\?[[\]]/g, "")}](${item.link})${detail}`
    : `- ${text(item.name)}${detail}`;
};

/** A Markdown message (Webex, Zulip): headline, linked name, facts, text, error, sections, links. */
function markdownLines(p: ChatPost, error: (e: string) => string): string[] {
  const lines = [`**${mdText(p.title)}**`];
  if (p.name) lines.push(p.link ? `**[${mdText(p.name)}](${p.link})**` : `**${mdText(p.name)}**`);
  const facts = (p.facts ?? []).map(([k, v]) => `${k}: ${mdText(v)}`);
  if (p.prUrl) facts.push(`Merge request: ${mdUrl(p.prUrl)}`);
  if (facts.length) lines.push(facts.join(" · "));
  if (p.text?.trim()) lines.push(mdLines(p.text.trim()));
  if (p.error) lines.push(error(p.error));
  for (const s of p.sections ?? []) {
    lines.push("", `**${mdText(s.title)}** (${count(s)})`);
    lines.push(
      ...sectionLines(
        s,
        (i) => mdItem(i),
        2000,
        (n) => `- and ${n} more`,
      ),
    );
  }
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
 * fields, the error in a code block, digest sections as fields), and
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
  for (const s of p.sections ?? []) {
    fields.push({
      name: clip(`${s.title} (${count(s)})`, DISCORD.name),
      value: sectionLines(
        s,
        (i) => mdItem(i),
        DISCORD.value,
        (n) => `- and ${n} more`,
      ).join("\n"),
      inline: false,
    });
  }

  const title = clip(p.title, DISCORD.title);
  const kept = fields.slice(0, DISCORD.fields);
  const fieldChars = kept.reduce((n, f) => n + f.name.length + f.value.length, 0);
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

/** A Google Chat message's limit, text and cards included (bytes). */
const GOOGLE_CHAT_MAX_BYTES = 32_000;

/** A link in card text (`<a href>`), the URL escaped for the attribute. */
const htmlLink = (url: string, text: string) => `<a href="${htmlText(url)}">${text}</a>`;

/**
 * Google Chat: a message with one card (`cardsV2`): the title and the
 * work's name in the header (plain text there), facts as decorated text,
 * the error, digest sections, and buttons that open Optio and the merge
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

  const card = (budget: number) => {
    const sections: Record<string, unknown>[] = [];
    if (widgets.length) sections.push({ widgets });
    for (const s of p.sections ?? []) {
      const lines = sectionLines(
        s,
        (i) => {
          const name = htmlText(i.name);
          const detail = i.detail ? ` · ${htmlText(i.detail)}` : "";
          return `${i.link ? htmlLink(i.link, name) : name}${detail}`;
        },
        budget,
        (n) => `and ${n} more`,
      );
      sections.push({
        header: htmlText(`${s.title} (${count(s)})`),
        widgets: [{ textParagraph: { text: lines.join("<br>") } }],
      });
    }
    // A card has at least one section with a widget.
    if (!sections.length) {
      sections.push({ widgets: [{ textParagraph: { text: htmlText(p.title) } }] });
    }
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
  };
  // A message is at most 32,000 bytes: a long digest lists fewer lines.
  let budget = 6000;
  let body = card(budget);
  while (Buffer.byteLength(JSON.stringify(body)) > GOOGLE_CHAT_MAX_BYTES && budget > 200) {
    budget = Math.floor(budget / 2);
    body = card(budget);
  }
  return body;
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
 * the error, and one attachment per digest section. Mentions and links in
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
  const sections = p.sections ?? [];
  // The links come last: after the digest's sections when it has some.
  if (links && !sections.length) text.push(links);
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
  for (const s of sections) {
    attachments.push({
      color,
      title: `${s.title} (${count(s)})`,
      text: sectionLines(
        s,
        (i) => mdItem(i, rocketText),
        3000,
        (n) => `- and ${n} more`,
      ).join("\n"),
    });
  }
  if (links && sections.length) attachments.push({ color, text: links });
  return {
    text: `*${rocketText(p.title)}*`,
    ...(attachments.length ? { attachments } : {}),
  };
}

// ── Slack ───────────────────────────────────────────────────────────────────

/** `<url|text>`: only for a URL Slack's link syntax can't misread. */
const slackLink = (url: string, text: string) => (/[|<>]/.test(url) ? text : `<${url}|${text}>`);

/**
 * Slack, for a person's or a team's hook: `{ text, blocks }` — a header,
 * the work's name linked, its facts as fields, the error, digest sections,
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
  for (const s of p.sections ?? []) {
    const lines = sectionLines(
      s,
      (i) => {
        const name = slackText(i.name);
        const detail = i.detail ? ` · ${slackText(i.detail)}` : "";
        return `• ${i.link ? slackLink(i.link, name) : name}${detail}`;
      },
      2800,
      (n) => `• and ${n} more`,
    );
    blocks.push(mrkdwn([`*${slackText(s.title)}* (${count(s)})`, ...lines].join("\n")));
  }
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
