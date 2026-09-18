import { create } from "zustand";

/**
 * Which sidebar groups the user has collapsed. Persisted per browser so the
 * choice sticks across reloads. Groups not listed here are expanded; the
 * defaults collapse the reference-style groups so the whole nav fits on a
 * laptop viewport without scrolling. A group containing the active route is
 * always rendered open regardless (see sidebar.tsx) so the current page is
 * never hidden.
 */

const STORAGE_KEY = "optio.nav.collapsedGroups";

export const DEFAULT_COLLAPSED_GROUPS: readonly string[] = ["Library", "Insights"];

export function readCollapsedGroups(): string[] {
  if (typeof window === "undefined") return [...DEFAULT_COLLAPSED_GROUPS];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [...DEFAULT_COLLAPSED_GROUPS];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === "string") : [];
  } catch {
    return [...DEFAULT_COLLAPSED_GROUPS];
  }
}

interface NavState {
  collapsed: string[];
  /** Load the persisted choice after mount (SSR renders the defaults). */
  hydrate: () => void;
  isCollapsed: (group: string) => boolean;
  toggle: (group: string) => void;
}

export const useNavStore = create<NavState>((set, get) => ({
  collapsed: [...DEFAULT_COLLAPSED_GROUPS],
  hydrate: () => set({ collapsed: readCollapsedGroups() }),
  isCollapsed: (group) => get().collapsed.includes(group),
  toggle: (group) => {
    const current = get().collapsed;
    const next = current.includes(group) ? current.filter((g) => g !== group) : [...current, group];
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // private mode / blocked storage — the choice just won't persist
    }
    set({ collapsed: next });
  },
}));
