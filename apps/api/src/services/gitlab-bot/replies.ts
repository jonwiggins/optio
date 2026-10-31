/**
 * What Optio's GitLab user says in a thread (docs/gitlab-bot.md): the
 * acknowledgement with the run's link, the reason it won't act, and the
 * run's result. Pure, so the words are tested on their own. Every reply
 * starts with the person it answers (`@alice`), which GitLab notifies, and
 * never names the bot itself, so a reply can't trigger another.
 */
import { classifyError } from "@optio/shared";
import { maskSecrets } from "./mask.js";
import { RATE_WINDOW_MINUTES } from "./settings.js";
import { GITLAB_WORDS, type ThreadWords } from "./words.js";

/** Optio's address for links (`PUBLIC_URL`), or null without one. */
export function publicWebUrl(): string | null {
  const raw = process.env.PUBLIC_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/** Optio's page about a run, or null without PUBLIC_URL. */
export function runLink(taskId: string, base: string | null): string | null {
  return base ? `${base}/work/${taskId}` : null;
}

const runRef = (taskId: string, base: string | null) => runLink(taskId, base) ?? `run ${taskId}`;

/** One line of a message, masked and cut. */
export function shortReason(text: string | null | undefined, max = 400): string {
  const clean = maskSecrets((text ?? "").replace(/\s+/g, " ").trim());
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** What the triggers that make work wait for a person mean, in words fit for the thread. */
function waitingBecause(trigger: string, w: ThreadWords): string | null {
  switch (trigger) {
    case "plan_review":
      return "its plan is ready for review";
    case "completed_without_pr":
      return `the agent finished without opening a ${w.mr}`;
    case "merge_conflicts":
      return `its ${w.mr} has conflicts`;
    case "ci_failing":
      return `its ${w.mr}'s checks fail`;
    case "review_changes_requested":
      return "a review asked for changes";
    default:
      return null;
  }
}

/**
 * The reason a thread may read: the trigger's words, else the error's class
 * (error-classifier.ts's title, e.g. "Out of memory"), never the error
 * message itself, which can end with the agent's stderr (paths, host names,
 * variable names) and is for those who may see the run, not everyone on
 * the project. Empty when neither says anything; the run's link has the rest.
 */
export function publicReason(
  trigger: string | null | undefined,
  errorMessage: string | null | undefined,
  w: ThreadWords = GITLAB_WORDS,
): string {
  const waiting = trigger ? waitingBecause(trigger, w) : null;
  if (waiting) return waiting;
  if (!errorMessage?.trim()) return "";
  const classified = classifyError(errorMessage);
  return classified.category === "unknown" ? "" : classified.title;
}

export function helpReply(author: string, bot: string, w: ThreadWords = GITLAB_WORDS): string {
  return [
    `@${author} Mention me with what to do:`,
    "",
    `- \`@${bot} add a health check\` — on an issue I start work from the issue and open a ${w.mr}; on a ${w.mr} I opened I make the change on it; on anyone else's I open a ${w.mr} into its branch.`,
    "",
    `I work as you: the Optio account you sign in to Optio with through ${w.platform}, else the one whose verified email is your public ${w.platform} email, and what you may see and change in Optio.`,
  ].join("\n");
}

export type StartKind = "issue" | "mr" | "resume";

export function ackReply(
  author: string,
  kind: StartKind,
  taskId: string,
  base: string | null,
  extra?: { sourceBranch?: string | null },
  w: ThreadWords = GITLAB_WORDS,
): string {
  const link = runRef(taskId, base);
  switch (kind) {
    case "resume":
      return `@${author} On it: I'm making the change on this ${w.mr} (${link}). I'll reply here when it's done.`;
    case "mr":
      return `@${author} On it: the change comes as a ${w.mr} into \`${extra?.sourceBranch ?? "this branch"}\` (${link}). I'll reply here when it's done.`;
    case "issue":
      return `@${author} On it (${link}). I'll reply here with the ${w.mr} when it's done.`;
  }
}

/** Why the bot won't act, as a reply. */
export type Refusal =
  | { code: "no_account"; username: string }
  | { code: "ambiguous_account" }
  | { code: "not_member"; project: string }
  | { code: "viewer"; project: string }
  | { code: "gitlab_access"; project: string }
  | { code: "access_unknown"; detail: string }
  | { code: "busy"; taskId: string }
  | { code: "finished" }
  | { code: "mr_closed"; state: string }
  | { code: "fork_mr"; project: string }
  | { code: "not_yours" }
  | { code: "cant_see" }
  | { code: "rate_limited"; limit: number }
  | { code: "work_refused"; message: string }
  | { code: "no_branch" }
  /** Something unexpected: `ref` (the mention's id) finds the API log's line; the error itself stays there. */
  | { code: "error"; ref: string };

export function refusalReply(
  author: string,
  r: Refusal,
  base: string | null,
  w: ThreadWords = GITLAB_WORDS,
): string {
  const to = `@${author}`;
  switch (r.code) {
    case "no_account": {
      return `${to} I can't tell which Optio account is yours: this ${w.platform} account isn't linked to one, and no Optio account has your public ${w.platform} email as its verified email. Sign in to Optio${base ? ` (${base})` : ""} with this ${w.platform} account, then mention me again.`;
    }
    case "ambiguous_account":
      return `${to} More than one Optio account has your ${w.platform} email, so I can't tell whose work this would be. Sign in to Optio with this ${w.platform} account to link it, or ask an Optio admin to sort the accounts out.`;
    case "not_member":
      return `${to} You aren't a member of the Optio workspace that has \`${r.project}\`. Ask one of its admins to add you, then mention me again.`;
    case "viewer":
      return `${to} You can look but not start work in the Optio workspace that has \`${r.project}\` (you're a viewer there).`;
    case "gitlab_access":
      return `${to} You need ${w.role} on \`${r.project}\` for me to change it for you.`;
    case "access_unknown":
      return `${to} I couldn't check your role on this project (${shortReason(r.detail, 200)}), so I haven't started anything. Try again in a while.`;
    case "busy":
      return `${to} I'm still working on this ${w.mr} (${runRef(r.taskId, base)}). Mention me again once that run has finished.`;
    case "finished":
      return `${to} The work behind this ${w.mr} has finished in Optio. Open an issue or a new ${w.mr} and mention me there.`;
    case "mr_closed":
      return `${to} This ${w.mr} is ${r.state === "merged" ? "merged" : "closed"}; I only work on open ones.`;
    case "fork_mr":
      return `${to} This ${w.mr} comes from a fork; I can only work on branches of \`${r.project}\`.`;
    case "not_yours":
      // Not workChangeError's words: they can name a private owner.
      return `${to} This ${w.mr} is someone else's work in Optio, so I can't change it for you.`;
    case "cant_see":
      return `${to} The work behind this ${w.mr} isn't yours to see in Optio, so I can't change it for you.`;
    case "rate_limited":
      return `${to} That's a lot of requests: I take at most ${r.limit} from one person per ${w.mr} or issue in ${RATE_WINDOW_MINUTES} minutes. Mention me again in a few minutes.`;
    case "work_refused":
      return `${to} Optio didn't start the work: ${shortReason(r.message)}.`;
    case "no_branch":
      return `${to} ${w.platform} didn't say which branch this ${w.mr} is from, so I can't start from it.`;
    case "error":
      // Never the error itself: the thread is for everyone on the project.
      return `${to} Something went wrong on my side and I couldn't start the work. An Optio admin can look it up with the reference \`${r.ref}\`.`;
  }
}

/** The run's result, posted once when it settles. */
export function outcomeReply(input: {
  author: string;
  state: "pr_opened" | "completed" | "needs_attention" | "failed" | "cancelled";
  taskId: string;
  base: string | null;
  /** The MR the run opened or pushed to. */
  prUrl?: string | null;
  /** Whether the run worked on the merge request this thread is on. */
  sameMr: boolean;
  /** Why it stopped, as `publicReason` puts it: never the error message itself. */
  reason?: string | null;
  /** The platform's words (GitLab's by default). */
  words?: ThreadWords;
}): string {
  const w = input.words ?? GITLAB_WORDS;
  const to = `@${input.author}`;
  const link = runRef(input.taskId, input.base);
  switch (input.state) {
    case "pr_opened":
      if (input.sameMr) return `${to} Done: I pushed the changes to this ${w.mr} (${link}).`;
      return `${to} Done: ${input.prUrl ?? `the ${w.mr}`} is ready for your review (${link}).`;
    case "completed":
      // Not the agent's summary: like an error, it is for the run's viewers.
      return `${to} Done (${link}).`;
    case "needs_attention":
      return `${to} This needs you: ${shortReason(input.reason) || "the run stopped and is waiting for a person"} (${link}).`;
    case "failed":
      return `${to} The run failed: ${shortReason(input.reason) || "no reason given"} (${link}).`;
    case "cancelled":
      return `${to} The run was cancelled (${link}).`;
  }
}
