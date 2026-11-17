import {
  prNeedsViewer,
  type PrActionKind,
  type PrAgentAction,
  type PrFacts,
  type PrInboxItem,
  type PrInboxResponse,
  type PrOwner,
} from "@optio/shared";

/**
 * The pull-request panel's view model, apart from React. Two filters stack:
 *
 * - a **lens**: which PRs, by your relation to them (Needs me, Review
 *   requested, My PRs, Reviewed by me, All on my repos);
 * - a **bucket**: the headline tiles (Ready to merge, CI failing, Needs
 *   rebase, Open comments, Needs review, Agents working), counted within the
 *   lens and clicked to narrow the list.
 *
 * Plus what each row (and each bucket, in bulk) can do. Pure, so it is
 * unit-tested.
 */

const lc = (s: string) => s.toLowerCase();

export function viewerSet(handles: string[]): Set<string> {
  return new Set(handles.map(lc));
}

// ── Lenses ──────────────────────────────────────────────────────────────────

export type PrLens = "needs-me" | "requested" | "mine" | "reviewed" | "all";

export const PR_LENSES: Array<{ value: PrLens; label: string; personal: boolean }> = [
  { value: "needs-me", label: "Needs me", personal: true },
  { value: "requested", label: "Review requested", personal: true },
  { value: "mine", label: "My PRs", personal: true },
  { value: "reviewed", label: "Reviewed by me", personal: true },
  { value: "all", label: "All on my repos", personal: false },
];

const REVIEW_ACTIONS = new Set<PrActionKind>([
  "review",
  "rereview",
  "optio_review_ready",
  "needs_reviewer",
]);

export function inLens(item: PrInboxItem, lens: PrLens, me: Set<string>): boolean {
  const { status, facts } = item;
  switch (lens) {
    case "all":
      return true;
    case "needs-me":
      return prNeedsViewer(status);
    case "mine":
      return status.role === "author";
    case "requested":
      return (
        facts.requestedReviewers.some((r) => me.has(lc(r))) || REVIEW_ACTIONS.has(status.action)
      );
    case "reviewed":
      return status.role !== "author" && facts.reviews.some((r) => me.has(lc(r.author)));
  }
}

export function lensCounts(items: PrInboxItem[], me: Set<string>): Record<PrLens, number> {
  const out = {} as Record<PrLens, number>;
  for (const l of PR_LENSES) {
    // Needs me counts your moves only: the actionable number.
    out[l.value] =
      l.value === "needs-me"
        ? yourMoveCount(items)
        : items.filter((i) => inLens(i, l.value, me)).length;
  }
  return out;
}

// ── Buckets (the headline tiles) ───────────────────────────────────────────

export type PrBucket = "ready" | "ci" | "rebase" | "comments" | "review" | "agents";

export const PR_BUCKETS: Array<{ value: PrBucket; label: string }> = [
  { value: "ready", label: "Ready to merge" },
  { value: "ci", label: "CI failing" },
  { value: "rebase", label: "Needs rebase" },
  { value: "comments", label: "Open comments" },
  { value: "review", label: "Needs review" },
  { value: "agents", label: "Agents working" },
];

const AGENT_ACTIVE = new Set(["pending", "queued", "provisioning", "running"]);

/** Approved, green, mergeable and not a draft: one click from merged. */
export function isReadyToMerge(f: PrFacts): boolean {
  const approved =
    f.reviewDecision === "approved" ||
    (f.reviews.some((r) => r.state === "approved") &&
      !f.reviews.some((r) => r.state === "changes_requested"));
  return (
    !f.draft &&
    approved &&
    f.mergeState === "clean" &&
    (f.checks === "passing" || f.checks === "none")
  );
}

