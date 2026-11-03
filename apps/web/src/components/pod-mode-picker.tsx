"use client";

import { Segmented } from "@/components/ui/segmented";

/** A repo's pod mode as the form holds it: "inherit" follows the workspace. */
export type RepoPodModeChoice = "inherit" | "shared" | "per_run";
export type WorkspacePodModeValue = "shared" | "per_run" | "per_run_required";

const LABELS: Record<"shared" | "per_run", string> = {
  shared: "Shared pods",
  per_run: "Fresh pod per run",
};

const REQUIRED = "The workspace requires a fresh pod";

/** The mode a repo's runs get (services/pod-mode.ts on the API). */
export function effectiveRepoPodMode(
  choice: RepoPodModeChoice,
  workspace: WorkspacePodModeValue,
): "shared" | "per_run" {
  if (workspace === "per_run_required") return "per_run";
  if (choice !== "inherit") return choice;
  return workspace === "per_run" ? "per_run" : "shared";
}

/**
 * The repo settings' "Pod per run" control: the workspace default, shared
 * pods, or a fresh pod per run, with the trade-off in one line. Under a
 * workspace that requires fresh pods only that option can be picked.
 */
export function RepoPodModePicker({
  value,
  workspacePodMode,
  onChange,
}: {
  value: RepoPodModeChoice;
  workspacePodMode: WorkspacePodModeValue;
  onChange: (next: RepoPodModeChoice) => void;
}) {
  const required = workspacePodMode === "per_run_required";
  const workspaceDefault = workspacePodMode === "shared" ? "shared" : "per_run";
  const effective = effectiveRepoPodMode(value, workspacePodMode);
  return (
    <div>
      <label className="block text-xs text-text-muted mb-1">Pod per run</label>
      <Segmented
        aria-label="Pod mode"
        value={required ? "per_run" : value}
        onChange={onChange}
        wrap
        options={[
          {
            value: "inherit",
            label: `Workspace default (${LABELS[workspaceDefault]})`,
            disabled: required ? REQUIRED : undefined,
          },
          { value: "shared", label: LABELS.shared, disabled: required ? REQUIRED : undefined },
          { value: "per_run", label: LABELS.per_run },
        ]}
      />
      <p className="text-[10px] text-text-muted/60 mt-1.5">
        {effective === "per_run"
          ? "Each run gets a new pod that is removed when it ends: slower to start, and nothing from earlier runs (packages, files, processes, caches) is left behind."
          : "Runs reuse this repo's pods: faster to start, but what one run leaves outside its worktree is there for the next."}
        {required ? " Required by the workspace." : ""}
      </p>
    </div>
  );
}
