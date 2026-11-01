/**
 * The pull-request panel's one question: whose move is it, and what is it?
 *
 * The git platforms give us facts (checks, reviews, threads, merge state);
 * `derivePrStatus` turns them into one next action for one viewer, and who
 * owns that action: the viewer, an Optio agent, or somebody else. Pure, so
 * the web, the mobile apps and the controller MCP all agree on it.
 */

export type PrPlatform = "github" | "gitlab" | "codecommit";
export type PrChecks = "passing" | "failing" | "pending" | "none";
/**
 * - `clean`: mergeable as far as the platform can tell
 * - `behind`: the base moved and branch rules require the head to be up to date
 * - `conflict`: it can't merge until conflicts are resolved
 * - `blocked`: branch rules block it (required reviews / checks)
 * - `unknown`: the platform hasn't computed it yet
 */
export type PrMergeState = "clean" | "behind" | "conflict" | "blocked" | "unknown";
export type PrReviewDecision = "approved" | "changes_requested" | "review_required" | "none";
export type PrReviewFactState = "approved" | "changes_requested" | "commented" | "dismissed";

export interface PrReviewFact {
  author: string;
  state: PrReviewFactState;
  submittedAt: string;
}

/** A review (diff) thread. */
export interface PrThreadFact {
  resolved: boolean;
  /** Everyone who wrote in the thread, the opener first. */
  participants: string[];
  lastAuthor: string;
  lastAt: string;
  path?: string | null;
}

/** A conversation comment on the PR itself. */
export interface PrCommentFact {
  author: string;
  at: string;
  /** Handles @-mentioned in the comment (no `@`). */
  mentions: string[];
}

/** What a git platform tells us about one open PR. */
export interface PrFacts {
  url: string;
  number: number;
  title: string;
  platform: PrPlatform;
  repoFullName: string;
  author: string;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  headBranch: string | null;
  baseBranch: string | null;
  headSha: string | null;
  /** The head lives in another repository (a fork): Optio can't push to it. */
  isFork: boolean;
  /** When the head last moved (last commit / push), if known. */
  lastPushAt: string | null;
  checks: PrChecks;
  /** Names of the failing checks, when `checks` is "failing". */
  failingChecks: string[];
  mergeState: PrMergeState;
  reviewDecision: PrReviewDecision;
  /** The latest review per author. */
  reviews: PrReviewFact[];
  requestedReviewers: string[];
  /** Team review requests (`org/team`). */
  requestedTeams: string[];
  assignees: string[];
  threads: PrThreadFact[];
  /** Recent conversation comments, oldest first. */
  comments: PrCommentFact[];
  /** Handles @-mentioned in the description. */
  bodyMentions: string[];
  additions?: number;
  deletions?: number;
  /** The merge methods the repository allows, preferred first (GitHub). */
  mergeMethods?: Array<"squash" | "merge" | "rebase">;
}

/** An Optio task that works on the PR. */
export interface PrAgentLink {
  taskId: string;
  title: string;
  /** The task's state (`running`, `pr_opened`, `needs_attention`, …). */
  state: string;
  /** The viewer started it: an agent's PR counts as the viewer's own. */
  startedByViewer: boolean;
}

/** Optio's own review of the PR, if there is one. */
export interface PrOptioReview {
  id: string;
  state: string;
  verdict: string | null;
}

export type PrRole = "author" | "reviewer" | "assignee" | "mentioned" | "none";
export type PrOwner = "you" | "agent" | "others";
export type PrActionKind =
  // the viewer's move
  | "agent_needs_you"
  | "fix_ci"
  | "address_changes"
  | "resolve_conflicts"
  | "reply"
  | "review"
  | "rereview"
  | "optio_review_ready"
  | "merge"
  | "update_branch"
  | "request_review"
  | "needs_reviewer"
  // an agent's
  | "agent_working"
  // somebody else's
  | "wait_ci"
  | "wait_review"
  | "wait_author"
  | "draft"
  | "watching";

