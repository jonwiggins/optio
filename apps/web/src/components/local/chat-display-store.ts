import { create } from "zustand";

/**
 * How the Chat face of a session reads: its font size and how wide the
 * reading column runs. One setting per viewer, applied to every chat view,
 * persisted in localStorage when it's available (SSR and blocked storage
 * render the defaults).
 */

const STORAGE_KEY = "optio.chat.display";

/** The font sizes A− / A+ step through (px). 13 is the chat's original size. */
export const CHAT_FONT_SIZES = [12, 13, 14, 15, 16, 18, 20] as const;
export const DEFAULT_CHAT_FONT_SIZE = 13;

export type ChatWidth = "narrow" | "medium" | "wide" | "full";
/** Narrowest to widest; the width control steps through these. */
export const CHAT_WIDTHS: readonly ChatWidth[] = ["narrow", "medium", "wide", "full"];
export const DEFAULT_CHAT_WIDTH: ChatWidth = "medium";
/** The column's max width per setting (px); `null` fills the pane. 768 was the original. */
export const CHAT_WIDTH_PX: Record<ChatWidth, number | null> = {
  narrow: 640,
  medium: 768,
  wide: 1024,
  full: null,
};
export const CHAT_WIDTH_LABELS: Record<ChatWidth, string> = {
  narrow: "Narrow",
  medium: "Medium",
  wide: "Wide",
  full: "Full width",
};

export interface ChatDisplay {
  fontSize: number;
  width: ChatWidth;
}

export const DEFAULT_CHAT_DISPLAY: ChatDisplay = {
  fontSize: DEFAULT_CHAT_FONT_SIZE,
  width: DEFAULT_CHAT_WIDTH,
};

/** The nearest allowed size to `n`; anything unreadable falls back to the default. */
export function clampChatFontSize(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_CHAT_FONT_SIZE;
  let best: number = CHAT_FONT_SIZES[0];
  for (const s of CHAT_FONT_SIZES) if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  return best;
}

export function normalizeChatWidth(w: unknown): ChatWidth {
  return CHAT_WIDTHS.includes(w as ChatWidth) ? (w as ChatWidth) : DEFAULT_CHAT_WIDTH;
}

/** One step up (`+1`) or down (`-1`) from `size`, stopping at the ends. */
export function stepChatFontSize(size: number, dir: 1 | -1): number {
  const i = CHAT_FONT_SIZES.indexOf(clampChatFontSize(size) as (typeof CHAT_FONT_SIZES)[number]);
  const next = Math.min(CHAT_FONT_SIZES.length - 1, Math.max(0, i + dir));
  return CHAT_FONT_SIZES[next]!;
}

export function stepChatWidth(width: ChatWidth, dir: 1 | -1): ChatWidth {
  const i = CHAT_WIDTHS.indexOf(normalizeChatWidth(width));
  return CHAT_WIDTHS[Math.min(CHAT_WIDTHS.length - 1, Math.max(0, i + dir))]!;
}

export function readChatDisplay(): ChatDisplay {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CHAT_DISPLAY;
    const parsed = JSON.parse(raw) as Partial<ChatDisplay> | null;
    return {
      fontSize: clampChatFontSize(parsed?.fontSize),
      width: normalizeChatWidth(parsed?.width),
    };
  } catch {
    return DEFAULT_CHAT_DISPLAY;
  }
}

function writeChatDisplay(d: ChatDisplay) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
  } catch {
    // private mode / blocked storage — the setting just won't persist
  }
}

interface ChatDisplayState extends ChatDisplay {
  hydrated: boolean;
  /** Load the persisted setting after mount (SSR renders the defaults). */
  hydrate: () => void;
  setFontSize: (n: number) => void;
  stepFontSize: (dir: 1 | -1) => void;
  setWidth: (w: ChatWidth) => void;
  stepWidth: (dir: 1 | -1) => void;
  reset: () => void;
}

export const useChatDisplayStore = create<ChatDisplayState>((set, get) => {
  const commit = (patch: Partial<ChatDisplay>) => {
    const next: ChatDisplay = {
      fontSize: clampChatFontSize(patch.fontSize ?? get().fontSize),
      width: normalizeChatWidth(patch.width ?? get().width),
    };
    writeChatDisplay(next);
    set(next);
  };
  return {
    ...DEFAULT_CHAT_DISPLAY,
    hydrated: false,
    hydrate: () => {
      if (get().hydrated) return;
      set({ ...readChatDisplay(), hydrated: true });
    },
    setFontSize: (fontSize) => commit({ fontSize }),
    stepFontSize: (dir) => commit({ fontSize: stepChatFontSize(get().fontSize, dir) }),
    setWidth: (width) => commit({ width }),
    stepWidth: (dir) => commit({ width: stepChatWidth(get().width, dir) }),
    reset: () => commit(DEFAULT_CHAT_DISPLAY),
  };
});
