"use client";

import { useState, type ReactNode } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useDeploymentSwitches } from "@/hooks/use-deployment-switches";

/**
 * When the deployment asks for it (Settings → Access → Automatic merging),
 * automatic merging is never on by accident: ticking the checkbox opens this
 * dialog, and only "Yes, merge automatically" turns it on — the page then
 * sends `autoMergeConfirmed: true` with the value (the API refuses it
 * otherwise; packages/shared/src/work/auto-merge.ts). Unticking turns it off
 * at once. Without it, the checkbox alone decides.
 */
export function AutoMergeConfirmDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      title="Merge automatically?"
      description="Optio will merge the MR by itself when CI passes and no reviewer requested changes."
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm}>
            Yes, merge automatically
          </Button>
        </>
      }
    >
      <ul className="list-disc space-y-1.5 pl-5 text-sm text-text-muted">
        <li>No one clicks Merge: the change lands on the target branch as soon as it's green.</li>
        <li>It waits while CI runs or fails, while the MR is a draft or has conflicts.</li>
        <li>It never merges over a reviewer who requested changes.</li>
        <li>Untick the box any time to merge by hand again.</li>
      </ul>
    </Dialog>
  );
}

/**
 * The checkbox's change handler and the dialog it opens. `onChange(on,
 * confirmed)` runs with `confirmed: true` only after the dialog was accepted
 * (or at once, when the deployment asks for no confirmation); render
 * `dialog` next to the checkbox.
 */
export function useAutoMergeConfirm(onChange: (on: boolean, confirmed: boolean) => void): {
  request: (on: boolean) => void;
  dialog: ReactNode;
} {
  const [asking, setAsking] = useState(false);
  const { mergeConfirmation } = useDeploymentSwitches();
  const request = (on: boolean) => {
    if (on && mergeConfirmation) setAsking(true);
    else onChange(on, on);
  };
  const dialog = asking ? (
    <AutoMergeConfirmDialog
      onConfirm={() => {
        setAsking(false);
        onChange(true, true);
      }}
      onCancel={() => setAsking(false)}
    />
  ) : null;
  return { request, dialog };
}

/** "Confirmed on <date> by <name>" under a checkbox that is on. */
export function AutoMergeConfirmedNote({
  at,
  by,
  className,
}: {
  at: string | Date | null | undefined;
  by?: string | null;
  className?: string;
}) {
  const { mergeConfirmation } = useDeploymentSwitches();
  if (!at || !mergeConfirmation) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const when = date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return (
    <span className={className ?? "mt-1 block text-xs text-text-muted"}>
      Confirmed on {when}
      {by ? ` by ${by}` : ""}
    </span>
  );
}