export interface PrInboxStatus {
  role: PrRole;
  owner: PrOwner;
  action: PrActionKind;
  /** The action in a word or two ("Fix CI"). */
  label: string;
  /** Why, in one short line ("2 failing: lint, e2e"). */
  detail: string;
  /** When this state began, as best we can tell (the clock the row shows). */
  since: string | null;
  /** Sort order: lower comes first. */
  rank: number;
  /**
   * Waiting too long: the viewer's move for over a day (`PR_YOUR_MOVE_STALE_MS`),
   * someone else's for over two (`PR_STALE_AFTER_MS`).
   */
  stale: boolean;
}

export interface PrViewer {
  /** The viewer's handles on the platforms (GitHub login, GitLab username). */
  handles: string[];
}

export const PR_STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
export const PR_YOUR_MOVE_STALE_MS = 24 * 60 * 60 * 1000;
/** An outside contribution with no reviewer for this long needs someone to pick it up. */
export const PR_TRIAGE_AFTER_MS = 4 * 60 * 60 * 1000;

const RANK: Record<PrActionKind, number> = {
  agent_needs_you: 10,
  fix_ci: 20,
  address_changes: 25,
  resolve_conflicts: 30,
  reply: 35,
  review: 40,
  optio_review_ready: 42,
  rereview: 45,
  merge: 50,
  update_branch: 55,
  needs_reviewer: 47,
  request_review: 60,
  agent_working: 80,
  draft: 85,
  wait_ci: 90,
  wait_review: 92,
  wait_author: 94,
  watching: 99,
};

const LABEL: Record<PrActionKind, string> = {
  agent_needs_you: "Agent needs you",
  fix_ci: "Fix CI",
  address_changes: "Address changes",
  resolve_conflicts: "Resolve conflicts",
  reply: "Reply",
  review: "Review",
  optio_review_ready: "Optio review ready",
  rereview: "Re-review",
  merge: "Merge",
  update_branch: "Update branch",
  request_review: "Request review",
  needs_reviewer: "Needs a reviewer",
  draft: "Draft",
  agent_working: "Agent working",
  wait_ci: "CI running",
  wait_review: "Awaiting review",
  wait_author: "Author's move",
  watching: "Watching",
};

export const PR_ACTION_LABELS: Readonly<Record<PrActionKind, string>> = LABEL;

const AGENT_ACTIVE = new Set(["pending", "queued", "provisioning", "running"]);

/** CI bots, dependency bots, coverage reporters: their comments never need a reply. */
export function isBotHandle(handle: string): boolean {
  return /\[bot\]$|(^|[-_])bot$|^(dependabot|renovate|codecov|github-actions|sonarcloud|vercel|netlify)/i.test(
    handle,
  );
}

const lc = (s: string) => s.toLowerCase();
const time = (s: string | null | undefined) => (s ? new Date(s).getTime() || 0 : 0);
const latest = (...ts: Array<string | null | undefined>) =>
  ts.reduce<string | null>((a, b) => (b && time(b) > time(a) ? b : a), null);
const at = (h: string) => `@${h}`;

