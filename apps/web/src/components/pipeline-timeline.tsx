import { useState } from "react";
import { EventTimeline } from "./event-timeline.js";
import { cn, formatRelativeTime, formatDuration } from "@/lib/utils";
import {
  Clock,
  Server,
  Code,
  GitPullRequest,
  CheckCircle2,
  Eye,
  RotateCcw,
  GitMerge,
  CircleCheckBig,
  XCircle,
  Ban,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StageStatus = "completed" | "active" | "upcoming" | "failed" | "cancelled" | "skipped";

export interface PipelineStage {
  id: string;
  label: string;
  status: StageStatus;
  icon: LucideIcon;
  timestamp?: string;
  duration?: string;
  detail?: string;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Stage derivation
// ---------------------------------------------------------------------------

const FIXUP_TRIGGERS = new Set([
  "auto_resume_review",
  "auto_resume_ci_fix",
  "auto_resume_conflicts",
  "review_changes_requested",
  "ci_failing",
  "merge_conflicts",
]);

function derivePipelineStages(task: any, events: any[], subtasks: any[]): PipelineStage[] {
  // --- helpers ---
  const findEvent = (pred: (e: any) => boolean) => events.find(pred);
  const findEventReverse = (pred: (e: any) => boolean) => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (pred(events[i])) return events[i];
    }
    return undefined;
  };

  const isReviewTask = task.taskType === "review";

  // Count fixup iterations (needs_attention events that occurred after first pr_opened)
  const firstPrEvent = findEvent((e: any) => e.toState === "pr_opened");
  const fixupEvents = firstPrEvent
    ? events.filter(
        (e: any) =>
          e.toState === "needs_attention" &&
          new Date(e.createdAt) > new Date(firstPrEvent.createdAt),
      )
    : [];
  const fixupCount = fixupEvents.length;

  // Did the task ever reach pr_opened?
  const hadPr = !!task.prUrl || !!firstPrEvent;
  // Is the task currently in a fixup cycle? (running/queued/provisioning after having been in pr_opened)
  const isInFixup =
    hadPr && fixupCount > 0 && ["queued", "provisioning", "running"].includes(task.state);

  // Has review activity?
  const hasReview =
    (task.prReviewStatus && task.prReviewStatus !== "none") ||
    subtasks.some((s: any) => s.taskType === "review");

  // Was the task completed via merge?
  const wasMerged =
    task.prState === "merged" ||
    !!findEvent((e: any) => e.trigger === "pr_merged" || e.trigger === "auto_merged");

  // --- Build stages ---
  const stages: PipelineStage[] = [];

  // Event timestamps for computing durations
  const queuedEvent = findEvent((e: any) => e.toState === "queued");
  const provisioningEvent = findEvent((e: any) => e.toState === "provisioning");
  const runningEvent = findEvent((e: any) => e.toState === "running");
  const completedEvent = findEventReverse(
    (e: any) => e.toState === "completed" || e.toState === "failed" || e.toState === "cancelled",
  );

  if (isReviewTask) {
    // Simplified pipeline for review tasks
    stages.push(
      {
        id: "queued",
        label: "Queued",
        icon: Clock,
        status: "upcoming",
        timestamp: queuedEvent?.createdAt,
      },
      {
        id: "setup",
        label: "Setup",
        icon: Server,
        status: "upcoming",
        timestamp: provisioningEvent?.createdAt,
        duration:
          provisioningEvent && runningEvent
            ? formatDuration(provisioningEvent.createdAt, runningEvent.createdAt)
            : undefined,
      },
      {
        id: "reviewing",
        label: "Reviewing",
        icon: Eye,
        status: "upcoming",
        timestamp: runningEvent?.createdAt,
      },
      {
        id: "done",
        label: "Done",
        icon: CircleCheckBig,
        status: "upcoming",
        timestamp: completedEvent?.createdAt,
      },
    );
  } else {
    // Full coding pipeline
    stages.push(
      {
        id: "queued",
        label: "Queued",
        icon: Clock,
        status: "upcoming",
        timestamp: queuedEvent?.createdAt,
      },
      {
        id: "setup",
        label: "Setup",
        icon: Server,
        status: "upcoming",
        timestamp: provisioningEvent?.createdAt,
        duration:
          provisioningEvent && runningEvent
            ? formatDuration(provisioningEvent.createdAt, runningEvent.createdAt)
            : undefined,
      },
      {
        id: "coding",
        label: "Running",
        icon: Code,
        status: "upcoming",
        timestamp: runningEvent?.createdAt,
        duration:
          runningEvent && firstPrEvent
            ? formatDuration(runningEvent.createdAt, firstPrEvent.createdAt)
            : runningEvent && completedEvent && !hadPr
              ? formatDuration(runningEvent.createdAt, completedEvent.createdAt)
              : undefined,
        detail: task.costUsd ? `Cost: $${parseFloat(task.costUsd).toFixed(4)}` : undefined,
      },
    );

    // Always show post-coding stages so users can see what's ahead
    stages.push({
      id: "pr",
      label: "PR",
      icon: GitPullRequest,
      status: "upcoming",
      timestamp: firstPrEvent?.createdAt,
      detail: task.prNumber ? `#${task.prNumber}` : undefined,
    });

    // CI stage
    stages.push({
      id: "ci",
      label: "CI Checks",
      icon: CheckCircle2,
      status: "upcoming",
      detail:
        task.prChecksStatus && task.prChecksStatus !== "none"
          ? `CI: ${task.prChecksStatus}`
          : undefined,
    });

    // Review stage
    const reviewSub = subtasks.find((s: any) => s.taskType === "review");
    let reviewDetail: string | undefined;
    if (task.prReviewStatus && task.prReviewStatus !== "none") {
      reviewDetail =
        task.prReviewStatus === "changes_requested"
          ? "Changes requested"
          : task.prReviewStatus.charAt(0).toUpperCase() + task.prReviewStatus.slice(1);
    }
    if (reviewSub) {
      reviewDetail = reviewDetail
        ? `${reviewDetail} (agent ${reviewSub.state})`
        : `Agent ${reviewSub.state}`;
    }
    stages.push({
      id: "review",
      label: "Review",
      icon: Eye,
      status: "upcoming",
      detail: reviewDetail,
    });

    // Fixup stage — only shown when fixup iterations have occurred
    if (fixupCount > 0) {
      stages.push({
        id: "fixup",
        label: "Fixup",
        icon: RotateCcw,
        status: "upcoming",
        timestamp: fixupEvents[0]?.createdAt,
        detail: fixupCount > 1 ? `${fixupCount} iterations` : "1 iteration",
      });
    }

    // Merge stage
    stages.push({
      id: "merge",
      label: "Merge",
      icon: GitMerge,
      status: "upcoming",
    });

    stages.push({
      id: "done",
      label: "Done",
      icon: CircleCheckBig,
      status: "upcoming",
      timestamp: completedEvent?.createdAt,
    });
  }

  // --- Determine current stage index ---
  const currentStageId = getCurrentStageId(task, hadPr, isInFixup, isReviewTask, hasReview);
  const currentIdx = stages.findIndex((s) => s.id === currentStageId);
  const isTerminalFailed = task.state === "failed";
  const isTerminalCancelled = task.state === "cancelled";
  const isTerminalCompleted = task.state === "completed";

  // --- Assign statuses ---
  for (let i = 0; i < stages.length; i++) {
    if (i < currentIdx) {
      stages[i].status = "completed";
    } else if (i === currentIdx) {
      if (isTerminalFailed) {
        stages[i].status = "failed";
        stages[i].errorMessage = task.errorMessage;
      } else if (isTerminalCancelled) {
        stages[i].status = "cancelled";
      } else if (isTerminalCompleted) {
        stages[i].status = "completed";
      } else {
        stages[i].status = "active";
      }
    } else {
      // After current stage
      if (isTerminalFailed || isTerminalCancelled) {
        stages[i].status = "skipped";
      } else {
        stages[i].status = "upcoming";
      }
    }
  }

  // Special case: if completed, mark Done as completed too
  if (isTerminalCompleted) {
    const doneStage = stages.find((s) => s.id === "done");
    if (doneStage) doneStage.status = "completed";
    const doneIdx = stages.findIndex((s) => s.id === "done");
    const skippableIds = new Set(["pr", "ci", "review", "merge"]);
    for (let i = 0; i < doneIdx; i++) {
      if (stages[i].status === "upcoming") {
        // If task completed without a PR, skip post-PR stages
        if (!hadPr && skippableIds.has(stages[i].id)) {
          stages[i].status = "skipped";
        } else {
          stages[i].status = "completed";
        }
      }
    }
  }

  // If task failed/cancelled before PR, skip post-PR stages
  if ((isTerminalFailed || isTerminalCancelled) && !hadPr) {
    const skippableIds = new Set(["pr", "ci", "review", "merge"]);
    for (const stage of stages) {
      if (stage.status === "skipped" && skippableIds.has(stage.id)) {
        // already skipped, good
      }
    }
  }

  return stages;
}

