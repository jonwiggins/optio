import { and, asc, desc, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import {
  InvalidTransitionError,
  TaskState,
  featureAllows,
  normalizeRepoUrl,
  parseRepoUrl,
  type RepoIdentifier,
} from "@optio/shared";
import { db } from "../../db/client.js";
import { gitlabMentions, repos, tasks, users, workspaceMembers } from "../../db/schema.js";
import { logger } from "../../logger.js";
import { logAction } from "../optio-action-service.js";
import { canSee, type Actor } from "../ownership.js";
import { findPerson } from "../person-lookup.js";
import * as taskService from "../task-service.js";
import { planNewWork, workChangeError } from "../work-ownership.js";
import { mentionsUser, parseMentionCommand, titleLine, type MentionCommand } from "./commands.js";
import { gitlabProblem } from "./gitlab-api.js";
import { pruneGitLabMentions } from "./ingress.js";
import { onMentionedTaskTransition } from "./outcome.js";
import {
  issueTaskPrompt,
  mergeRequestTaskPrompt,
  resumePrompt,
  type MentionContext,
} from "./prompts.js";
import {
  ackReply,
  helpReply,
  publicWebUrl,
  refusalReply,
  type Refusal,
  type StartKind,
} from "./replies.js";
import {
  RATE_WINDOW_MINUTES,
  botHosts,
  botIdentity,
  botSettings,
  githubBotIdentity,
  isNamedHost,
  type GitLabBotSettings,
} from "./settings.js";
import {
  mentionPlatform,
  mentionThread,
  type MentionPlatform,
  type MentionThread,
} from "./thread.js";
import { wordsFor, type ThreadWords } from "./words.js";

/**
 * One comment that mentioned someone on a GitHub or GitLab project Optio
 * knows (ingress.ts stored it): is it for Optio's bot there, who wrote it,
 * may they, and what to do (docs/gitlab-bot.md). The decisions are the
 * same on both; thread.ts does the platform's calls and words.ts says
 * "pull request" or "merge request".
 *
 *   1. The project is a repo in Optio (any workspace), on a host the
 *      deployment named (GitLab); the comment mentions the bot (settings.ts)
 *      and isn't the bot's own; at most `rateLimit` commands from one person
 *      per merge request or issue in ten minutes (per person, so someone who
 *      may not use the bot can't use up everyone's budget with refusals).
 *   2. An `eyes` award on the comment: seen.
 *   3. The author is an Optio person (person-lookup.ts: the account that
 *      signs in with that GitHub or GitLab user, else the one account whose
 *      verified email is the author's public email), a member (not a viewer)
 *      of a workspace that has the repo, with at least Developer on the
 *      GitLab project (write on the GitHub repository).
 *   4. On a merge request Optio opened: the task resumes with the comment as
 *      its instruction (if the person may run it, as the Resume button
 *      asks). On anyone else's merge request: new work from its source
 *      branch, whose merge request goes into that branch. On an issue: new
 *      work from the issue. New work is the author's own.
 *   5. A reply in the thread with the run's link, or why not; the run's
 *      result follows when it ends (outcome.ts). Each outcome goes to the
 *      action log (`gitlab_mention.*`).
 */

type Row = typeof gitlabMentions.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

const STALE_PROCESSING = sql`now() - interval '5 minutes'`;
const PRUNE_EVERY_MS = 60 * 60_000;
let lastPrune = 0;

/** Statuses that count toward the rate limit: the bot answered them. */
const ANSWERED = ["refused", "started", "done", "failed"] as const;

const BUSY_STATES: readonly string[] = [
  TaskState.PENDING,
  TaskState.WAITING_ON_DEPS,
  TaskState.QUEUED,
  TaskState.PROVISIONING,
  TaskState.RUNNING,
];
const RESUMABLE_STATES: readonly string[] = [
  TaskState.PR_OPENED,
  TaskState.NEEDS_ATTENTION,
  TaskState.FAILED,
  TaskState.CANCELLED,
];

export async function processMention(id: string): Promise<void> {
  const [row] = await db
    .update(gitlabMentions)
    .set({ status: "processing", updatedAt: new Date() })
    .where(
      and(
        eq(gitlabMentions.id, id),
        or(
          eq(gitlabMentions.status, "received"),
          and(
            eq(gitlabMentions.status, "processing"),
            lt(gitlabMentions.updatedAt, STALE_PROCESSING),
          ),
        ),
      ),
    )
    .returning();
  if (!row) return;
  if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
    lastPrune = Date.now();
    void pruneGitLabMentions().catch((err) =>
      logger.warn({ err }, "GitLab mention: could not prune old rows"),
    );
  }
  const h = new Handler(row);
  try {
    await h.run();
  } catch (err) {
    // The error stays in this log line; the thread gets the row's id to find it by.
    logger.warn({ err, mentionId: row.id }, "GitLab mention: failed");
    await h.refuse({ code: "error", ref: row.id }, "failed").catch(() => {});
  }
}

