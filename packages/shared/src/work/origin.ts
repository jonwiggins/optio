import type { WorkTrigger } from "./feed.js";

/** The source badge shared by work lists, usage and session views. */
export interface WorkOrigin {
  spawnedBy: string;
  triggerType?: string | null;
  ticketSource?: string | null;
}

export function workOrigin({
  source,
  runTarget,
  spawnedBy,
  ticketSource,
  triggers = [],
}: {
  source?: string | null;
  runTarget?: string | null;
  spawnedBy?: string | null;
  ticketSource?: string | null;
  triggers?: WorkTrigger[];
}): WorkOrigin | null {
  // A Local session's recorded source is authoritative, including task/job.
  if (source === "local-terminal") {
    return {
      spawnedBy: spawnedBy ?? "manual",
      triggerType: spawnedBy === "trigger" ? triggers[0]?.type : undefined,
      ticketSource,
    };
  }
  if (source === "persistent-agent" || source === "optio") return { spawnedBy: "optio" };
  if (source === "review") return { spawnedBy: "review" };
  if (runTarget === "local" && source === "repo-task") return { spawnedBy: "task" };
  if (runTarget === "local" && source === "job-run") return { spawnedBy: "job" };
  if (ticketSource) return { spawnedBy: "ticket", ticketSource };
  const distinct = [...new Map(triggers.map((t) => [`${t.type}:${t.source ?? ""}`, t])).values()];
  // A definition can have several sources. Do not arbitrarily pick one.
  if (distinct.length > 1) return { spawnedBy: "trigger" };
  const trigger = distinct[0];
  if (trigger && trigger.type !== "manual") {
    return {
      spawnedBy: trigger.type === "ticket" ? "ticket" : "trigger",
      triggerType: trigger.type,
      ticketSource: trigger.source,
    };
  }
  return source ? { spawnedBy: spawnedBy ?? "manual" } : null;
}
