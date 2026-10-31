/**
 * What a GitLab comment asks of Optio's GitLab user (docs/gitlab-bot.md).
 * Pure: the ingress (ingress.ts) and the handler (process.ts) call these.
 *
 *   @optio-bot add a line to the README          → work, "add a line to the README"
 *   @optio-bot help                               → what it can do
 *
 * A mention counts only in the comment's own words: not inside code (a
 * fenced block or `inline code`) and not in a quoted line (`> …`), so
 * quoting an earlier request, or showing the syntax in a code block, never
 * starts work a second time.
 */

export type MentionCommandKind = "work" | "help" | "empty";

export interface MentionCommand {
  kind: MentionCommandKind;
  /** The comment without the mention. */
  instruction: string;
}

/** The longest comment Optio keeps (and hands to an agent). */
export const MAX_NOTE_CHARS = 20_000;

/** A GitLab username as it appears after `@` (letters, digits, `_`, `.`, `-`). */
const USERNAME = /^[a-z0-9_][a-z0-9_.-]{0,254}$/i;

export function isGitLabUsername(v: string | null | undefined): v is string {
  return !!v && USERNAME.test(v);
}

/** The comment with code (fenced blocks, inline spans) and quoted lines blanked out. */
export function ownWords(text: string): string {
  return text
    .replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[^\n]*(?=\n|$)|$)/g, "$1")
    .replace(/`[^`\n]*`/g, " ")
    .split("\n")
    .map((line) => (/^\s*>/.test(line) ? "" : line))
    .join("\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `@username` as a whole mention: not part of an address or a longer name. */
function mentionRe(username: string, flags = "i"): RegExp {
  return new RegExp(`(^|[^\\w@/.-])@${escapeRe(username)}(?![\\w-]|\\.[\\w-])`, flags);
}

/** Whether the comment mentions `username` in its own words (case-insensitive). */
export function mentionsUser(text: string, username: string): boolean {
  if (!isGitLabUsername(username)) return false;
  return mentionRe(username).test(ownWords(text));
}

/** Whether the comment mentions anyone at all in its own words (the ingress's cheap test). */
export function mentionsAnyone(text: string): boolean {
  return /(^|[^\w@/.-])@[a-z0-9_]/i.test(ownWords(text));
}

const HELP = /^(?:help|\?|what can you do\??|commands)[\s.!?]*$/i;

/**
 * What the comment asks for. `username` is the bot's: every mention of it
 * goes, the rest of the comment is the instruction. A comment that is only
 * the mention is `empty` (on an issue: work from the issue itself).
 */
export function parseMentionCommand(text: string, username: string): MentionCommand {
  let rest = text.slice(0, MAX_NOTE_CHARS);
  if (isGitLabUsername(username)) rest = rest.replace(mentionRe(username, "gi"), "$1");
  const instruction = tidy(rest);
  if (!instruction) return { kind: "empty", instruction: "" };
  if (HELP.test(instruction)) return { kind: "help", instruction: "" };
  return { kind: "work", instruction };
}

/** Trimmed, without the comma or colon a mention leaves behind ("@optio-bot, please …"). */
function tidy(s: string): string {
  return s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?])/g, "$1")
    .trim()
    .replace(/^[,:;.!-]+\s*/, "")
    .trim();
}

/** The first line of an instruction, for a task's title. */
export function titleLine(s: string, max = 120): string {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  const clean = line.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