/** The sign-in account a comment's author would have: GitHub's on github.com, GitLab's on the GitLab sign-in uses. */
function linkedAccount(
  platform: MentionPlatform,
  host: string,
  authorId: number | null,
): { provider: MentionPlatform; externalId: string } | null {
  if (authorId === null) return null;
  let signInHost = "github.com";
  if (platform === "gitlab") {
    try {
      signInHost = new URL(process.env.GITLAB_OAUTH_BASE_URL || "https://gitlab.com").host;
    } catch {
      return null;
    }
  }
  return host.toLowerCase() === signInHost.toLowerCase()
    ? { provider: platform, externalId: String(authorId) }
    : null;
}

class Handler {
  private settings!: GitLabBotSettings;
  private ri: RepoIdentifier | null = null;
  private api: MentionThread | null = null;
  private readonly platform: MentionPlatform;
  private readonly words: ThreadWords;
  private bot = "";
  private userId: string | null = null;
  private workspaceId: string | null = null;
  private command: string | null = null;
  private replied = false;

  constructor(private readonly row: Row) {
    this.platform = mentionPlatform(row);
    this.words = wordsFor(this.platform);
  }

  private get project(): string {
    return this.ri ? `${this.ri.owner}/${this.ri.repo}` : this.row.projectUrl;
  }

  private async finish(
    status: Row["status"],
    patch: Partial<Pick<Row, "reason" | "taskId">> = {},
  ): Promise<void> {
    await db
      .update(gitlabMentions)
      .set({
        status,
        command: this.command,
        userId: this.userId,
        workspaceId: this.workspaceId,
        ...(this.replied ? { repliedAt: new Date() } : {}),
        ...patch,
        updatedAt: new Date(),
      })
      .where(eq(gitlabMentions.id, this.row.id));
  }

  private async reply(body: string): Promise<void> {
    if (!this.api) return;
    try {
      await this.api.reply(this.row, body);
      this.replied = true;
    } catch (err) {
      logger.warn({ err, mentionId: this.row.id }, "Mention: could not reply in the thread");
    }
  }

  /** The action log's entry (ids and names only; a refusal's reason as its status). */
  private audit(
    action: string,
    details: { taskId?: string; prUrl?: string; status?: string; id?: string },
    success = true,
  ): void {
    logAction({
      action,
      userId: this.userId ?? undefined,
      // No workspace (no Optio person): deployment admins see it.
      workspaceId: this.workspaceId,
      params: {
        repoUrl: this.row.projectUrl,
        type: this.platform,
        ...(this.command ? { kind: this.command } : {}),
        ...details,
      },
      success,
    }).catch(() => {});
  }

  /** Say why not, record it, and stop. */
  async refuse(
    r: Refusal,
    status: "refused" | "failed" | "rate_limited" = "refused",
  ): Promise<void> {
    if (this.api && (status !== "rate_limited" || (await this.firstRateLimitInWindow()))) {
      await this.reply(refusalReply(this.row.authorUsername, r, publicWebUrl(), this.words));
    }
    await this.finish(status, { reason: r.code });
    this.audit(
      "gitlab_mention.refuse",
      { status: r.code, ...(r.code === "error" ? { id: r.ref } : {}) },
      false,
    );
  }

  private ignore(reason: string): Promise<void> {
    return this.finish("ignored", { reason });
  }

