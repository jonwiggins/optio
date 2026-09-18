import { create } from "zustand";

/**
 * Whether the session rail (the left panel inside /local/:id) is collapsed
 * on wide screens. Persisted so the choice sticks across reloads; the phone
 * drawer is unaffected (it's always a slide-over).
 */

const STORAGE_KEY = "optio.local.railCollapsed";

function readInitial(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

interface RailState {
  collapsed: boolean;
  /** Load the persisted choice after mount (SSR always renders expanded). */
  hydrate: () => void;
  setCollapsed: (collapsed: boolean) => void;
  toggle: () => void;
}

export const useRailStore = create<RailState>((set, get) => ({
  collapsed: false,
  hydrate: () => set({ collapsed: readInitial() }),
  setCollapsed: (collapsed) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      // private mode / blocked storage — the choice just won't persist
    }
    set({ collapsed });
  },
  toggle: () => get().setCollapsed(!get().collapsed),
}));