export function inBucket(item: PrInboxItem, bucket: PrBucket): boolean {
  const { facts: f, status, agent } = item;
  switch (bucket) {
    case "ready":
      return isReadyToMerge(f);
    case "ci":
      return f.checks === "failing";
    case "rebase":
      return f.mergeState === "conflict" || f.mergeState === "behind";
    case "comments":
      return (
        f.threads.some((t) => !t.resolved) ||
        status.action === "reply" ||
        status.action === "address_changes"
      );
    case "review":
      return (
        REVIEW_ACTIONS.has(status.action) ||
        (!f.draft && f.reviewDecision === "review_required" && f.checks !== "failing")
      );
    case "agents":
      return !!agent && AGENT_ACTIVE.has(agent.state);
  }
}

export function bucketCounts(items: PrInboxItem[]): Record<PrBucket, number> {
  const out = {} as Record<PrBucket, number>;
  for (const b of PR_BUCKETS) out[b.value] = items.filter((i) => inBucket(i, b.value)).length;
  return out;
}

// ── Sections ───────────────────────────────────────────────────────────────

export interface PrSection {
  owner: PrOwner;
  title: string;
  items: PrInboxItem[];
}

const SECTION_TITLE: Record<PrOwner, string> = {
  you: "Your move",
  agent: "Agents on it",
  others: "Waiting",
};

/** "Your move", "Agents on it", "Waiting", in that order, empty ones dropped. */
export function sections(items: PrInboxItem[]): PrSection[] {
  return (["you", "agent", "others"] as const)
    .map((owner) => ({
      owner,
      title: SECTION_TITLE[owner],
      items: items.filter((i) => i.status.owner === owner),
    }))
    .filter((s) => s.items.length > 0);
}

/** Free-text filter over title, number, repo, author and branch. */
export function matchesQuery(item: PrInboxItem, q: string): boolean {
  const needle = q.trim().toLowerCase().replace(/^#/, "");
  if (!needle) return true;
  const f = item.facts;
  return [f.title, String(f.number), f.repoFullName, f.author, f.headBranch ?? ""].some((s) =>
    s.toLowerCase().includes(needle),
  );
}

// ── Row actions ────────────────────────────────────────────────────────────

export type MergeMethod = "squash" | "merge" | "rebase";
type QuickAction = "update_branch" | "rerun_checks" | "approve";

export type RowAction =
  | { kind: "agent"; action: PrAgentAction; label: string; disabled?: string }
  | { kind: "open-task"; taskId: string; label: string }
  | { kind: "open-files"; href: string; label: string }
  | { kind: "optio-review"; label: string }
  | { kind: "open-review"; reviewId: string; label: string }
  | { kind: "merge"; label: string; method: MergeMethod }
  | { kind: "quick"; action: QuickAction; label: string; disabled?: string }
  | { kind: "copy-link"; label: string };

/** The repo's preferred merge method (squash when it's allowed or unknown). */
export function mergeMethodFor(facts: Pick<PrFacts, "mergeMethods">): MergeMethod {
  return facts.mergeMethods?.[0] ?? "squash";
}

export const MERGE_VERB: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Merge",
  rebase: "Rebase and merge",
};

/** The PR's diff on the platform: where a person reviews it. */
function filesUrl(facts: Pick<PrFacts, "url" | "platform">): string {
  const base = facts.url.replace(/\/+$/, "");
  return facts.platform === "gitlab" ? `${base}/diffs` : `${base}/files`;
}

/** Short labels for a row's button. */
const ROW_AGENT_LABEL: Record<PrAgentAction, string> = {
  fix_ci: "Fix with agent",
  address_changes: "Address with agent",
  resolve_conflicts: "Resolve with agent",
  update_branch: "Update with agent",
  reply: "Answer with agent",
};

/** Longer labels for the menu, where they sit side by side. */
const MENU_AGENT_LABEL: Record<PrAgentAction, string> = {
  fix_ci: "Fix CI with an agent",
  address_changes: "Address the review with an agent",
  resolve_conflicts: "Resolve conflicts with an agent",
  update_branch: "Update the branch with an agent",
  reply: "Answer comments with an agent",
};

