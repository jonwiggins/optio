/**
 * Which face of a Local session is showing: the terminal (`screen`) or the
 * conversation distilled from the agent's transcript (`transcript`). Pure
 * so the pane and the embedded run view share one rule.
 */
export type SessionView = "screen" | "transcript";

/**
 * The view to show, or null while it can't be decided yet. An explicit
 * choice always wins. Otherwise a live session shows its screen (you may
 * need to type), and a finished one shows the conversation when there is
 * one — the recorded screen of a full-screen TUI is only its last redraw —
 * but not before the transcript fetch settles, so the xterm isn't mounted
 * only to be swapped out a moment later.
 */
export function resolveSessionView(
  choice: SessionView | null,
  state: { isDead: boolean; hasTranscript: boolean; loaded: boolean },
): SessionView | null {
  if (choice) return choice;
  if (!state.isDead) return "screen";
  if (!state.loaded) return null;
  return state.hasTranscript ? "transcript" : "screen";
}
