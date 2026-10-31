"use client";

import { useEffect, useRef } from "react";
import { create } from "zustand";
import type { Team } from "@optio/shared";
import { api } from "@/lib/api-client";

/**
 * The workspace's teams, fetched once per page load and shared by every
 * Owner picker that offers a **Team** option (the New work form) and by the
 * Teams page itself.
 *
 *   const { teams, myTeams, loaded } = useMyTeams();
 *
 * `myTeams` is the ones the viewer is an active member of — the teams a
 * picker lets them give something to. The Teams page calls `reload` after
 * joining or leaving so pickers elsewhere follow.
 */

export interface TeamOption {
  id: string;
  name: string;
}

interface MyTeamsState {
  teams: Team[];
  /** The first fetch has settled (successfully or not). */
  loaded: boolean;
  load: () => Promise<void>;
  /** Fetch again (after a join, leave, create or delete). */
  reload: () => Promise<void>;
  /** Forget the cached answer (after sign-out or a workspace switch). */
  reset: () => void;
}

let inflight: Promise<void> | null = null;

function fetchTeams(set: (s: Partial<MyTeamsState>) => void): Promise<void> {
  if (inflight) return inflight;
  // `Promise.resolve().then` turns a client without `listTeams` (a test's
  // partial mock) into the same "no teams" answer as a failed request.
  inflight = Promise.resolve()
    .then(() => api.listTeams())
    .then((res) => set({ teams: res.teams ?? [], loaded: true }))
    .catch(() => set({ loaded: true }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export const useMyTeamsStore = create<MyTeamsState>((set) => ({
  teams: [],
  loaded: false,
  load: () => fetchTeams(set),
  reload: () => {
    inflight = null;
    return fetchTeams(set);
  },
  reset: () => {
    inflight = null;
    set({ teams: [], loaded: false });
  },
}));

/** The teams the viewer is an active member of, as picker options. */
export function myTeamOptions(teams: Team[]): TeamOption[] {
  return teams.filter((t) => t.myStatus === "active").map((t) => ({ id: t.id, name: t.name }));
}

/**
 * The workspace's teams, loading them on first use. `fresh` fetches once
 * on mount even when a picker loaded them earlier (the Teams page, which
 * shows standing that may have changed since).
 */
export function useMyTeams({ fresh = false }: { fresh?: boolean } = {}): {
  teams: Team[];
  myTeams: TeamOption[];
  loaded: boolean;
  reload: () => Promise<void>;
} {
  const { teams, loaded, load, reload } = useMyTeamsStore();
  const refreshed = useRef(false);
  useEffect(() => {
    if (fresh) {
      if (!refreshed.current) {
        refreshed.current = true;
        void reload();
      }
      return;
    }
    if (!loaded) void load();
  }, [fresh, loaded, load, reload]);
  return { teams, myTeams: myTeamOptions(teams), loaded, reload };
}
