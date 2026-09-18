import { create } from "zustand";

/**
 * Which terminals the user asked to be pinged about ("ring the bell when
 * this session needs me"). Per browser, persisted in localStorage — the
 * notification itself is a browser Notification fired by the attention
 * watcher, so the server never needs to know.
 */

const STORAGE_KEY = "optio.local.bells";

function read(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(ids: string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // private mode / blocked storage — the choice just won't persist
  }
}

interface BellState {
  armed: string[];
  hydrate: () => void;
  isArmed: (id: string) => boolean;
  setArmed: (id: string, on: boolean) => void;
  /** Drop ids for terminals that no longer exist. */
  prune: (existing: Set<string>) => void;
}

export const useBellStore = create<BellState>((set, get) => ({
  armed: [],
  hydrate: () => set({ armed: read() }),
  isArmed: (id) => get().armed.includes(id),
  setArmed: (id, on) => {
    const cur = get().armed;
    const next = on ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id);
    write(next);
    set({ armed: next });
  },
  prune: (existing) => {
    const cur = get().armed;
    const next = cur.filter((id) => existing.has(id));
    if (next.length !== cur.length) {
      write(next);
      set({ armed: next });
    }
  },
}));
