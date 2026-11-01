import type { ComponentType } from "react";
import {
  AlertOctagon,
  ArrowDownToLine,
  Bot,
  Check,
  CircleDashed,
  CircleDot,
  Lock,
  Minus,
  ScanEye,
  Sparkles,
  UserSearch,
  FilePen,
  GitMerge,
  GitPullRequestDraft,
  Hourglass,
  MessageSquare,
  MessageSquareReply,
  RefreshCw,
  Swords,
  ThumbsDown,
  ThumbsUp,
  UserPlus,
  Wrench,
  X,
} from "lucide-react";
import type { PrActionKind, PrFacts, PrInboxStatus } from "@optio/shared";
import { cn } from "@/lib/utils";

/**
 * The row's two visual parts: the action badge (whose move, what it is) and
 * the quiet signal strip (CI, reviews, merge state, open threads) that
 * explains it at a glance.
 */

type Tone = "urgent" | "act" | "ready" | "agent" | "wait" | "quiet";

const TONE: Record<Tone, string> = {
  urgent: "border-error/30 bg-error/10 text-error",
  act: "border-primary/30 bg-primary/10 text-primary",
  ready: "border-success/30 bg-success/10 text-success",
  agent: "border-info/30 bg-info/10 text-info",
  wait: "border-border bg-bg text-text-muted",
  quiet: "border-transparent bg-transparent text-text-muted/80",
};

const ACTION: Record<PrActionKind, { icon: ComponentType<{ className?: string }>; tone: Tone }> = {
  agent_needs_you: { icon: Bot, tone: "urgent" },
  fix_ci: { icon: Wrench, tone: "urgent" },
  address_changes: { icon: FilePen, tone: "act" },
  resolve_conflicts: { icon: Swords, tone: "urgent" },
  reply: { icon: MessageSquareReply, tone: "act" },
  review: { icon: ScanEye, tone: "act" },
  optio_review_ready: { icon: Sparkles, tone: "act" },
  rereview: { icon: RefreshCw, tone: "act" },
  needs_reviewer: { icon: UserSearch, tone: "act" },
  merge: { icon: GitMerge, tone: "ready" },
  update_branch: { icon: ArrowDownToLine, tone: "act" },
  request_review: { icon: UserPlus, tone: "act" },
  draft: { icon: GitPullRequestDraft, tone: "wait" },
  agent_working: { icon: Bot, tone: "agent" },
  wait_ci: { icon: CircleDashed, tone: "wait" },
  wait_review: { icon: Hourglass, tone: "wait" },
  wait_author: { icon: Hourglass, tone: "wait" },
  watching: { icon: CircleDot, tone: "quiet" },
};

export function ActionBadge({ status }: { status: PrInboxStatus }) {
  const a = ACTION[status.action];
  const tone: Tone = status.stale && a.tone === "wait" ? "wait" : a.tone;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE[tone],
        status.stale && "border-warning/40 text-warning",
      )}
      data-testid="pr-action"
    >
      <a.icon
        className={cn("w-3.5 h-3.5 shrink-0", status.action === "agent_working" && "animate-pulse")}
      />
      {status.label}
      {status.stale && <span className="sr-only"> (stale)</span>}
    </span>
  );
}

function Signal({
  icon: Icon,
  label,
  className,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} title={label}>
      <Icon className="w-3.5 h-3.5" />
      {children}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * CI always (it decides most moves); reviews, merge state and open threads
 * only when they say something. Each is an icon with a visible count where
 * one applies and its meaning for screen readers and on hover.
 */
export function Signals({ facts, className }: { facts: PrFacts; className?: string }) {
  const open = facts.threads.filter((t) => !t.resolved).length;
  const approvals = facts.reviews.filter((r) => r.state === "approved").length;
  return (
    <div
      className={cn("items-center gap-2.5 text-text-muted text-[11px] tabular-nums", className)}
      data-testid="pr-signals"
    >
      {facts.checks === "passing" && (
        <Signal icon={Check} label="Checks passing" className="text-success" />
      )}
      {facts.checks === "failing" && (
        <Signal
          icon={X}
          label={`Checks failing${facts.failingChecks.length ? `: ${facts.failingChecks.join(", ")}` : ""}`}
          className="text-error"
        />
      )}
      {facts.checks === "pending" && (
        <Signal icon={CircleDashed} label="Checks running" className="text-warning" />
      )}
      {facts.checks === "none" && <Signal icon={Minus} label="No checks" />}

      {facts.reviewDecision === "changes_requested" ? (
        <Signal icon={ThumbsDown} label="Changes requested" className="text-error" />
      ) : facts.reviewDecision === "approved" || approvals > 0 ? (
        <Signal
          icon={ThumbsUp}
          label={`Approved${approvals > 1 ? ` by ${approvals}` : ""}`}
          className="text-success"
        >
          {approvals > 1 ? approvals : null}
        </Signal>
      ) : null}

      {facts.mergeState === "conflict" ? (
        <Signal icon={AlertOctagon} label="Merge conflicts" className="text-error" />
      ) : facts.mergeState === "behind" ? (
        <Signal icon={ArrowDownToLine} label="Behind the base branch" className="text-warning" />
      ) : facts.mergeState === "blocked" ? (
        <Signal icon={Lock} label="Blocked by branch rules" />
      ) : null}

      {open > 0 && (
        <Signal icon={MessageSquare} label={`${open} unresolved thread${open === 1 ? "" : "s"}`}>
          {open}
        </Signal>
      )}
    </div>
  );
}