  async run(): Promise<void> {
    const row = this.row;
    this.settings = await botSettings(this.platform);
    if (!this.settings.enabled || !featureAllows("gitPlatforms", this.platform)) {
      return this.ignore("disabled");
    }
    const github = this.platform === "github";

    // 1. A repo in Optio, the bot's name, not its own comment.
    const repoRows = await db
      .select({ id: repos.id, repoUrl: repos.repoUrl, workspaceId: repos.workspaceId })
      .from(repos)
      .where(eq(repos.repoUrl, normalizeRepoUrl(row.projectUrl)))
      .orderBy(asc(repos.createdAt));
    if (repoRows.length === 0) return this.ignore("unknown_project");
    this.ri = parseRepoUrl(repoRows[0].repoUrl, github ? "github" : undefined);
    if (!this.ri || this.ri.platform !== this.platform) {
      return this.ignore(github ? "not_github" : "not_gitlab");
    }
    if (!github && !isNamedHost(this.ri.host, await botHosts())) {
      return this.ignore("host_not_named");
    }
    const { identity, error } = github
      ? await githubBotIdentity(this.ri.apiBaseUrl, this.settings)
      : await botIdentity(this.ri.apiBaseUrl, repoRows[0].workspaceId, this.settings);
    if (!identity) {
      logger.warn(
        { host: row.host, platform: this.platform, error },
        "Mention: Optio's bot user is unknown",
      );
      return this.ignore("bot_unknown");
    }
    this.bot = identity.username;
    const author = row.authorUsername.toLowerCase();
    const botName = identity.username.toLowerCase();
    const own =
      author === botName ||
      (github && author === `${botName}[bot]`) ||
      (identity.id !== null && row.authorGitlabId === identity.id);
    if (own) return this.ignore("own_note");
    if (!mentionsUser(row.note, identity.username)) return this.ignore("not_for_bot");

    const cmd = parseMentionCommand(row.note, identity.username);
    this.command = cmd.kind;
    this.api = await mentionThread(this.ri, repoRows[0].workspaceId);

    if (await this.overRateLimit()) {
      return this.refuse({ code: "rate_limited", limit: this.settings.rateLimit }, "rate_limited");
    }

    // 2. Seen.
    await this.api
      .ack(row)
      .catch((err) => logger.warn({ err, mentionId: row.id }, "Mention: no emoji on the comment"));

    if (cmd.kind === "help") {
      await this.reply(helpReply(row.authorUsername, this.bot, this.words));
      return this.finish("done", { reason: "help" });
    }

    // 3. Who, and may they: the linked sign-in, else the verified public email.
    const linked = linkedAccount(this.platform, row.host, row.authorGitlabId);
    const thread = this.api;
    const person = await findPerson({
      linked,
      email: () => thread.authorEmail(row).catch(() => null),
    });
    if (!person.found) {
      return this.refuse(
        person.reason === "ambiguous"
          ? { code: "ambiguous_account" }
          : { code: "no_account", username: row.authorUsername },
      );
    }
    this.userId = person.userId;

    const memberships = await db
      .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, person.userId),
          inArray(
            workspaceMembers.workspaceId,
            repoRows.map((r) => r.workspaceId).filter((w): w is string => !!w),
          ),
        ),
      );
    if (memberships.length === 0) return this.refuse({ code: "not_member", project: this.project });
    const [me] = await db
      .select({ defaultWorkspaceId: users.defaultWorkspaceId })
      .from(users)
      .where(eq(users.id, person.userId));
    const working = memberships.filter((m) => m.role !== "viewer");
    if (working.length === 0) {
      this.workspaceId = memberships[0].workspaceId;
      return this.refuse({ code: "viewer", project: this.project });
    }
    const chosen =
      working.find((m) => m.workspaceId === me?.defaultWorkspaceId) ??
      repoRows.map((r) => working.find((m) => m.workspaceId === r.workspaceId)).find((m) => !!m)!;
    this.workspaceId = chosen.workspaceId;
    const repo = repoRows.find((r) => r.workspaceId === chosen.workspaceId)!;
    if (repo.workspaceId !== repoRows[0].workspaceId) {
      this.api = await mentionThread(this.ri, repo.workspaceId);
    }

    if (!github && !row.authorGitlabId) {
      return this.refuse({ code: "access_unknown", detail: "GitLab didn't say who wrote it" });
    }
    let mayPush: boolean;
    try {
      mayPush = await this.api.authorMayPush(row);
    } catch (err) {
      logger.warn({ err, mentionId: row.id }, "Mention: could not read the author's role");
      return this.refuse({
        code: "access_unknown",
        detail: gitlabProblem(err, this.words.platform),
      });
    }
    if (!mayPush) return this.refuse({ code: "gitlab_access", project: this.project });

    // The person as the HTTP routes would see them in that workspace.
    const actor: Actor = {
      userId: person.userId,
      workspaceId: chosen.workspaceId,
      isAdmin: chosen.role === "admin",
    };

    // 4. What to do.
    if (row.noteableType === "Issue") {
      return this.startWork(repo.repoUrl, actor, cmd, "issue");
    }
    if (this.api.pullRequest) {
      // GitHub's comment events don't carry the pull request's branches.
      try {
        const pr = await this.api.pullRequest(row);
        row.subject = {
          ...row.subject,
          state: pr.state,
          sourceBranch: pr.sourceBranch,
          targetBranch: pr.targetBranch,
          headSha: pr.headSha,
          sourceProjectId: pr.sourceRepoId,
          targetProjectId: pr.targetRepoId,
          url: pr.url ?? row.subject?.url,
        };
      } catch (err) {
        logger.warn({ err, mentionId: row.id }, "Mention: could not read the pull request");
        return this.refuse({ code: "no_branch" });
      }
    }
    const state = row.subject?.state ?? "opened";
    if (state === "merged" || state === "closed") {
      return this.refuse({ code: "mr_closed", state });
    }
    const task = await this.optioTask(repo.repoUrl, chosen.workspaceId);
    if (task) return this.resumeWork(task, actor, cmd);
    const { sourceProjectId, targetProjectId } = row.subject ?? {};
    if (sourceProjectId && targetProjectId && sourceProjectId !== targetProjectId) {
      return this.refuse({ code: "fork_mr", project: this.project });
    }
    if (!row.subject?.sourceBranch) {
      return this.refuse({ code: "no_branch" });
    }
    return this.startWork(repo.repoUrl, actor, cmd, "mr");
  }

  private async overRateLimit(): Promise<boolean> {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(gitlabMentions)
      .where(
        and(
          this.sameSubject(),
          this.sameAuthor(),
          ne(gitlabMentions.id, this.row.id),
          inArray(gitlabMentions.status, [...ANSWERED]),
          gt(gitlabMentions.createdAt, sql`now() - make_interval(mins => ${RATE_WINDOW_MINUTES})`),
        ),
      );
    return n >= this.settings.rateLimit;
  }

  /** Only a person's first refusal for the rate limit in a window gets a reply. */
  private async firstRateLimitInWindow(): Promise<boolean> {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(gitlabMentions)
      .where(
        and(
          this.sameSubject(),
          this.sameAuthor(),
          ne(gitlabMentions.id, this.row.id),
          eq(gitlabMentions.status, "rate_limited"),
          gt(gitlabMentions.createdAt, sql`now() - make_interval(mins => ${RATE_WINDOW_MINUTES})`),
        ),
      );
    return n === 0;
  }

  private sameSubject() {
    return and(
      eq(gitlabMentions.host, this.row.host),
      eq(gitlabMentions.projectId, this.row.projectId),
      eq(gitlabMentions.noteableType, this.row.noteableType),
      eq(gitlabMentions.noteableIid, this.row.noteableIid),
    );
  }

  /** The same GitLab user: their id when the event gave one (names change), else their username. */
  private sameAuthor() {
    return this.row.authorGitlabId !== null
      ? eq(gitlabMentions.authorGitlabId, this.row.authorGitlabId)
      : sql`lower(${gitlabMentions.authorUsername}) = ${this.row.authorUsername.toLowerCase()}`;
  }

  /** The newest Repo Task of this workspace whose merge request this is. */
  private async optioTask(repoUrl: string, workspaceId: string): Promise<TaskRow | null> {
    const [t] = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.repoUrl, normalizeRepoUrl(repoUrl)),
          eq(tasks.prNumber, this.row.noteableIid),
        ),
      )
      .orderBy(desc(tasks.createdAt))
      .limit(1);
    return t ?? null;
  }

  private context(): MentionContext {
    const s = this.row.subject ?? {};
    return {
      author: this.row.authorUsername,
      project: this.project,
      noteUrl: this.row.noteUrl,
      iid: this.row.noteableIid,
      title: s.title ?? "",
      description: s.description ?? "",
      url: s.url ?? null,
    };
  }

  private async resumeWork(task: TaskRow, actor: Actor, cmd: MentionCommand): Promise<void> {
    if (cmd.kind === "empty") {
      await this.reply(helpReply(this.row.authorUsername, this.bot, this.words));
      return this.finish("done", { reason: "help" });
    }
    if (!canSee(task.ownerUserId, actor)) return this.refuse({ code: "cant_see" });
    const notYours = await workChangeError(task.ownerUserId, actor, "run");
    if (notYours) return this.refuse({ code: "not_yours", message: notYours });
    if (task.state === TaskState.COMPLETED) return this.refuse({ code: "finished" });
    if (BUSY_STATES.includes(task.state) || !RESUMABLE_STATES.includes(task.state)) {
      return this.refuse({ code: "busy", taskId: task.id });
    }
    const prompt = resumePrompt(this.context(), cmd.instruction, this.words);
    const kind: StartKind = "resume";

    try {
      await taskService.transitionTask(
        task.id,
        TaskState.QUEUED,
        "gitlab_mention",
        `@${this.row.authorUsername} on ${this.words.platform}: ${titleLine(cmd.instruction, 160)}`,
        this.userId ?? undefined,
      );
    } catch (err) {
      // Another comment (or the reconciler) moved it first: it is busy now.
      if (err instanceof InvalidTransitionError || err instanceof taskService.StateRaceError) {
        return this.refuse({ code: "busy", taskId: task.id });
      }
      throw err;
    }
    const { taskQueue } = await import("../../workers/task-worker.js");
    await taskQueue.add(
      "process-task",
      {
        taskId: task.id,
        // A cancelled run's session isn't worth resuming; the branch is.
        resumeSessionId:
          task.state === TaskState.CANCELLED ? undefined : (task.sessionId ?? undefined),
        resumePrompt: prompt,
        restartFromBranch: !!task.prUrl,
      },
      { jobId: `${task.id}-mention-${Date.now()}`, attempts: 1 },
    );
    await this.started(task.id, kind);
    this.audit("gitlab_mention.resume", { taskId: task.id, prUrl: task.prUrl ?? undefined });
  }

  private async startWork(
    repoUrl: string,
    actor: Actor,
    cmd: MentionCommand,
    on: "issue" | "mr",
  ): Promise<void> {
    const row = this.row;
    const s = row.subject ?? {};
    if (on === "mr" && cmd.kind === "empty") {
      await this.reply(helpReply(row.authorUsername, this.bot, this.words));
      return this.finish("done", { reason: "help" });
    }
    const workspaceId = this.workspaceId!;
    const agentType = await taskService.resolveTaskAgent({ repoUrl, workspaceId });
    // The person's own work: it runs with their credentials, as from the app.
    const plan = await planNewWork({ owner: "me" }, actor, {
      agentType,
      agentOptions: null,
      runsOn: "pod",
    });
    if (!plan.ok) return this.refuse({ code: "work_refused", message: plan.error });
    const ctx = this.context();
    const prompt =
      on === "issue"
        ? issueTaskPrompt(ctx, cmd.instruction, this.words)
        : mergeRequestTaskPrompt(
            { ...ctx, sourceBranch: s.sourceBranch!, targetBranch: s.targetBranch ?? null },
            cmd.instruction,
            this.words,
          );
    const title =
      on === "issue"
        ? `#${row.noteableIid}: ${titleLine(cmd.instruction || s.title || "issue", 150)}`
        : `${this.words.ref(row.noteableIid)}: ${titleLine(cmd.instruction, 150)}`;

    let task;
    try {
      task = await taskService.submitTask(
        {
          title,
          prompt,
          repoUrl,
          ...(on === "mr" ? { repoBranch: s.sourceBranch! } : {}),
          agentType,
          workspaceId,
          ownerUserId: plan.ownerUserId,
          podSecrets: plan.podSecrets ?? null,
          // A run that fails reports it here; a person retries it or asks again.
          maxRetries: 0,
          metadata: {
            gitlabMention: {
              mentionId: row.id,
              noteUrl: row.noteUrl,
              noteable: row.noteableType,
              iid: row.noteableIid,
            },
          },
        },
        this.userId ?? undefined,
      );
    } catch (err) {
      if (err instanceof taskService.TaskInputError) {
        return this.refuse({ code: "work_refused", message: err.message });
      }
      throw err;
    }
    const kind: StartKind = on === "issue" ? "issue" : "mr";
    await this.started(task.id, kind);
    this.audit("gitlab_mention.start", { taskId: task.id });
  }

  /** The work is under way: record it, say so with its link, and catch a run that already ended. */
  private async started(taskId: string, kind: StartKind): Promise<void> {
    await this.reply(
      ackReply(
        this.row.authorUsername,
        kind,
        taskId,
        publicWebUrl(),
        { sourceBranch: this.row.subject?.sourceBranch },
        this.words,
      ),
    );
    await this.finish("started", { taskId });
    // A run that ended before the row said `started` had nobody to report it.
    const [t] = await db.select({ state: tasks.state }).from(tasks).where(eq(tasks.id, taskId));
    if (t) await onMentionedTaskTransition(taskId, t.state);
  }
}
