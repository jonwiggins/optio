import { useEffect } from "react";
import { create } from "zustand";

const SUFFIX = "Optio";

/**
 * Tab-title badge — "(2) title — Optio" — set by whoever tracks something
 * that needs the user (the Local attention watcher). Lives in a store so
 * the badge survives route changes without each page knowing about it.
 */
interface TitleState {
  title: string | undefined;
  badge: number;
  setTitle: (title: string | undefined) => void;
  setBadge: (badge: number) => void;
}

export const useTitleStore = create<TitleState>((set) => ({
  title: undefined,
  badge: 0,
  setTitle: (title) => set({ title }),
  setBadge: (badge) => set({ badge }),
}));

function apply(title: string | undefined, badge: number) {
  const base = title ? `${title} — ${SUFFIX}` : SUFFIX;
  document.title = badge > 0 ? `(${badge}) ${base}` : base;
}

useTitleStore.subscribe((s) => {
  if (typeof document !== "undefined") apply(s.title, s.badge);
});

export function usePageTitle(title: string | undefined) {
  useEffect(() => {
    useTitleStore.getState().setTitle(title);
  }, [title]);
}
