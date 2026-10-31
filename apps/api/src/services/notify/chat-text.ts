/*
 * What the event's data says — a Task's title (often a Jira or GitLab
 * issue's), its branch, the error — is anyone's text. A chat format shows it
 * as written, never as formatting, a disguised link or a mention. These are
 * the ways each chat's markup is kept from reading it (chat-formats.ts,
 * chat-posts.ts, chat-messages.ts).
 */

export const ZWSP = "\u200B";

/** No pings: "@channel", "@all", "@here" or "@someone" mention nobody. */
export const noMentions = (s: string) => s.replace(/@/g, `@${ZWSP}`);

/**
 * Anyone's text in Markdown (Discord, Mattermost, Webex, Zulip): one line,
 * its Markdown characters escaped (emphasis, code, links, headings, quotes,
 * tables, strike-through, channel links), and no mentions.
 */
export function mdText(s: string): string {
  return noMentions(s.replace(/\s*[\r\n]+\s*/g, " ").replace(/[\\`*_{}[\]()#>|~<]/g, "\\$&"));
}

/** Anyone's multi-line text as Markdown: each line escaped, the breaks kept. */
export function mdLines(s: string): string {
  return s
    .split(/\r?\n/)
    .map((line) => (line.trim() ? mdText(line) : ""))
    .join("\n");
}

/** A merge request's address, linked as itself when it is a plain http(s) URL. */
export const mdUrl = (url: string) =>
  /^https?:\/\/[^\s<>()[\]`*@\\]+$/.test(url) ? url : mdText(url);

/** Anyone's text in a Markdown code block: shown as written; only the fence and mentions need care. */
export const mdFence = (s: string) =>
  ["```", noMentions(s.replace(/```/g, "'''")), "```"].join("\n");

/**
 * Anyone's text in an Adaptive Card's TextBlock or FactSet, whose Markdown
 * subset has links: "[text](url)" stays text. (A Teams mention needs an
 * entity the card doesn't carry, so "@" is harmless there.)
 */
export const teamsText = (s: string) => s.replace(/\]\s*\(/g, `]${ZWSP}(`);

/** A plain http(s) URL, or null (so a link never carries Markdown or a script). */
export function safeUrl(url: string | null | undefined): string | null {
  return url && /^https?:\/\/[^\s<>()[\]`*\\]+$/.test(url) ? url : null;
}

/**
 * Anyone's text in Google Chat card text, which takes a few HTML tags
 * (`<b>`, `<a href>`, `<font>`, `<br>`): every tag character escaped, the
 * line breaks kept as `<br>`.
 */
export function htmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\r?\n/g, "<br>");
}

/**
 * Anyone's text in Slack mrkdwn: `&`, `<` and `>` escaped, as Slack asks, so
 * nothing in it becomes a link or a mention (`<!channel>`, `<@U…>`).
 */
export const slackText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Anyone's text in a Rocket.Chat message or attachment: one line, no
 * mentions, and neither `[text](url)` nor `<url|text>` forms a link.
 */
export const rocketText = (s: string) =>
  noMentions(s.replace(/\s*[\r\n]+\s*/g, " "))
    .replace(/\]\s*\(/g, `]${ZWSP}(`)
    .replace(/</g, `<${ZWSP}`);

/** The first `n` UTF-16 units of `s`, never half a surrogate pair. */
function head(s: string, n: number): string {
  const out = s.slice(0, Math.max(0, n));
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
}

/** `s` cut to `max` characters, ending in "…" when cut. */
export function clip(s: string, max: number): string {
  return s.length > max ? `${head(s, max - 1)}…` : s;
}

/** `s` cut to at most `max` UTF-8 bytes, ending in "…" when cut. */
export function clipBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  let out = head(s, max);
  while (out && Buffer.byteLength(`${out}…`) > max) out = head(out, out.length - 1);
  return `${out}…`;
}