const AGENT_FOR: Partial<Record<PrActionKind, PrAgentAction>> = {
  address_changes: "address_changes",
  resolve_conflicts: "resolve_conflicts",
};

function agentBlocked(facts: PrFacts): string | undefined {
  if (facts.isFork) return "It comes from a fork: Optio can't push to its branch";
  if (!facts.headBranch) return "The platform didn't report the PR's branch";
  return undefined;
}

/**
 * The row's buttons, most useful first (at most two): the obvious next step
 * for its action. Reviewing stays a person's job first — the diff — with
 * Optio's review beside it.
 */
export function rowActions(item: PrInboxItem): RowAction[] {
  const { status, facts, agent, optioReview } = item;
  if (agent && (status.action === "agent_working" || status.action === "agent_needs_you")) {
    return [
      {
        kind: "open-task",
        taskId: agent.taskId,
        label: status.action === "agent_needs_you" ? "Open task" : "Watch agent",
      },
    ];
  }
  if (status.role === "author" && status.action === "update_branch") {
    return [{ kind: "quick", action: "update_branch", label: "Update branch" }];
  }
  if (status.role === "author" && status.action === "fix_ci") {
    return [
      {
        kind: "agent",
        action: "fix_ci",
        label: ROW_AGENT_LABEL.fix_ci,
        disabled: agentBlocked(facts),
      },
      { kind: "quick", action: "rerun_checks", label: "Re-run failed" },
    ];
  }
  const agentAction = status.role === "author" ? AGENT_FOR[status.action] : undefined;
  if (agentAction) {
    return [
      {
        kind: "agent",
        action: agentAction,
        label: ROW_AGENT_LABEL[agentAction],
        disabled: agentBlocked(facts),
      },
    ];
  }
  if (status.action === "reply" && status.role === "author" && agent) {
    return [{ kind: "agent", action: "reply", label: ROW_AGENT_LABEL.reply }];
  }
  if (REVIEW_ACTIONS.has(status.action)) {
    const review: RowAction = { kind: "open-files", href: filesUrl(facts), label: "Review" };
    const live = optioReview && !["cancelled", "failed"].includes(optioReview.state);
    return [
      review,
      live
        ? {
            kind: "open-review",
            reviewId: optioReview.id,
            label: optioReview.state === "ready" ? "Optio's draft" : "Optio's review",
          }
        : { kind: "optio-review", label: "Draft with Optio" },
    ];
  }
  if (status.action === "merge") {
    return [{ kind: "merge", label: "Merge", method: mergeMethodFor(facts) }];
  }
  return [];
}

/** The row's main button, if it has one. */
export function primaryAction(item: PrInboxItem): RowAction | null {
  return rowActions(item)[0] ?? null;
}

/**
 * Everything one can do with the PR from here, for the row's "⋯" menu —
 * whatever its state makes possible, whoever's move it is.
 */
export function menuActions(item: PrInboxItem, me: Set<string>): RowAction[] {
  const { facts: f, agent, optioReview, status } = item;
  const out: RowAction[] = [];
  if (agent) out.push({ kind: "open-task", taskId: agent.taskId, label: "Open the Optio task" });
  out.push({ kind: "open-files", href: filesUrl(f), label: "Open the diff" });
  if (isReadyToMerge(f)) {
    const method = mergeMethodFor(f);
    out.push({ kind: "merge", label: MERGE_VERB[method], method });
  }
  if (f.mergeState === "behind") {
    out.push({ kind: "quick", action: "update_branch", label: "Update branch" });
  }
  if (f.checks === "failing") {
    out.push({ kind: "quick", action: "rerun_checks", label: "Re-run failed checks" });
  }
  if (!(agent && AGENT_ACTIVE.has(agent.state))) {
    const blocked = agentBlocked(f);
    const agentRow = (action: PrAgentAction): RowAction => ({
      kind: "agent",
      action,
      label: MENU_AGENT_LABEL[action],
      disabled: blocked,
    });
    if (f.checks === "failing") out.push(agentRow("fix_ci"));
    if (f.mergeState === "conflict") out.push(agentRow("resolve_conflicts"));
    if (f.reviewDecision === "changes_requested" || f.threads.some((t) => !t.resolved)) {
      out.push(agentRow("address_changes"));
    }
  }
  const approvedByMe = f.reviews.some((r) => r.state === "approved" && me.has(lc(r.author)));
  if (status.role !== "author" && !f.draft && !approvedByMe && me.size > 0) {
    out.push({
      kind: "quick",
      action: "approve",
      label: "Approve",
      disabled: f.checks === "failing" ? "CI is failing" : undefined,
    });
  }
  const live = optioReview && !["cancelled", "failed"].includes(optioReview.state);
  out.push(
    live
      ? { kind: "open-review", reviewId: optioReview.id, label: "Open Optio's review" }
      : { kind: "optio-review", label: "Draft a review with Optio" },
  );
  out.push({ kind: "copy-link", label: "Copy link" });
  return out;
}

