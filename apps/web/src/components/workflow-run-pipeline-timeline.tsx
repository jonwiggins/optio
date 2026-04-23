import { Clock, Server, Code, CircleCheckBig } from "lucide-react";
import { PipelineStageRow, type PipelineStage } from "./pipeline-timeline.js";
import { formatDuration } from "@/lib/utils";

/**
 * Vertical pipeline timeline for standalone (workflow) task runs. Mirrors
 * the visual language of `<PipelineTimeline>` (tasks) and
 * `<ReviewPipelineTimeline>` (PR reviews) so the three execution surfaces
 * feel native to each other — only the stage derivation differs.
 *
 * Stages: Queued → Provisioning → Running → Done. The Running stage
 * surfaces cost, model, and retry count as detail when available.
 */
export function WorkflowRunPipelineTimeline({ run }: { run: any }) {
  const stages = deriveStages(run);
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

function deriveStages(run: any): PipelineStage[] {
  const state = run.state as string;
  const order = ["queued", "provisioning", "running", "done"];
  const currentIdx = (() => {
    if (state === "completed" || state === "failed" || state === "cancelled") {
      return order.indexOf("done");
    }
    return order.indexOf(state);
  })();

  const status = (idx: number): PipelineStage["status"] => {
    if (state === "failed") {
      // Mark the stage active when failure happened; mark earlier stages completed.
      const failureIdx = run.startedAt ? order.indexOf("running") : order.indexOf("queued");
      if (idx === failureIdx) return "failed";
      if (idx < failureIdx) return "completed";
      if (idx === order.indexOf("done")) return "failed";
      return "upcoming";
    }
    if (state === "cancelled") {
      const cancelIdx = run.startedAt ? order.indexOf("running") : order.indexOf("queued");
      if (idx === cancelIdx) return "cancelled";
      if (idx < cancelIdx) return "completed";
      if (idx === order.indexOf("done")) return "cancelled";
      return "upcoming";
    }
    if (currentIdx === -1) return "upcoming";
    if (idx < currentIdx) return "completed";
    if (idx === currentIdx) return state === "completed" ? "completed" : "active";
    return "upcoming";
  };

  // Derive durations from timestamps where available.
  const queuedToProvisioning =
    run.createdAt && run.startedAt ? formatDuration(run.createdAt, run.startedAt) : undefined;
  const runningDuration = run.startedAt
    ? formatDuration(run.startedAt, run.finishedAt ?? undefined)
    : undefined;

  // Compose detail line for the Running stage from cost/model/retry.
  const runningDetail = (() => {
    const parts: string[] = [];
    if (run.modelUsed) parts.push(run.modelUsed);
    if (run.costUsd) parts.push(`$${parseFloat(run.costUsd).toFixed(4)}`);
    if (run.retryCount > 0) parts.push(`retry ${run.retryCount}`);
    return parts.length > 0 ? parts.join(" · ") : undefined;
  })();

  return [
    {
      id: "queued",
      label: "Queued",
      status: status(0),
      icon: Clock,
      timestamp: run.createdAt,
      duration: queuedToProvisioning,
    },
    {
      id: "provisioning",
      label: "Provisioning pod",
      status: status(1),
      icon: Server,
      timestamp: state === "provisioning" || run.startedAt ? run.startedAt : undefined,
    },
    {
      id: "running",
      label: "Agent running",
      status: status(2),
      icon: Code,
      timestamp: run.startedAt,
      duration: runningDuration,
      detail: runningDetail,
      errorMessage: state === "failed" ? run.errorMessage : undefined,
    },
    {
      id: "done",
      label:
        state === "completed"
          ? "Completed"
          : state === "failed"
            ? "Failed"
            : state === "cancelled"
              ? "Cancelled"
              : "Done",
      status: status(3),
      icon: CircleCheckBig,
      timestamp: run.finishedAt ?? undefined,
    },
  ];
}
