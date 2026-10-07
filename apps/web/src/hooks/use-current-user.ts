"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { api } from "@/lib/api-client";

/**
 * Who is signed in, fetched once per page load and shared by every component
 * that needs to know (the user menu, owner pickers, scope sections, forms).
 * Replaces the per-component `api.getCurrentUser()` calls, which each decided
 * "admin" slightly differently.
 *
 *   const { user, isAdmin, loaded } = useCurrentUser();
 *
 * `isAdmin` follows the server's rule (`actorOf`): a workspace admin, or
 * everyone when auth is disabled. `isDeploymentAdmin` is the instance-wide
 * role that may change how everyone signs in (Settings → Sign-in).
 */

export interface CurrentUser {
  id: string;
  provider: string;
  email: string;
  displayName: string;
  username?: string | null;
  avatarUrl: string | null;
  workspaceId: string | null;
  workspaceRole: string | null;
  deploymentAdmin?: boolean;
}

interface CurrentUserState {
  user: CurrentUser | null;
  authDisabled: boolean;
  /** The first fetch has settled (successfully or not). */
  loaded: boolean;
  load: () => Promise<void>;
  /** Forget the cached answer (after sign-out or a workspace switch). */
  reset: () => void;
}

let inflight: Promise<void> | null = null;

export const useCurrentUserStore = create<CurrentUserState>((set) => ({
  user: null,
  authDisabled: false,
  loaded: false,
  load: () => {
    if (inflight) return inflight;
    inflight = api
      .getCurrentUser()
      .then((res) => set({ user: res.user, authDisabled: res.authDisabled, loaded: true }))
      .catch(() => set({ loaded: true }))
      .finally(() => {
        inflight = null;
      });
    return inflight;
  },
  reset: () => {
    inflight = null;
    set({ user: null, authDisabled: false, loaded: false });
  },
}));

export interface CurrentUserView {
  user: CurrentUser | null;
  authDisabled: boolean;
  loaded: boolean;
  /** The signed-in user's id; null before load or when auth is disabled. */
  userId: string | null;
  /** May change the organization's resources (a workspace admin, or auth disabled). */
  isAdmin: boolean;
  /** May change how everyone signs in (Settings → Sign-in). */
  isDeploymentAdmin: boolean;
  /** A workspace viewer: read-only on every mutating route. */
  isViewer: boolean;
  /**
   * May create and change work (a member or admin, or anyone when auth is
   * disabled). True while the user is unknown, as on Android, so actions don't
   * flicker in and out; the server enforces the role either way.
   */
  canMutate: boolean;
}

/** The current user, loading it on first use. */
export function useCurrentUser(): CurrentUserView {
  const { user, authDisabled, loaded, load } = useCurrentUserStore();
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  return viewOf({ user, authDisabled, loaded });
}

/** The derived flags, for callers that already hold the state (and for tests). */
export function viewOf(state: {
  user: CurrentUser | null;
  authDisabled: boolean;
  loaded: boolean;
}): CurrentUserView {
  const { user, authDisabled, loaded } = state;
  const isViewer = !authDisabled && user?.workspaceRole === "viewer";
  return {
    user,
    authDisabled,
    loaded,
    userId: authDisabled ? null : (user?.id ?? null),
    isAdmin: authDisabled || user?.workspaceRole === "admin",
    isDeploymentAdmin: authDisabled || !!user?.deploymentAdmin,
    isViewer,
    canMutate: !isViewer,
  };
}
