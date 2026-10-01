"use client";

import { AArrowDown, AArrowUp, FoldHorizontal, RotateCcw, UnfoldHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CHAT_FONT_SIZES,
  CHAT_WIDTHS,
  CHAT_WIDTH_LABELS,
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_CHAT_WIDTH,
  useChatDisplayStore,
} from "./chat-display-store";

const iconButton =
  "inline-flex items-center justify-center w-6 h-6 rounded text-text-muted hover:text-text hover:bg-bg-hover/70 disabled:opacity-40 disabled:pointer-events-none transition-colors";

/**
 * A− / A+ and narrower / wider for the Chat face, plus a reset. The
 * setting is the viewer's own and applies to every chat view.
 */
export function ChatDisplayControls({ className }: { className?: string }) {
  const fontSize = useChatDisplayStore((s) => s.fontSize);
  const width = useChatDisplayStore((s) => s.width);
  const store = useChatDisplayStore.getState;
  const minFont = fontSize <= CHAT_FONT_SIZES[0];
  const maxFont = fontSize >= CHAT_FONT_SIZES[CHAT_FONT_SIZES.length - 1]!;
  const widthIdx = CHAT_WIDTHS.indexOf(width);
  const isDefault = fontSize === DEFAULT_CHAT_FONT_SIZE && width === DEFAULT_CHAT_WIDTH;

  return (
    <div
      className={cn("flex items-center gap-0.5", className)}
      role="group"
      aria-label="Chat text size and width"
    >
      <button
        type="button"
        className={iconButton}
        onClick={() => store().stepFontSize(-1)}
        disabled={minFont}
        aria-label="Smaller text"
        title="Smaller text (⌘/Ctrl −)"
      >
        <AArrowDown className="w-3.5 h-3.5" />
      </button>
      <span
        className="w-6 text-center text-[10px] tabular-nums text-text-muted"
        data-testid="chat-font-size"
        title="Text size (px)"
      >
        {fontSize}
      </span>
      <button
        type="button"
        className={iconButton}
        onClick={() => store().stepFontSize(1)}
        disabled={maxFont}
        aria-label="Larger text"
        title="Larger text (⌘/Ctrl =)"
      >
        <AArrowUp className="w-3.5 h-3.5" />
      </button>
      <span className="mx-1 h-3.5 w-px bg-border" aria-hidden />
      <button
        type="button"
        className={iconButton}
        onClick={() => store().stepWidth(-1)}
        disabled={widthIdx <= 0}
        aria-label="Narrower column"
        title={`Narrower column (now ${CHAT_WIDTH_LABELS[width]})`}
      >
        <FoldHorizontal className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        className={iconButton}
        onClick={() => store().stepWidth(1)}
        disabled={widthIdx >= CHAT_WIDTHS.length - 1}
        aria-label="Wider column"
        title={`Wider column (now ${CHAT_WIDTH_LABELS[width]})`}
      >
        <UnfoldHorizontal className="w-3.5 h-3.5" />
      </button>
      {!isDefault && (
        <button
          type="button"
          className={iconButton}
          onClick={() => store().reset()}
          aria-label="Reset text size and width"
          title="Reset text size and width"
        >
          <RotateCcw className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
