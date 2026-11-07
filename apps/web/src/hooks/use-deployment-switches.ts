"use client";

import { useCurrentUser, useCurrentUserStore } from "@/hooks/use-current-user";

/**
 * The deployment-wide switches the web app changes with: today `teams`
 * (docs/teams.md), which shows the Teams link, the Team owner choice and the
 * work-visibility setting. `/api/auth/me` carries the person's team fields
 * only while teams are on, so that is where the answer comes from; off
 * until it arrives, and off when it fails.
 *
 *   const { teams } = useDeploymentSwitches();
 */
export function useDeploymentSwitches(): { teams: boolean; loaded: boolean } {
  const { user, loaded } = useCurrentUser();
  return { teams: Array.isArray(user?.teamIds), loaded };
}

/** After a deployment admin turns teams on or off: fetch who the person is again. */
export function reloadDeploymentSwitches(): Promise<void> {
  const store = useCurrentUserStore.getState();
  store.reset();
  return store.load();
}