function getCurrentStageId(
  task: any,
  hadPr: boolean,
  isInFixup: boolean,
  isReviewTask: boolean,
  hasReview: boolean,
): string {
  const state = task.state;

  if (isReviewTask) {
    switch (state) {
      case "pending":
      case "queued":
        return "queued";
      case "provisioning":
        return "setup";
      case "running":
      case "needs_attention":
        return "reviewing";
      case "completed":
      case "failed":
      case "cancelled":
        return "done";
      default:
        return "queued";
    }
  }

  switch (state) {
    case "pending":
    case "queued":
      return isInFixup ? "fixup" : "queued";
    case "provisioning":
      return isInFixup ? "fixup" : "setup";
    case "running":
      return isInFixup ? "fixup" : "coding";
    case "needs_attention":
      return hadPr ? "review" : "coding";
    case "pr_opened": {
      // Determine which post-PR stage we're in
      if (hasReview && task.prReviewStatus && task.prReviewStatus !== "none") {
        return "review";
      }
      if (
        task.prChecksStatus &&
        task.prChecksStatus !== "none" &&
        task.prChecksStatus !== "passing"
      ) {
        return "ci";
      }
      if (task.prChecksStatus === "passing" && hasReview) {
        return "review";
      }
      if (task.prChecksStatus === "passing") {
        return "merge";
      }
      return "pr";
    }
    case "completed":
    case "failed":
    case "cancelled":
      return "done";
    default:
      return "queued";
  }
}