function people(handles: string[], max = 2): string {
  const named = handles.slice(0, max).map(at).join(", ");
  return handles.length > max ? `${named} +${handles.length - max}` : named;
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The viewer's relation to the PR. An agent the viewer started makes them its author. */
export function prRole(facts: PrFacts, viewer: PrViewer, agent?: PrAgentLink | null): PrRole {
  const me = new Set(viewer.handles.map(lc));
  const isMe = (h: string) => me.has(lc(h));
  if (isMe(facts.author) || agent?.startedByViewer) return "author";
  if (facts.requestedReviewers.some(isMe) || facts.reviews.some((r) => isMe(r.author))) {
    return "reviewer";
  }
  if (facts.assignees.some(isMe)) return "assignee";
  if (
    facts.bodyMentions.some(isMe) ||
    facts.comments.some((c) => c.mentions.some(isMe)) ||
    facts.threads.some((t) => t.participants.some(isMe))
  ) {
    return "mentioned";
  }
  return "none";
}

/**
 * The next action on `facts` for `viewer`, in priority order: the first
 * thing that applies wins. See the comments inline for each rule.
 */
export function derivePrStatus(
  facts: PrFacts,
  viewer: PrViewer,
  opts: { agent?: PrAgentLink | null; optioReview?: PrOptioReview | null; now?: number } = {},
): PrInboxStatus {
  const now = opts.now ?? Date.now();
  const me = new Set(viewer.handles.map(lc));
  const isMe = (h: string) => me.has(lc(h));
  const agent = opts.agent ?? null;
  const role = prRole(facts, viewer, agent);

  const make = (
    action: PrActionKind,
    detail: string,
    since: string | null,
    owner?: PrOwner,
    label?: string,
  ): PrInboxStatus => {
    const o: PrOwner =
      owner ??
      (action === "agent_working" ? "agent" : RANK[action] < RANK.agent_working ? "you" : "others");
    const waited = since ? now - time(since) : 0;
    return {
      role,
      owner: o,
      action,
      label: label ?? LABEL[action],
      detail,
      since,
      rank: RANK[action],
      stale:
        action !== "watching" &&
        action !== "draft" &&
        (o === "you"
          ? waited > PR_YOUR_MOVE_STALE_MS
          : o === "others" && waited > PR_STALE_AFTER_MS),
    };
  };

  // ── An Optio agent on it ───────────────────────────────────────────────
  // The task title often is the PR title: say what the agent is doing instead.
  const sameTitle = (t: string) => t.trim().toLowerCase() === facts.title.trim().toLowerCase();
  if (agent && AGENT_ACTIVE.has(agent.state)) {
    const doing =
      agent.state === "running"
        ? "Running now"
        : agent.state === "provisioning"
          ? "Starting up"
          : "Queued";
    return make(
      "agent_working",
      sameTitle(agent.title) ? doing : `${doing}: ${agent.title}`,
      facts.updatedAt,
      "agent",
    );
  }
  // Only the person who started it is asked: someone else's stuck agent isn't your move.
  if (agent && agent.state === "needs_attention" && agent.startedByViewer) {
    return make(
      "agent_needs_you",
      sameTitle(agent.title) ? "The agent stopped and is waiting for you" : agent.title,
      facts.updatedAt,
      "you",
    );
  }

  // The viewer's latest word anywhere on the PR: replies are judged against it.
  const myLastWord = latest(
    ...facts.reviews.filter((r) => isMe(r.author)).map((r) => r.submittedAt),
    ...facts.comments.filter((c) => isMe(c.author)).map((c) => c.at),
    ...facts.threads.filter((t) => isMe(t.lastAuthor)).map((t) => t.lastAt),
  );

  /** Unresolved threads the viewer is in (or owns, as author) where someone else spoke last. */
  const unansweredThreads = facts.threads.filter(
    (t) =>
      !t.resolved &&
      !isMe(t.lastAuthor) &&
      !isBotHandle(t.lastAuthor) &&
      (role === "author" || t.participants.some(isMe)),
  );
  /** Conversation comments after the viewer's last word that are for them. */
  const unansweredComments = facts.comments.filter(
    (c) =>
      !isMe(c.author) &&
      !isBotHandle(c.author) &&
      time(c.at) > time(myLastWord) &&
      (c.mentions.some(isMe) || role === "author"),
  );
  const replyStatus = (): PrInboxStatus | null => {
    const n = unansweredThreads.length + unansweredComments.length;
    if (n === 0) return null;
    const who = [
      ...new Set([
        ...unansweredThreads.map((t) => t.lastAuthor),
        ...unansweredComments.map((c) => c.author),
      ]),
    ];
    const where =
      unansweredThreads.length > 0 && unansweredComments.length === 0
        ? ` on ${plural(unansweredThreads.length, "thread")}`
        : unansweredComments.some((c) => c.mentions.some(isMe)) && unansweredThreads.length === 0
          ? " mentioned you"
          : "";
    const verb = where === " mentioned you" ? "" : " replied";
    const since = latest(
      ...unansweredThreads.map((t) => t.lastAt),
      ...unansweredComments.map((c) => c.at),
    );
    return make("reply", `${people(who)}${verb}${where}`, since);
  };

  if (role === "author") {
    // Checks first: nothing else matters while CI is red.
    if (facts.checks === "failing") {
      const names = facts.failingChecks;
      const detail =
        names.length === 0
          ? "Checks failing"
          : `${names.length} failing: ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""}`;
      return make("fix_ci", detail, facts.lastPushAt ?? facts.updatedAt);
    }
    if (facts.draft) {
      // A draft is still being worked on: not a move anyone is waiting for.
      return make("draft", "Mark it ready for review when it's done", facts.createdAt);
    }
    if (facts.mergeState === "conflict") {
      return make(
        "resolve_conflicts",
        `Conflicts with ${facts.baseBranch ?? "the base branch"}`,
        facts.updatedAt,
      );
    }
    // Changes requested and not pushed since: the author owes a revision.
    const blocking = facts.reviews
      .filter((r) => r.state === "changes_requested")
      .sort((a, b) => time(b.submittedAt) - time(a.submittedAt));
    const pendingRequest = blocking.filter((r) => time(r.submittedAt) >= time(facts.lastPushAt));
    if (pendingRequest.length > 0) {
      return make(
        "address_changes",
        `${people(pendingRequest.map((r) => r.author))} requested changes`,
        pendingRequest[0].submittedAt,
      );
    }
    const reply = replyStatus();
    if (reply) return reply;
    if (facts.mergeState === "behind") {
      return make(
        "update_branch",
        `Behind ${facts.baseBranch ?? "the base branch"}`,
        facts.updatedAt,
      );
    }
    if (facts.checks === "pending") {
      return make("wait_ci", "Checks running", facts.lastPushAt ?? facts.updatedAt);
    }
    const approvals = facts.reviews.filter((r) => r.state === "approved");
    if (facts.reviewDecision === "approved" || (approvals.length > 0 && blocking.length === 0)) {
      if (facts.mergeState === "blocked") {
        return make(
          "wait_review",
          "Approved, but branch rules still block it",
          latest(...approvals.map((r) => r.submittedAt)),
        );
      }
      if (facts.mergeState !== "clean") {
        return make(
          "wait_ci",
          "Approved · checking it can merge",
          latest(...approvals.map((r) => r.submittedAt)),
          undefined,
          "Checking",
        );
      }
      const ci = facts.checks === "passing" ? " · CI green" : "";
      return make(
        "merge",
        `Approved by ${people(approvals.map((r) => r.author))}${ci}`,
        latest(...approvals.map((r) => r.submittedAt)),
      );
    }
    if (blocking.length > 0) {
      // Changes were requested and the author pushed since.
      return make(
        "wait_review",
        `Pushed — waiting on ${people(blocking.map((r) => r.author))} to re-review`,
        facts.lastPushAt,
      );
    }
    if (facts.requestedReviewers.length > 0 || facts.requestedTeams.length > 0) {
      return make(
        "wait_review",
        `Waiting on ${people([...facts.requestedReviewers, ...facts.requestedTeams])}`,
        facts.lastPushAt ?? facts.createdAt,
      );
    }
    if (facts.reviews.length > 0) {
      return make(
        "wait_review",
        `Commented on by ${people(facts.reviews.map((r) => r.author))}`,
        latest(...facts.reviews.map((r) => r.submittedAt)),
      );
    }
    return make("request_review", "No reviewers yet", facts.createdAt);
  }

  if (role === "reviewer") {
    const mine = facts.reviews
      .filter((r) => isMe(r.author))
      .sort((a, b) => time(b.submittedAt) - time(a.submittedAt))[0];
    const requested = facts.requestedReviewers.some(isMe);
    const draftReady = opts.optioReview?.state === "ready";
    // Many teams don't review a red PR: it's the author's move until CI passes.
    if (requested && facts.checks === "failing") {
      return make(
        "wait_author",
        mine ? "Asked again · CI failing" : "Review requested · CI failing",
        facts.lastPushAt ?? facts.updatedAt,
      );
    }
    if (requested && !mine) {
      if (draftReady) {
        return make(
          "optio_review_ready",
          `@${facts.author} asked you · draft waiting`,
          facts.updatedAt,
        );
      }
      return make("review", `Requested by @${facts.author}`, facts.createdAt);
    }
    if (requested && mine) {
      return make("rereview", `@${facts.author} asked again`, facts.lastPushAt ?? facts.updatedAt);
    }
    const reply = replyStatus();
    if (reply) return reply;
    if (mine?.state === "changes_requested") {
      if (time(facts.lastPushAt) > time(mine.submittedAt)) {
        // Pushed since — but a re-review is only due once CI has had its say.
        if (facts.checks === "failing") {
          return make("wait_author", "Pushed since your review · CI failing", facts.lastPushAt);
        }
        if (facts.checks === "pending") {
          return make(
            "wait_ci",
            "Pushed since your review · re-review when CI finishes",
            facts.lastPushAt,
          );
        }
        return make("rereview", "New commits since you requested changes", facts.lastPushAt);
      }
      return make("wait_author", "You requested changes", mine.submittedAt);
    }
    if (mine?.state === "approved") {
      // A contributor's fork PR can't be merged by its author: the
      // maintainer who approved it is the one to merge it once it's green.
      if (
        facts.isFork &&
        facts.reviewDecision === "approved" &&
        (facts.checks === "passing" || facts.checks === "none") &&
        facts.mergeState === "clean"
      ) {
        return make(
          "merge",
          `You approved @${facts.author}'s PR · ready to merge`,
          mine.submittedAt,
        );
      }
      return make("watching", "You approved", mine.submittedAt);
    }
    return make("watching", "You commented", mine?.submittedAt ?? facts.updatedAt);
  }

  if (role === "assignee" || role === "mentioned") {
    const reply = replyStatus();
    if (reply) return reply;
    return make(
      "watching",
      role === "assignee" ? "Assigned to you" : `You're in the conversation`,
      facts.updatedAt,
    );
  }

  // An outside contribution nobody has picked up gets lost otherwise.
  if (
    facts.isFork &&
    !facts.draft &&
    facts.requestedReviewers.length === 0 &&
    facts.requestedTeams.length === 0 &&
    facts.reviews.length === 0 &&
    now - time(facts.createdAt) > PR_TRIAGE_AFTER_MS
  ) {
    return make("needs_reviewer", `Outside contribution from @${facts.author}`, facts.createdAt);
  }
  if (agent && agent.state === "needs_attention") {
    return make(
      "watching",
      "Its Optio agent is waiting for whoever started it",
      facts.updatedAt,
      undefined,
      "Agent waiting",
    );
  }
  // Not the viewer's PR: the badge reads its plain state.
  return make("watching", "", facts.updatedAt, undefined, watchingDetail(facts));
}

/** The status line for a PR the viewer isn't part of: a plain read of its state. */
function watchingDetail(facts: PrFacts): string {
  if (facts.draft) return "Draft";
  if (facts.checks === "failing") return "CI failing";
  if (facts.mergeState === "conflict") return "Has conflicts";
  if (facts.reviewDecision === "changes_requested") return "Changes requested";
  if (facts.reviewDecision === "approved") return "Approved";
  if (facts.checks === "pending") return "CI running";
  return "Open";
}

/** Whether the row belongs in "Needs me": the viewer's move, or their own agent at work. */
export function prNeedsViewer(status: PrInboxStatus): boolean {
  return status.owner === "you" || (status.owner === "agent" && status.role === "author");
}

/** Sort for a section: by action, then the longest-waiting first. */
export function comparePrInboxItems(
  a: { status: PrInboxStatus; facts: Pick<PrFacts, "updatedAt"> },
  b: { status: PrInboxStatus; facts: Pick<PrFacts, "updatedAt"> },
): number {
  if (a.status.rank !== b.status.rank) return a.status.rank - b.status.rank;
  if (a.status.owner === "others" || a.status.action === "watching") {
    return time(b.facts.updatedAt) - time(a.facts.updatedAt);
  }
  return time(a.status.since) - time(b.status.since);
}

/** Handles @-mentioned in markdown text, without code spans / blocks or email addresses. */
export function extractMentions(text: string | null | undefined): string[] {
  if (!text) return [];
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  const out = new Set<string>();
  for (const m of prose.matchAll(
    /(^|[^\w@./-])@([a-z\d](?:[a-z\d-]|[._](?=[a-z\d])){0,38})(?![\w-]*@)/gi,
  )) {
    out.add(m[2]);
  }
  return [...out];
}
