import { create } from "zustand";

/**
 * Size and visibility of the session rail (the left panel inside /local/:id)
 * on wide screens. Persisted so the choices stick across reloads; the phone
 * drawer is unaffected (it's always a slide-over).
 */

const STORAGE_KEY = "optio.local.railCollapsed";
const WIDTH_KEY = "optio.local.railWidth";
export const RAIL_DEFAULT_WIDTH = 240;
export const RAIL_MIN_WIDTH = 200;
export const RAIL_MAX_WIDTH = 440;

export function clampRailWidth(width: number, max = RAIL_MAX_WIDTH): number {
  if (!Number.isFinite(width)) return RAIL_DEFAULT_WIDTH;
  return Math.round(Math.min(Math.max(RAIL_MIN_WIDTH, width), Math.max(RAIL_MIN_WIDTH, max)));
}

function readWidth(): number {
  try {
    const stored = window.localStorage.getItem(WIDTH_KEY);
    return stored === null ? RAIL_DEFAULT_WIDTH : clampRailWidth(Number(stored));
  } catch {
    return RAIL_DEFAULT_WIDTH;
  }
}

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
  width: number;
  /** Load the persisted choice after mount (SSR always renders expanded). */
  hydrate: () => void;
  setCollapsed: (collapsed: boolean) => void;
  setWidth: (width: number) => void;
  toggle: () => void;
}

export const useRailStore = create<RailState>((set, get) => ({
  collapsed: false,
  width: RAIL_DEFAULT_WIDTH,
  hydrate: () => set({ collapsed: readInitial(), width: readWidth() }),
  setWidth: (width) => {
    const bounded = clampRailWidth(width);
    try {
      window.localStorage.setItem(WIDTH_KEY, String(bounded));
    } catch {
      // private mode / blocked storage — resizing still works for this visit
    }
    set({ width: bounded });
  },
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
