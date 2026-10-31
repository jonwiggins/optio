"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";

/**
 * Whether this deployment asks for a confirmation before automatic merging
 * (Settings → Access → Automatic merging, docs/merge-confirmation.md), read
 * once per page load from `GET /api/deployment-settings`. False until the
 * answer arrives, and when it can't be read: the API still refuses an
 * unconfirmed "merge automatically" then, so a form that guessed wrong gets
 * a clear 400 instead of a silent merge.
 */
let cached: Promise<boolean> | null = null;

function load(): Promise<boolean> {
  cached ??= Promise.resolve()
    .then(() => api.getDeploymentSettings())
    .then((s) => s.mergeConfirmation?.value === true)
    .catch(() => {
      cached = null;
      return false;
    });
  return cached;
}

/** Forget the cached answer (tests, and after an admin changes it). */
export function forgetMergeConfirmation(): void {
  cached = null;
}

export function useMergeConfirmation(): boolean {
  const [required, setRequired] = useState(false);
  useEffect(() => {
    let live = true;
    void load().then((v) => {
      if (live) setRequired(v);
    });
    return () => {
      live = false;
    };
  }, []);
  return required;
}
