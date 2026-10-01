/**
 * Which face of a Local session is showing: the terminal (`screen`, labeled
 * "Terminal") or the conversation distilled from the agent's transcript
 * (`transcript`, labeled "Chat"). Pure so the pane and the embedded run view
 * share one rule.
 */
export type SessionView = "screen" | "transcript";

/**
 * The view to show, or null while it can't be decided yet. An explicit
 * choice always wins. Otherwise a live session on a wide screen shows its
 * terminal (you may need to type). A finished one — or, on a narrow screen,
 * any session, as on the phones: a terminal grid doesn't read at that width,
 * and Chat has a composer — shows the conversation when there is one (the
 * recorded screen of a full-screen TUI is only its last redraw), but not
 * before the transcript fetch settles, so the xterm isn't mounted only to be
 * swapped out a moment later.
 */
export function resolveSessionView(
  choice: SessionView | null,
  state: { isDead: boolean; hasTranscript: boolean; loaded: boolean; narrow?: boolean },
): SessionView | null {
  if (choice) return choice;
  if (!state.isDead && !state.narrow) return "screen";
  if (!state.loaded) return null;
  return state.hasTranscript ? "transcript" : "screen";
}

/**
 * Whether the Chat ⇄ Terminal toggle is offered: once there is a
 * conversation, or for a live agent session whose agent writes one (Claude
 * Code, Codex) before its first entry lands — Chat then shows its empty
 * state and its composer.
 */
export function canShowChat(
  terminal: { state?: string; spec?: { kind?: string; agent?: string } | null },
  hasTranscript: boolean,
): boolean {
  if (hasTranscript) return true;
  const live = terminal.state !== "exited" && terminal.state !== "error";
  return (
    live &&
    terminal.spec?.kind === "agent" &&
    (terminal.spec.agent === "claude-code" || terminal.spec.agent === "codex")
  );
}