// ---------------------------------------------------------------------------
// Stage tooltips
// ---------------------------------------------------------------------------

const STAGE_TOOLTIPS: Record<string, string> = {
  queued: "Task is waiting in the job queue for a worker to pick it up",
  setup: "Provisioning a pod and creating a git worktree for the task",
  coding: "The AI agent is writing code to complete the task",
  reviewing: "The AI agent is reviewing the pull request",
  pr: "The agent will open a pull request with its changes",
  ci: "CI checks run against the pull request to verify the changes",
  review: "The pull request is reviewed by a human or review agent",
  fixup: "The agent is re-running to address review feedback or CI failures",
  merge: "The pull request is merged into the target branch",
  done: "Task is complete — linked GitHub issues are closed automatically",
};

// ---------------------------------------------------------------------------
// Stage row component
// ---------------------------------------------------------------------------

export function PipelineStageRow({ stage, isLast }: { stage: PipelineStage; isLast: boolean }) {
  const Icon = stage.icon;

  // Icon & dot styling per status
  const iconWrapperClass = cn(
    "relative w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-all duration-300",
    stage.status === "completed" && "bg-success/15 shadow-[0_0_8px_-2px_rgba(34,197,94,0.3)]",
    stage.status === "active" && "bg-primary/15 shadow-[0_0_12px_-2px_rgba(109,40,217,0.4)]",
    stage.status === "failed" && "bg-error/15 shadow-[0_0_8px_-2px_rgba(239,68,68,0.3)]",
    stage.status === "cancelled" && "bg-text-muted/10",
    stage.status === "upcoming" && "bg-transparent border border-border",
    stage.status === "skipped" && "bg-transparent border border-border/40",
  );

  const iconClass = cn(
    "w-3 h-3",
    stage.status === "completed" && "text-success",
    stage.status === "active" && "text-primary",
    stage.status === "failed" && "text-error",
    stage.status === "cancelled" && "text-text-muted/60",
    stage.status === "upcoming" && "text-text-muted/50",
    stage.status === "skipped" && "text-text-muted/30",
  );

  // Connector line between stages
  const connectorClass = cn(
    "w-px flex-1 min-h-3",
    stage.status === "completed" && "bg-success/30",
    stage.status === "active" && "bg-gradient-to-b from-primary/40 via-primary/20 to-border/30",
    stage.status === "failed" && "bg-error/20",
    (stage.status === "upcoming" || stage.status === "cancelled") && "bg-border/40",
    stage.status === "skipped" &&
      "bg-border/20 [mask-image:repeating-linear-gradient(to_bottom,black_0px,black_3px,transparent_3px,transparent_6px)]",
  );

  const DisplayIcon =
    stage.status === "failed" ? XCircle : stage.status === "cancelled" ? Ban : Icon;

  const tooltip = STAGE_TOOLTIPS[stage.id] ?? "";

  return (
    <div className="flex items-stretch gap-2.5" title={tooltip}>
      {/* Vertical track: icon + connector */}
      <div className="flex flex-col items-center w-6">
        <div className={iconWrapperClass}>
          <DisplayIcon className={iconClass} />
          {stage.status === "active" && (
            <span className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />
          )}
        </div>
        {!isLast && <div className={connectorClass} />}
      </div>

      {/* Content — use leading-6 on the label row to match the 24px icon height */}
      <div className="min-w-0 flex-1 pb-3">
        <div className="flex items-center justify-between gap-2 h-6">
          <span
            className={cn(
              "text-xs font-medium leading-6",
              stage.status === "completed" && "text-text",
              stage.status === "active" && "text-primary",
              stage.status === "failed" && "text-error",
              stage.status === "cancelled" && "text-text-muted/60",
              stage.status === "upcoming" && "text-text-muted/60",
              stage.status === "skipped" && "text-text-muted/30",
            )}
          >
            {stage.label}
          </span>
          {stage.timestamp && stage.status !== "upcoming" && stage.status !== "skipped" && (
            <span className="text-[10px] text-text-muted/40 tabular-nums shrink-0 leading-6">
              {formatRelativeTime(stage.timestamp)}
            </span>
          )}
        </div>

        {/* Detail line */}
        {stage.detail && stage.status !== "skipped" && (
          <div
            className={cn(
              "text-[11px] mt-0.5",
              stage.status === "active" && "text-primary/70",
              stage.status === "completed" && "text-text-muted/60",
              stage.status === "failed" && "text-error/70",
              stage.status === "upcoming" && "text-text-muted/40",
              stage.status === "cancelled" && "text-text-muted/40",
            )}
          >
            {stage.detail}
          </div>
        )}

        {/* Duration */}
        {stage.duration && stage.status === "completed" && (
          <div className="text-[10px] text-text-muted/40 mt-0.5 tabular-nums">{stage.duration}</div>
        )}

        {/* Error message */}
        {stage.errorMessage && stage.status === "failed" && (
          <div className="mt-1.5 p-2 rounded-md bg-error/5 border border-error/15 text-[11px] text-error/80 leading-relaxed line-clamp-3">
            {stage.errorMessage}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function PipelineTimeline({
  task,
  events,
  subtasks,
}: {
  task: any;
  events: any[];
  subtasks: any[];
}) {
  const [showRawEvents, setShowRawEvents] = useState(false);
  const stages = derivePipelineStages(task, events, subtasks);

  return (
    <div className="space-y-4">
      {/* Pipeline stages */}
      <div className="relative">
        {stages.map((stage, i) => (
          <PipelineStageRow key={stage.id} stage={stage} isLast={i === stages.length - 1} />
        ))}
      </div>

      {/* Raw events toggle */}
      <div className="border-t border-border/50 pt-3">
        <button
          onClick={() => setShowRawEvents(!showRawEvents)}
          className="flex items-center gap-1.5 text-[11px] text-text-muted/50 hover:text-text-muted transition-colors w-full"
        >
          {showRawEvents ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
          Raw Events ({events.length})
        </button>
        {showRawEvents && (
          <div className="mt-3 animate-slide-down">
            <EventTimeline events={events} />
          </div>
        )}
      </div>
    </div>
  );
}
