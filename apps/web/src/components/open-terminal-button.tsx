"use client";

import { Columns2, Loader2, SquareTerminal } from "lucide-react";

export function OpenTerminalButton({
  onClick,
  busy = false,
  disabled = false,
}: {
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      aria-label="Open terminal here"
      title={
        disabled
          ? "Close a pane before opening another terminal"
          : "Open a terminal in this session’s directory, side by side on the same machine or pod"
      }
      className="inline-flex h-7 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover/70 hover:text-text disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <span className="relative h-4 w-5" aria-hidden>
          <Columns2 className="absolute left-0 top-0 h-4 w-4" />
          <SquareTerminal className="absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-sm bg-bg" />
        </span>
      )}
    </button>
  );
}
