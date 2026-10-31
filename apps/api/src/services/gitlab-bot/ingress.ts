import { featureAllows } from "@optio/shared";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { gitlabMentions, type GitLabMentionSubject } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { MAX_NOTE_CHARS, mentionsAnyone } from "./commands.js";
import { cachedBotUsername } from "./bot-cache.js";

/**
 * The receivers' hook for @-mentions (docs/gitlab-bot.md): GitLab's
 * (routes/event-ingress.ts calls `acceptGitLabMention` once the delivery's
 * token checks out) and GitHub's (routes/tickets.ts calls
 * `acceptGitHubMention` for an `issue_comment` once its signature checks
 * out). Kept light — the receiver answers within the platform's timeout:
 * while the platform's bot is on, a comment that mentions someone is
 * stored (once per host and comment id, so a redelivery or a second hook
 * on the same project is a no-op), and handled after the reply by
 * process.ts. While it is off nothing is stored.
 *
 * A row a stopped instance left behind (still `received` after two
 * minutes, or `processing` after five) is picked up by the next delivery.
 */

export interface MentionNote {
  host: string;
  noteId: number;
  projectId: number;
  projectUrl: string;
  noteableType: "MergeRequest" | "Issue";
  noteableIid: number;
  discussionId: string | null;
  noteUrl: string | null;
  authorGitlabId: number | null;
  authorUsername: string;
  note: string;
  subject: GitLabMentionSubject;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * A GitHub `issue_comment` event (a new comment on an issue or a pull
 * request's conversation), as the bot needs it; null for anything else,
 * and for a comment by a bot (GitHub's `type: Bot`). The pull request's
 * branches aren't in the event: process.ts reads them.
 */
export function mentionCommentOf(payload: unknown): MentionNote | null {
  const p = obj(payload);
  if (str(p.action) !== "created") return null;
  const comment = obj(p.comment);
  const issue = obj(p.issue);
  const repository = obj(p.repository);
  const user = obj(comment.user);
  if (str(user.type) === "Bot") return null;
  const projectUrl = str(repository.html_url);
  let host = "";
  try {
    host = new URL(projectUrl).host.toLowerCase();
  } catch {
    return null;
  }
  const noteId = num(comment.id);
  const projectId = num(repository.id);
  const iid = num(issue.number);
  const author = str(user.login);
  if (!noteId || !projectId || !iid || !author) return null;
  const pr = issue.pull_request ? obj(issue.pull_request) : null;
  return {
    host,
    noteId,
    projectId,
    projectUrl,
    noteableType: pr ? "MergeRequest" : "Issue",
    noteableIid: iid,
    discussionId: null,
    noteUrl: str(comment.html_url) || null,
    authorGitlabId: num(user.id),
    authorUsername: author,
    note: str(comment.body).slice(0, MAX_NOTE_CHARS),
    subject: {
      platform: "github",
      title: str(issue.title).slice(0, 500),
      description: str(issue.body).slice(0, 8_000),
      state: str(issue.state) || undefined,
      url: (pr ? str(pr.html_url) : "") || str(issue.html_url) || undefined,
      authorEmail: null,
    },
  };
}

/** A GitLab note event on a merge request or an issue, as the bot needs it; null for anything else. */
export function mentionNoteOf(payload: unknown): MentionNote | null {
  const p = obj(payload);
  if (str(p.object_kind) !== "note") return null;
  const attrs = obj(p.object_attributes);
  if (attrs.system === true) return null;
  // A note event GitLab sends for an edit (`action: update`) isn't a new request.
  if (attrs.action && str(attrs.action) !== "create") return null;
  const type = str(attrs.noteable_type);
  if (type !== "MergeRequest" && type !== "Issue") return null;
  const project = obj(p.project);
  const projectUrl = str(project.web_url);
  const projectId = num(project.id) ?? num(attrs.project_id);
  const noteId = num(attrs.id);
  let host = "";
  try {
    host = new URL(projectUrl).host.toLowerCase();
  } catch {
    return null;
  }
  const user = obj(p.user);
  const author = str(user.username) || str(p.user_username);
  if (!projectId || !noteId || !author) return null;
  const s = type === "MergeRequest" ? obj(p.merge_request) : obj(p.issue);
  const iid = num(s.iid);
  if (!iid) return null;
  const lastCommit = obj(s.last_commit);
  const subject: GitLabMentionSubject = {
    title: str(s.title).slice(0, 500),
    description: str(s.description).slice(0, 8_000),
    state: str(s.state) || undefined,
    url: str(s.url) || undefined,
    ...(type === "MergeRequest"
      ? {
          sourceBranch: str(s.source_branch) || null,
          targetBranch: str(s.target_branch) || null,
          sourceProjectId: num(s.source_project_id),
          targetProjectId: num(s.target_project_id),
          headSha: str(lastCommit.id) || null,
        }
      : {}),
    authorEmail: str(user.email) || null,
  };
  return {
    host,
    noteId,
    projectId,
    projectUrl,
    noteableType: type,
    noteableIid: iid,
    discussionId: str(attrs.discussion_id) || null,
    noteUrl: str(attrs.url) || null,
    authorGitlabId: num(user.id) ?? num(attrs.author_id),
    authorUsername: author,
    note: str(attrs.note).slice(0, MAX_NOTE_CHARS),
    subject,
  };
}

const inflight = new Set<Promise<unknown>>();

/** Settles once every mention this instance started handling has been handled (tests). */
export async function mentionWorkSettled(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}

function handleLater(ids: string[]): void {
  for (const id of ids) {
    const p = import("./process.js")
      .then(({ processMention }) => processMention(id))
      .catch((err) => logger.warn({ err, mentionId: id }, "Mention: handling failed"));
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  }
}

/** Rows left waiting by an instance that stopped (see the header). */
async function strandedMentions(): Promise<string[]> {
  const rows = await db
    .select({ id: gitlabMentions.id })
    .from(gitlabMentions)
    .where(
      or(
        and(
          eq(gitlabMentions.status, "received"),
          lt(gitlabMentions.createdAt, sql`now() - interval '2 minutes'`),
        ),
        and(
          eq(gitlabMentions.status, "processing"),
          lt(gitlabMentions.updatedAt, sql`now() - interval '5 minutes'`),
        ),
      ),
    )
    .limit(5);
  return rows.map((r) => r.id);
}

/** Whether the platform's bot is on (settings.ts, loaded only for a comment that mentions someone). */
/** The platform's bot is on, and the deployment offers the platform (OPTIO_GIT_PLATFORMS). */
async function botEnabled(platform: "github" | "gitlab"): Promise<boolean> {
  if (!featureAllows("gitPlatforms", platform)) return false;
  const { botSettings } = await import("./settings.js");
  return (await botSettings(platform)).enabled;
}

/**
 * Store a GitLab comment that mentions someone, and handle it after the
 * reply. Never throws: the trigger path that follows in the receiver must
 * run whatever happens here.
 */
export async function acceptGitLabMention(payload: unknown, deliveryUuid?: string): Promise<void> {
  try {
    const m = mentionNoteOf(payload);
    if (!m || !mentionsAnyone(m.note)) return;
    // The bot's own replies mention people too.
    const apiBase = `https://${m.host}/api/v4`;
    const bot = cachedBotUsername(apiBase);
    if (bot && bot.toLowerCase() === m.authorUsername.toLowerCase()) return;
    if (!(await botEnabled("gitlab"))) return;
    await storeMention(m, deliveryUuid);
  } catch (err) {
    logger.warn({ err }, "GitLab mention: could not store the comment");
  }
}

/** The same for a GitHub comment (`issue_comment`, routes/tickets.ts). Never throws. */
export async function acceptGitHubMention(payload: unknown, deliveryUuid?: string): Promise<void> {
  try {
    const m = mentionCommentOf(payload);
    if (!m || !mentionsAnyone(m.note)) return;
    const apiBase = m.host === "github.com" ? "https://api.github.com" : `https://${m.host}/api/v3`;
    const bot = cachedBotUsername(`github:${apiBase}`)?.toLowerCase();
    const author = m.authorUsername.toLowerCase();
    if (bot && (author === bot || author === `${bot}[bot]`)) return;
    if (!(await botEnabled("github"))) return;
    await storeMention(m, deliveryUuid);
  } catch (err) {
    logger.warn({ err }, "GitHub mention: could not store the comment");
  }
}

async function storeMention(m: MentionNote, deliveryUuid?: string): Promise<void> {
  const [row] = await db
    .insert(gitlabMentions)
    .values({ ...m, deliveryUuid: deliveryUuid ?? null })
    .onConflictDoNothing()
    .returning({ id: gitlabMentions.id });
  const stranded = await strandedMentions().catch(() => []);
  handleLater([...(row ? [row.id] : []), ...stranded.filter((id) => id !== row?.id)]);
}

/** Forget handled rows: ignored ones after a day, the rest after 90 days (process.ts). */
export async function pruneGitLabMentions(): Promise<void> {
  await db
    .delete(gitlabMentions)
    .where(
      or(
        and(
          inArray(gitlabMentions.status, ["ignored"]),
          lt(gitlabMentions.createdAt, sql`now() - interval '1 day'`),
        ),
        lt(gitlabMentions.createdAt, sql`now() - interval '90 days'`),
      ),
    );
}