// ── Bulk actions (on a bucket) ─────────────────────────────────────────────

export type BulkAction =
  | { kind: "merge"; label: string }
  | { kind: "quick"; action: QuickAction; label: string }
  | { kind: "agent"; action: PrAgentAction; label: string }
  | { kind: "optio-review"; label: string };

/** What can be done to every PR in a bucket at once, with the rows each applies to. */
export function bulkActions(
  bucket: PrBucket,
  items: PrInboxItem[],
): Array<{ action: BulkAction; items: PrInboxItem[] }> {
  const pushable = (i: PrInboxItem) =>
    !i.facts.isFork && !!i.facts.headBranch && !(i.agent && AGENT_ACTIVE.has(i.agent.state));
  const out: Array<{ action: BulkAction; items: PrInboxItem[] }> = [];
  const add = (action: BulkAction, rows: PrInboxItem[]) => {
    if (rows.length > 0) out.push({ action, items: rows });
  };
  switch (bucket) {
    case "ready":
      add(
        { kind: "merge", label: "Merge all" },
        items.filter((i) => isReadyToMerge(i.facts)),
      );
      break;
    case "ci":
      add({ kind: "quick", action: "rerun_checks", label: "Re-run failed checks" }, items);
      add({ kind: "agent", action: "fix_ci", label: "Fix with agents" }, items.filter(pushable));
      break;
    case "rebase":
      add(
        { kind: "quick", action: "update_branch", label: "Update branches" },
        items.filter((i) => i.facts.mergeState === "behind"),
      );
      add(
        { kind: "agent", action: "resolve_conflicts", label: "Resolve conflicts with agents" },
        items.filter((i) => i.facts.mergeState === "conflict" && pushable(i)),
      );
      break;
    case "review":
      add(
        { kind: "optio-review", label: "Draft reviews with Optio" },
        items.filter(
          (i) => !i.optioReview || ["cancelled", "failed"].includes(i.optioReview.state),
        ),
      );
      break;
    case "comments":
      add(
        { kind: "agent", action: "address_changes", label: "Address with agents" },
        items.filter((i) => i.status.role === "author" && pushable(i)),
      );
      break;
    case "agents":
      break;
  }
  return out;
}

// ── Misc ───────────────────────────────────────────────────────────────────

/** The rows' age in a compact form: 40m, 3h, 2d, 5w. */
export function shortAge(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const ms = Math.max(0, now - new Date(iso).getTime());
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

/** The lens to open with: Needs me when we know who you are, else everything. */
export function defaultLens(res: Pick<PrInboxResponse, "viewer"> | null): PrLens {
  return res && res.viewer.handles.length > 0 ? "needs-me" : "all";
}

/** The rows that are the viewer's move (Needs me's own count). */
function yourMoveCount(items: PrInboxItem[]): number {
  return items.filter((i) => i.status.owner === "you").length;
}
