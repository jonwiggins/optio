import { Clock, Server, Eye, CircleCheckBig, CheckCircle2 } from "lucide-react";
import { PipelineStageRow, type PipelineStage } from "./pipeline-timeline.js";
import { formatDuration } from "@/lib/utils";

/**
 * Vertical pipeline timeline for PR reviews. Mirrors the visual language of
 * `<PipelineTimeline>` (used on the task detail page) so the two pages feel
 * native to each other — the difference is just which stages are derived.
 *
 * Stages: Queued → Waiting CI → Reviewing → Ready → Submitted. The timeline
 * also surfaces re-run history under the Reviewing stage so the user can see
 * past attempts at a glance.
 */
export function ReviewPipelineTimeline({ review, runs }: { review: any; runs: any[] }) {
  const stages = deriveReviewStages(review, runs);
  return (
    <div className="space-y-4">
      <div className="relative">
        {stages.map((stage, i) => (
          <PipelineStageRow key={stage.id} stage={stage} isLast={i === stages.length - 1} />
        ))}
      </div>
    </div>
  );
}

function deriveReviewStages(review: any, runs: any[]): PipelineStage[] {
  const state = review.state as string;
  const stageOrder = ["queued", "waiting_ci", "reviewing", "ready", "submitted"];
  const currentIdx = (() => {
    if (state === "stale") return stageOrder.indexOf("ready");
    if (state === "failed" || state === "cancelled") return -1;
    return stageOrder.indexOf(state);
  })();

  const status = (idx: number): PipelineStage["status"] => {
    if (state === "failed" && idx === activeIdxOnFailure(runs)) return "failed";
    if (state === "cancelled" && idx === currentCancelIdx(state, runs)) return "cancelled";
    if (currentIdx === -1) return "upcoming";
    if (idx < currentIdx) return "completed";
    if (idx === currentIdx) return state === "submitted" ? "completed" : "active";
    return "upcoming";
  };

  // Pick the most recent run that's relevant for the "Reviewing" stage detail.
  const latestRun = runs[0];
  const reviewingDetail =
    runs.length > 0
      ? `${runs.length} run${runs.length > 1 ? "s" : ""}${
          latestRun?.costUsd ? ` · $${parseFloat(latestRun.costUsd).toFixed(4)}` : ""
        }`
      : undefined;

  // Reviewing duration = first run startedAt → latest run completedAt
  const reviewingStart = runs.length > 0 ? runs[runs.length - 1]?.startedAt : undefined;
  const reviewingEnd = latestRun?.completedAt;
  const reviewingDuration =
    reviewingStart && reviewingEnd ? formatDuration(reviewingStart, reviewingEnd) : undefined;

  return [
    {
      id: "queued",
      label: "Queued",
      status: status(0),
      icon: Clock,
      timestamp: review.createdAt,
    },
    {
      id: "waiting_ci",
      label: "Waiting for CI",
      status: status(1),
      icon: Server,
      detail: state === "waiting_ci" ? "Holding for required checks" : undefined,
    },
    {
      id: "reviewing",
      label: "Agent reviewing",
      status: state === "failed" && latestRun?.state === "failed" ? "failed" : status(2),
      icon: Eye,
      detail: reviewingDetail,
      duration: reviewingDuration,
      timestamp: latestRun?.startedAt ?? latestRun?.createdAt,
      errorMessage:
        state === "failed" ? (review.errorMessage ?? latestRun?.errorMessage) : undefined,
    },
    {
      id: "ready",
      label: state === "stale" ? "Ready (stale)" : "Ready for review",
      status: state === "stale" ? "failed" : status(3),
      icon: CircleCheckBig,
      detail: state === "stale" ? "PR has new commits since this review" : undefined,
      timestamp: ["ready", "stale", "submitted"].includes(state) ? review.updatedAt : undefined,
    },
    {
      id: "submitted",
      label: "Submitted",
      status: status(4),
      icon: CheckCircle2,
      timestamp: review.submittedAt ?? undefined,
      detail: review.autoSubmitted ? "Auto-submitted" : undefined,
    },
  ];
}

// When state=failed, mark the stage that was active when the failure happened
// as "failed" rather than letting the regular logic paint everything as upcoming.
function activeIdxOnFailure(runs: any[]): number {
  const latest = runs[0];
  if (!latest) return 2; // assume reviewing
  // If we never started, the failure is at queued. If we started but never finished, reviewing.
  return latest.startedAt ? 2 : 0;
}

function currentCancelIdx(state: string, runs: any[]): number {
  // Cancelled before review started → stage 0; otherwise reviewing.
  return runs[0]?.startedAt ? 2 : 0;
}
