"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/lib/api-client";

/**
 * The deployment-wide switches a deployment admin turns on under Settings →
 * Access (`GET /api/deployment-settings`), fetched once per page load and
 * shared by everything that changes with them: the Teams link and Team
 * pickers (`teams`), the automatic-merge checkbox's confirmation dialog
 * (`mergeConfirmation`), and the getting-started checklist and Help → Using
 * Optio (`onboarding`). All are off until the answer arrives, and stay off
 * when it fails — the behaviour of a deployment that turned nothing on.
 *
 *   const { teams, mergeConfirmation, onboarding } = useDeploymentSwitches();
 */

interface SwitchesState {
  teams: boolean;
  mergeConfirmation: boolean;
  onboarding: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  /** Fetch again (after a deployment admin changed one). */
  reload: () => Promise<void>;
  /** Forget the cached answer (tests, sign-out). */
  reset: () => void;
}

let inflight: Promise<void> | null = null;

function fetchSwitches(set: (s: Partial<SwitchesState>) => void): Promise<void> {
  if (inflight) return inflight;
  // `Promise.resolve().then` turns a client without `getDeploymentSettings`
  // (a test's partial mock) into the same "all off" answer as a failed request.
  inflight = Promise.resolve()
    .then(() => api.getDeploymentSettings())
    .then((res) =>
      set({
        teams: res?.teams?.value === true,
        mergeConfirmation: res?.mergeConfirmation?.value === true,
        onboarding: res?.onboarding?.value === true,
        loaded: true,
      }),
    )
    .catch(() => set({ loaded: true }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export const useDeploymentSwitchesStore = create<SwitchesState>((set) => ({
  teams: false,
  mergeConfirmation: false,
  onboarding: false,
  loaded: false,
  load: () => fetchSwitches(set),
  reload: () => {
    inflight = null;
    return fetchSwitches(set);
  },
  reset: () => {
    inflight = null;
    set({ teams: false, mergeConfirmation: false, onboarding: false, loaded: false });
  },
}));

export function useDeploymentSwitches(): {
  teams: boolean;
  mergeConfirmation: boolean;
  onboarding: boolean;
  loaded: boolean;
} {
  const teams = useDeploymentSwitchesStore((s) => s.teams);
  const mergeConfirmation = useDeploymentSwitchesStore((s) => s.mergeConfirmation);
  const onboarding = useDeploymentSwitchesStore((s) => s.onboarding);
  const loaded = useDeploymentSwitchesStore((s) => s.loaded);
  const load = useDeploymentSwitchesStore((s) => s.load);
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  return { teams, mergeConfirmation, onboarding, loaded };
}
