import type { ComponentType } from "react";
import { Bot, Sparkles } from "lucide-react";
import {
  OctAlert,
  OctCheck,
  OctCheckCircleFill,
  OctCodeReview,
  OctCommentDiscussion,
  OctDotFill,
  OctEye,
  OctFileDiff,
  OctGitCompare,
  OctGitMerge,
  OctLock,
  OctPerson,
  OctPullRequestDraft,
  OctSkip,
  OctXCircleFill,
} from "./octicons";
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
  fix_ci: { icon: OctXCircleFill, tone: "urgent" },
  address_changes: { icon: OctFileDiff, tone: "act" },
  resolve_conflicts: { icon: OctAlert, tone: "urgent" },
  reply: { icon: OctCommentDiscussion, tone: "act" },
  review: { icon: OctCodeReview, tone: "act" },
  optio_review_ready: { icon: Sparkles, tone: "act" },
  rereview: { icon: OctCodeReview, tone: "act" },
  needs_reviewer: { icon: OctPerson, tone: "act" },
  merge: { icon: OctGitMerge, tone: "ready" },
  update_branch: { icon: OctGitCompare, tone: "act" },
  request_review: { icon: OctPerson, tone: "act" },
  draft: { icon: OctPullRequestDraft, tone: "wait" },
  agent_working: { icon: Bot, tone: "agent" },
  wait_ci: { icon: OctDotFill, tone: "wait" },
  wait_review: { icon: OctDotFill, tone: "wait" },
  wait_author: { icon: OctDotFill, tone: "wait" },
  watching: { icon: OctEye, tone: "quiet" },
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

type ChipTone = "good" | "bad" | "warn" | "neutral";

const CHIP_TONE: Record<ChipTone, string> = {
  good: "text-success border-success/25 bg-success/5",
  bad: "text-error border-error/25 bg-error/5",
  warn: "text-warning border-warning/30 bg-warning/5",
  neutral: "text-text-muted border-border bg-bg",
};

/**
 * One fact about the PR as a small labelled chip: an icon plus a word or two
 * ("CI passing", "Approved", "2 open threads"), so it reads without hovering
 * and never by colour alone. `title` carries the longer version.
 */
function Chip({
  icon: Icon,
  tone,
  text,
  title,
  spin,
}: {
  icon: ComponentType<{ className?: string }>;
  tone: ChipTone;
  text: string;
  title?: string;
  spin?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[11px] leading-4 whitespace-nowrap",
        CHIP_TONE[tone],
      )}
      title={title ?? text}
    >
      <Icon className={cn("w-3 h-3 shrink-0", spin && "animate-spin [animation-duration:2.5s]")} />
      {text}
    </span>
  );
}

/**
 * CI always (it decides most moves), then review state, merge state and open
 * threads only when they say something.
 */
export function Signals({ facts, className }: { facts: PrFacts; className?: string }) {
  const open = facts.threads.filter((t) => !t.resolved).length;
  const approvers = facts.reviews.filter((r) => r.state === "approved").map((r) => `@${r.author}`);
  const requesters = facts.reviews
    .filter((r) => r.state === "changes_requested")
    .map((r) => `@${r.author}`);
  const failing = facts.failingChecks;
  return (
    <div className={cn("flex-wrap items-center gap-1.5", className)} data-testid="pr-signals">
      {facts.checks === "passing" && (
        <Chip icon={OctCheckCircleFill} tone="good" text="CI passing" />
      )}
      {facts.checks === "failing" && (
        <Chip
          icon={OctXCircleFill}
          tone="bad"
          text={failing.length > 1 ? `CI: ${failing.length} failing` : "CI failing"}
          title={failing.length ? `Failing: ${failing.join(", ")}` : "CI failing"}
        />
      )}
      {facts.checks === "pending" && <Chip icon={OctDotFill} tone="warn" text="CI running" />}
      {facts.checks === "none" && <Chip icon={OctSkip} tone="neutral" text="No CI" />}

      {facts.reviewDecision === "changes_requested" || requesters.length > 0 ? (
        <Chip
          icon={OctFileDiff}
          tone="bad"
          text="Changes requested"
          title={requesters.length ? `Changes requested by ${requesters.join(", ")}` : undefined}
        />
      ) : facts.reviewDecision === "approved" || approvers.length > 0 ? (
        <Chip
          icon={OctCheck}
          tone="good"
          text={approvers.length > 1 ? `Approved ×${approvers.length}` : "Approved"}
          title={approvers.length ? `Approved by ${approvers.join(", ")}` : undefined}
        />
      ) : null}

      {facts.mergeState === "conflict" ? (
        <Chip
          icon={OctAlert}
          tone="bad"
          text="Conflicts"
          title="Merge conflicts with the base branch"
        />
      ) : facts.mergeState === "behind" ? (
        <Chip
          icon={OctGitCompare}
          tone="warn"
          text="Behind base"
          title="Branch rules require it to be up to date"
        />
      ) : facts.mergeState === "blocked" ? (
        <Chip icon={OctLock} tone="neutral" text="Blocked" title="Blocked by branch rules" />
      ) : null}

      {open > 0 && (
        <Chip
          icon={OctCommentDiscussion}
          tone="neutral"
          text={`${open} open thread${open === 1 ? "" : "s"}`}
        />
      )}
    </div>
  );
}
