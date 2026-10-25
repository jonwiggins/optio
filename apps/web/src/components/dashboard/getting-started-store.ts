import { create } from "zustand";

/**
 * Whether a person put the Overview's getting-started checklist away
 * (getting-started.tsx), per person in this browser: `Hide` sets it, the
 * account menu's Help → "Getting-started checklist" clears it. Kept in
 * localStorage under the person's id, so someone else signing in on the
 * same browser still gets their own. Also remembered once every step is
 * done, so the Overview stops asking.
 */

const key = (userId: string) => `optio.gettingStarted.hidden.${userId}`;

export function readHidden(userId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key(userId)) !== null;
  } catch {
    return false;
  }
}

function writeHidden(userId: string, why: "dismissed" | "complete" | null) {
  try {
    if (why) window.localStorage.setItem(key(userId), why);
    else window.localStorage.removeItem(key(userId));
  } catch {
    // Storage off (private mode): it only lasts the page.
  }
}

interface GettingStartedState {
  /** Per person: true = hidden, false = shown; absent = read localStorage. */
  hidden: Record<string, boolean>;
  isHidden: (userId: string) => boolean;
  /** "Hide": the person put it away. */
  dismiss: (userId: string) => void;
  /** Every step done: hidden, and not fetched again. */
  markComplete: (userId: string) => void;
  /** Help → "Getting-started checklist": show it again. */
  show: (userId: string) => void;
}

export const useGettingStartedStore = create<GettingStartedState>((set, get) => ({
  hidden: {},
  isHidden: (userId) => get().hidden[userId] ?? readHidden(userId),
  dismiss: (userId) => {
    writeHidden(userId, "dismissed");
    set((s) => ({ hidden: { ...s.hidden, [userId]: true } }));
  },
  markComplete: (userId) => {
    writeHidden(userId, "complete");
    set((s) => ({ hidden: { ...s.hidden, [userId]: true } }));
  },
  show: (userId) => {
    writeHidden(userId, null);
    set((s) => ({ hidden: { ...s.hidden, [userId]: false } }));
  },
}));
