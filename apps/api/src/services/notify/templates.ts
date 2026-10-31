/**
 * The words of Optio's emails: plain text, short, with links back to the
 * work (PUBLIC_URL) and to where the person changes what they get. Pure
 * functions — the dispatcher (dispatch.ts) and `notify()` fill them in.
 */

/** Optio's web address without a trailing slash, or null when `PUBLIC_URL` is unset. */
export function publicWebUrl(): string | null {
  const raw = process.env.PUBLIC_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

/** An absolute link: as is when it has a scheme, under PUBLIC_URL when it's a path. */
export function absoluteLink(
  link: string | null | undefined,
  base = publicWebUrl(),
): string | null {
  const l = link?.trim();
  if (!l) return null;
  if (/^https?:\/\//i.test(l)) return l;
  if (!base) return null;
  return `${base}${l.startsWith("/") ? "" : "/"}${l}`;
}

/** What an email about a piece of work needs to know about it. */
export interface WorkSummary {
  id: string;
  /** `repo` (a Task) or `standalone` (a Job run). */
  kind: "repo" | "standalone";
  title: string;
  repoUrl?: string | null;
  prUrl?: string | null;
  errorMessage?: string | null;
  /** A Job run's Job. */
  workId?: string | null;
}

/** The page about the work: a Task's at /work/:id, a Job run's under its Job. */
export function workPath(w: Pick<WorkSummary, "id" | "kind" | "workId">): string {
  if (w.kind === "standalone" && w.workId) return `/jobs/${w.workId}/runs/${w.id}`;
  return `/work/${w.id}`;
}

/** `platform/hello-service` from a repo URL (or the URL itself). */
export function repoName(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  return repoUrl.replace(/^[a-z]+:\/\/[^/]+\//i, "").replace(/\.git$/, "") || repoUrl;
}

/** Why this person gets the email — the footer's first line. */
export type RecipientReason =
  | { why: "owner" }
  | { why: "creator" }
  | { why: "team-admin"; teamName: string | null }
  /** A notice to a team's admins (`notify({ toTeamAdminsOf })`), not about one piece of work. */
  | { why: "team"; teamName: string | null }
  | { why: "addressed" };

export interface RenderedEmail {
  subject: string;
  text: string;
  link: string | null;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function footer(reason: RecipientReason, base: string | null): string {
  const why =
    reason.why === "owner"
      ? "You get this email because this is your work."
      : reason.why === "creator"
        ? "You get this email because you started this work."
        : reason.why === "team-admin"
          ? `You get this email because you're an admin of the team${reason.teamName ? ` ${reason.teamName}` : ""}, which owns this work.`
          : reason.why === "team"
            ? `You get this email as an admin of the team${reason.teamName ? ` ${reason.teamName}` : ""}.`
            : "You get this email from Optio.";
  const where = base
    ? `Choose which emails you get: ${base}/settings#notifications`
    : "Choose which emails you get under Settings → Notifications.";
  return `-- \n${why}\n${where}\n`;
}

/** Lines of `label: value`, aligned, skipping empty values. */
function facts(rows: Array<[string, string | null | undefined]>): string {
  const present = rows.filter((r): r is [string, string] => !!r[1]);
  const width = Math.max(0, ...present.map(([l]) => l.length + 1));
  return present.map(([l, v]) => `${`${l}:`.padEnd(width)} ${v}`).join("\n");
}

const HEADLINES: Record<string, { subject: string; lead: (title: string) => string }> = {
  "task.pr_opened": {
    subject: "Merge request waiting for you",
    lead: (t) => `"${t}" opened a merge request. It is waiting for you to review and merge it.`,
  },
  "task.needs_attention": {
    subject: "Needs your attention",
    lead: (t) => `"${t}" stopped and needs you.`,
  },
  "task.failed": {
    subject: "Failed",
    lead: (t) => `"${t}" failed.`,
  },
  "task.completed": {
    subject: "Merged",
    lead: (t) => `The merge request of "${t}" was merged. The work is done.`,
  },
};

/** The email about a work event (`task.pr_opened`, …) for one recipient. */
export function renderWorkEmail(
  kind: string,
  work: WorkSummary,
  reason: RecipientReason,
  base: string | null = publicWebUrl(),
): RenderedEmail {
  const head = HEADLINES[kind] ?? { subject: kind, lead: (t: string) => `"${t}": ${kind}.` };
  const title = clip(oneLine(work.title || "Untitled work"), 120);
  const link = base ? `${base}${workPath(work)}` : null;
  const what = work.kind === "standalone" ? "Job run" : "Work";
  const error =
    (kind === "task.failed" || kind === "task.needs_attention") && work.errorMessage
      ? clip(work.errorMessage.trim().split(/\r?\n/, 1)[0], 1500)
      : null;
  const body = [
    head.lead(title),
    "",
    facts([
      [what, title],
      ["Repository", repoName(work.repoUrl)],
      ["Merge request", work.prUrl ?? null],
      ["Open in Optio", link],
    ]),
    ...(error ? ["", "What went wrong:", error] : []),
    "",
    footer(reason, base),
  ].join("\n");
  return { subject: `[Optio] ${head.subject}: ${title}`, text: body, link };
}

/** A message other parts of Optio send through `notify()` (budgets, tokens, …). */
export function renderNotice(
  input: { subject: string; body: string; link?: string | null },
  reason: RecipientReason,
  base: string | null = publicWebUrl(),
): RenderedEmail {
  const link = absoluteLink(input.link, base);
  const subject = clip(oneLine(input.subject), 200);
  const body = [
    input.body.trim(),
    ...(link ? ["", `Open in Optio: ${link}`] : []),
    "",
    footer(reason, base),
  ].join("\n");
  return {
    subject: subject.startsWith("[Optio]") ? subject : `[Optio] ${subject}`,
    text: body,
    link,
  };
}

/** The Settings → Notifications test message. */
export function renderTestEmail(
  sentBy: string | null,
  base: string | null = publicWebUrl(),
): RenderedEmail {
  return {
    subject: "[Optio] Test email",
    text: [
      "This is a test email from Optio. Email notifications work.",
      "",
      facts([
        ["Sent by", sentBy],
        ["Optio", base],
      ]),
      "",
    ].join("\n"),
    link: base,
  };
}
