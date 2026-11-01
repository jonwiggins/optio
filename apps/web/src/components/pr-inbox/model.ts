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
 * The pull-request panel's view model, apart from React: which rows a view
 * shows, how they group into "whose move" sections, and which buttons a row
 * gets. Pure, so it is unit-tested.
 */

export type PrView = "needs-me" | "mine" | "all";

export const PR_VIEWS: Array<{ value: PrView; label: string }> = [
  { value: "needs-me", label: "Needs me" },
  { value: "mine", label: "Mine" },
  { value: "all", label: "All open" },
];

export function inView(item: PrInboxItem, view: PrView): boolean {
  if (view === "all") return true;
  if (view === "mine") return item.status.role === "author";
  // Your move, plus agents you started: what you'd act on or watch for.
  return prNeedsViewer(item.status);
}

export function viewCounts(items: PrInboxItem[]): Record<PrView, number> {
  return {
    // The actionable number: your move only, the same as the sidebar would show.
    "needs-me": yourMoveCount(items),
    mine: items.filter((i) => inView(i, "mine")).length,
    all: items.length,
  };
}

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

/**
 * "Your move", "Agents on it", "Waiting on others" in that order, each in the
 * server's order (rank, then age). In "All open" someone else's PR that the
 * viewer has no part in sits under Waiting on others too.
 */
export function sections(items: PrInboxItem[], view: PrView): PrSection[] {
  const shown = items.filter((i) => inView(i, view));
  return (["you", "agent", "others"] as const)
    .map((owner) => ({
      owner,
      title: SECTION_TITLE[owner],
      items: shown.filter((i) => i.status.owner === owner),
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

export type RowAction =
  | { kind: "agent"; action: PrAgentAction; label: string; disabled?: string }
  | { kind: "open-task"; taskId: string; label: string }
  | { kind: "open-files"; href: string; label: string }
  | { kind: "optio-review"; label: string }
  | { kind: "open-review"; reviewId: string; label: string }
  | { kind: "merge"; label: string; method: MergeMethod };

export type MergeMethod = "squash" | "merge" | "rebase";

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
export function filesUrl(facts: Pick<PrFacts, "url" | "platform">): string {
  const base = facts.url.replace(/\/+$/, "");
  return facts.platform === "gitlab" ? `${base}/diffs` : `${base}/files`;
}

const AGENT_FOR: Partial<Record<PrActionKind, PrAgentAction>> = {
  fix_ci: "fix_ci",
  address_changes: "address_changes",
  resolve_conflicts: "resolve_conflicts",
  update_branch: "update_branch",
};

const AGENT_LABEL: Record<PrAgentAction, string> = {
  fix_ci: "Fix with agent",
  address_changes: "Address with agent",
  resolve_conflicts: "Resolve with agent",
  update_branch: "Update with agent",
  reply: "Answer with agent",
};

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
  const agentAction = status.role === "author" ? AGENT_FOR[status.action] : undefined;
  if (agentAction) {
    return [
      {
        kind: "agent",
        action: agentAction,
        label: AGENT_LABEL[agentAction],
        disabled: facts.isFork
          ? "It comes from a fork: Optio can't push to its branch"
          : !facts.headBranch
            ? "The platform didn't report the PR's branch"
            : undefined,
      },
    ];
  }
  if (status.action === "reply" && status.role === "author" && agent) {
    return [{ kind: "agent", action: "reply", label: AGENT_LABEL.reply }];
  }
  if (
    status.action === "review" ||
    status.action === "rereview" ||
    status.action === "optio_review_ready" ||
    status.action === "needs_reviewer"
  ) {
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
    const method = mergeMethodFor(facts);
    return [{ kind: "merge", label: "Merge", method }];
  }
  return [];
}

/** The row's main button, if it has one. */
export function primaryAction(item: PrInboxItem): RowAction | null {
  return rowActions(item)[0] ?? null;
}

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

/** The view to open with: Needs me when we know who you are, else everything. */
export function defaultView(res: Pick<PrInboxResponse, "viewer"> | null): PrView {
  return res && res.viewer.handles.length > 0 ? "needs-me" : "all";
}

/** The rows that are the viewer's move (Needs me's own count). */
export function yourMoveCount(items: PrInboxItem[]): number {
  return items.filter((i) => i.status.owner === "you").length;
}
