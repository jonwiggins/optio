/**
 * Merge requests and commits that point back to the ticket, the person and
 * the run (docs/ticket-round-trip.md "Traceable merge requests and commits"). Pure text:
 * apps/api/src/services/work-traceability.ts looks up the requester, the
 * team and the run's address, and these turn them into
 *
 *   - the MR title: `PLAT-1: <title>` for work from a Jira ticket, so
 *     GitLab's Jira integration (and people) link the MR to the issue;
 *   - the MR description's footer: the ticket, who asked, the team, the run;
 *   - commit trailers, added by a prepare-commit-msg hook in the pod
 *     (services/commit-trailers.ts) from the run's environment:
 *       Jira: PLAT-1
 *       Co-authored-by: Ada Lovelace <ada@example.com>
 *       Optio-Run: https://optio.example.com/work/<id>
 *       Optio-Team: Platform
 *     The commit's author stays Optio's bot identity, so CODEOWNERS and
 *     approval rules still see a bot.
 *
 * The prompt variables are MR_TITLE, MR_FOOTER, JIRA_KEY and
 * COMMIT_TRAILERS (prompt-template-gitlab.ts); the GitHub arm of the default
 * coding prompt (prompt-template.ts) takes MR_TITLE and MR_FOOTER for its
 * pull request.
 */

/** A Jira issue key: project key (letter first), a dash, a number. */
const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export function isJiraKey(value: string | null | undefined): value is string {
  return typeof value === "string" && JIRA_KEY.test(value);
}

export interface WorkTrace {
  /** The work's title (the ticket's summary for ticket work). */
  title: string;
  /** Where the work came from: `jira`, `gitlab`, … or null. */
  ticketSource?: string | null;
  /** The ticket's key or number (`PLAT-1`, `12`). */
  ticketKey?: string | null;
  /** The ticket's page. */
  ticketUrl?: string | null;
  /** Who asked for it: the Jira reporter, else the person who made the work. */
  requester?: { name: string; email?: string | null } | null;
  /** The team whose work it is. */
  teamName?: string | null;
  /** The run's page in Optio (`<PUBLIC_URL>/work/<id>`), when PUBLIC_URL is set. */
  runUrl?: string | null;
}

/** One line, no control characters: safe in a trailer, a footer line or an env value. */
export function oneLine(value: string | null | undefined, max = 200): string {
  return (value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** An email worth putting in a trailer: one token with an @, no angle brackets. */
function cleanEmail(email: string | null | undefined): string | null {
  const e = oneLine(email, 254);
  return /^[^\s<>@]+@[^\s<>@]+$/.test(e) ? e : null;
}

/** The Jira key of work that came from a Jira ticket, else null. */
export function jiraKeyOf(trace: Pick<WorkTrace, "ticketSource" | "ticketKey">): string | null {
  return trace.ticketSource === "jira" && isJiraKey(trace.ticketKey) ? trace.ticketKey : null;
}

/** `PLAT-1: <title>` for Jira work (unless the title already starts with the key), else the title. */
export function mrTitle(trace: Pick<WorkTrace, "title" | "ticketSource" | "ticketKey">): string {
  const title = oneLine(trace.title, 240);
  const key = jiraKeyOf(trace);
  if (!key) return title;
  // The key is [A-Z0-9_-] only, so it is safe in a pattern; PLAT-12 is not PLAT-1.
  return new RegExp(`^${key}(?!\\d)`, "i").test(title) ? title : `${key}: ${title}`;
}

/** `Name <email>` for a Co-authored-by trailer, or null without an email. */
export function coAuthor(requester: WorkTrace["requester"]): string | null {
  if (!requester) return null;
  const email = cleanEmail(requester.email);
  if (!email) return null;
  const name = oneLine(requester.name, 120).replace(/[<>]/g, "") || email;
  return `${name} <${email}>`;
}

/** The commit trailers, in order, as [key, value] pairs. */
export function commitTrailers(trace: WorkTrace): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const key = jiraKeyOf(trace);
  if (key) out.push(["Jira", key]);
  const author = coAuthor(trace.requester);
  if (author) out.push(["Co-authored-by", author]);
  const run = oneLine(trace.runUrl, 500);
  if (run) out.push(["Optio-Run", run]);
  const team = oneLine(trace.teamName, 120);
  if (team) out.push(["Optio-Team", team]);
  return out;
}

/**
 * The run's environment the commit hook reads (services/commit-trailers.ts);
 * a value that isn't there adds no trailer.
 */
export function commitTrailerEnv(trace: WorkTrace): Record<string, string> {
  const env: Record<string, string> = {};
  const key = jiraKeyOf(trace);
  if (key) env.OPTIO_JIRA_KEY = key;
  const author = coAuthor(trace.requester);
  if (author) env.OPTIO_COMMIT_CO_AUTHOR = author;
  const run = oneLine(trace.runUrl, 500);
  if (run) env.OPTIO_RUN_URL = run;
  const team = oneLine(trace.teamName, 120);
  if (team) env.OPTIO_TEAM_NAME = team;
  return env;
}

/** The MR description's footer (Markdown), or "" when there is nothing to say. */
export function mrFooter(trace: WorkTrace): string {
  const lines: string[] = [];
  const key = jiraKeyOf(trace);
  const ticketUrl = oneLine(trace.ticketUrl, 500);
  if (key) lines.push(ticketUrl ? `Jira: [${key}](${ticketUrl})` : `Jira: ${key}`);
  const who = trace.requester ? oneLine(trace.requester.name, 120) : "";
  if (who) lines.push(`Requested by: ${who}`);
  const team = oneLine(trace.teamName, 120);
  if (team) lines.push(`Team: ${team}`);
  const run = oneLine(trace.runUrl, 500);
  if (run) lines.push(`Optio run: ${run}`);
  if (!lines.length) return "";
  // Two spaces end a Markdown line without a paragraph between them.
  return ["---", ...lines.map((l, i) => (i < lines.length - 1 ? `${l}  ` : l))].join("\n");
}

/** Text safe inside a double-quoted shell string (`"…"`): \ " $ ` escaped. */
export function shellDoubleQuoted(value: string): string {
  return value.replace(/[\\"$`]/g, (c) => `\\${c}`);
}

/**
 * The prompt variables (prompt-template-gitlab.ts, and the GitHub arm of
 * prompt-template.ts). MR_TITLE goes inside `glab mr update --title "…"` /
 * `gh pr create --title "…"`, so it is escaped for a double-quoted shell
 * string; MR_FOOTER sits in a quoted here-document and needs nothing.
 */
export function traceabilityPromptVars(trace: WorkTrace): Record<string, string> {
  const trailers = commitTrailers(trace);
  return {
    MR_TITLE: shellDoubleQuoted(mrTitle(trace)),
    MR_FOOTER: mrFooter(trace),
    JIRA_KEY: jiraKeyOf(trace) ?? "",
    COMMIT_TRAILERS: trailers.map(([k, v]) => `${k}: ${v}`).join("\n"),
  };
}
