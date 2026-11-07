import { eq } from "drizzle-orm";
import type { RepoPodMode, WorkspacePodMode } from "@optio/shared";
import { db } from "../db/client.js";
import { workspaces } from "../db/schema.js";

/**
 * Where a repo's work runs (docs/fresh-pod-per-run.md):
 *
 *  - `shared`: the repo's pods are reused across runs (up to
 *    `maxAgentsPerPod` at once in each of `maxPodInstances` pods) and kept
 *    until they idle out. Fast starts; whatever a run leaves outside its
 *    worktree (installed packages, home-directory files, background
 *    processes, caches) is there for the next one.
 *  - `per_run`: each run gets a pod made for it alone, removed when the run
 *    ends. Slower starts; a clean environment every time.
 *
 * A repo's own setting (`repos.pod_mode`, null = follow the workspace) wins
 * over the workspace default (`workspaces.pod_mode` "shared" | "per_run"),
 * except under "per_run_required", where every run gets a fresh pod.
 */
export function effectivePodMode(
  repoPodMode: RepoPodMode | null | undefined,
  workspacePodMode: WorkspacePodMode | null | undefined,
): RepoPodMode {
  if (workspacePodMode === "per_run_required") return "per_run";
  if (repoPodMode === "shared" || repoPodMode === "per_run") return repoPodMode;
  return workspacePodMode === "per_run" ? "per_run" : "shared";
}

/** The workspace's pod mode ("shared" for no workspace or an unknown one). */
export async function workspacePodMode(
  workspaceId: string | null | undefined,
): Promise<WorkspacePodMode> {
  if (!workspaceId) return "shared";
  const [ws] = await db
    .select({ podMode: workspaces.podMode })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  return ws?.podMode ?? "shared";
}

/** The pod mode work on a repo runs with (the repo row may be missing). */
export async function podModeForRepo(
  repo: { podMode?: RepoPodMode | null } | null | undefined,
  workspaceId: string | null | undefined,
): Promise<RepoPodMode> {
  return effectivePodMode(repo?.podMode ?? null, await workspacePodMode(workspaceId));
}

/** Why a repo may not be set to `mode`, or null (the workspace requires fresh pods). */
export async function repoPodModeRefusal(
  mode: RepoPodMode | null | undefined,
  workspaceId: string | null | undefined,
): Promise<string | null> {
  if (mode !== "shared") return null;
  if ((await workspacePodMode(workspaceId)) !== "per_run_required") return null;
  return "This workspace requires a fresh pod for every run; a repo can't switch to shared pods";
}
