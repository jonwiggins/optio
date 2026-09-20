import { shellSingleQuote } from "../utils/pod-env.js";

/**
 * Pure helpers for the interactive session chat's conversation continuity.
 *
 * The chat runs one `claude -p` exec per user message. To make those execs a
 * single conversation we capture Claude's `session_id` from the first
 * stream-json event and pass `--resume <id>` on every later prompt. If the
 * resume fails (the worktree was recreated, the pod was replaced, Claude's
 * session store was wiped) we clear the stored id and re-run the prompt as a
 * fresh conversation.
 */

/** Sentinel printed after `claude` exits so the WS handler can see its exit code. */
export const CHAT_EXIT_SENTINEL = "__OPTIO_CHAT_EXIT__:";

export interface ClaudeChatCommandOptions {
  prompt: string;
  model?: string | null;
  resumeSessionId?: string | null;
}

/**
 * Build the `claude -p` invocation for one chat turn. Everything user- or
 * DB-controlled is single-quoted so it can never break out into the shell.
 * Exits are reported through {@link CHAT_EXIT_SENTINEL} rather than `set -e`
 * so the caller can tell a failed resume from a normal turn.
 */
export function buildClaudeChatCommand(opts: ClaudeChatCommandOptions): string {
  const parts = ["claude", "-p", shellSingleQuote(opts.prompt)];
  if (opts.model) parts.push("--model", shellSingleQuote(opts.model));
  if (opts.resumeSessionId) parts.push("--resume", shellSingleQuote(opts.resumeSessionId));
  parts.push("--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions");
  // `< /dev/null`: the prompt is on the command line; without this claude waits
  // 3s on the exec's open stdin and prints a "no stdin data" warning each turn.
  return `rc=0; ${parts.join(" ")} < /dev/null 2>&1 || rc=$?; echo "${CHAT_EXIT_SENTINEL}$rc"`;
}

/** Parse the exit sentinel line; `null` when the line is ordinary output. */
export function parseExitSentinel(line: string): number | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(CHAT_EXIT_SENTINEL)) return null;
  const code = Number.parseInt(trimmed.slice(CHAT_EXIT_SENTINEL.length), 10);
  return Number.isFinite(code) ? code : 1;
}

export interface ClaudeLineInfo {
  /** `{"type":"system","subtype":"init"}` — the first event of a real conversation. */
  isInit: boolean;
  /** `{"type":"result","is_error":true}` — how a failed `--resume` is reported. */
  isErrorResult: boolean;
  /** `session_id` carried by the event, if the line was a stream-json event. */
  sessionId?: string;
}

/**
 * Inspect one line of `claude -p --output-format stream-json` output.
 *
 * A failed `--resume` prints a raw "No conversation found with session ID: …"
 * line followed by a `result` event with `is_error: true`, `num_turns: 0` and
 * a brand-new `session_id` — and never an init event. So the session id worth
 * remembering is the one on the init event, and "did this turn start a real
 * conversation" is "did we see init".
 */
export function inspectClaudeLine(line: string): ClaudeLineInfo {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return { isInit: false, isErrorResult: false };
  let event: any;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return { isInit: false, isErrorResult: false };
  }
  if (!event || typeof event !== "object") return { isInit: false, isErrorResult: false };
  const sessionId =
    typeof event.session_id === "string" && event.session_id.length > 0
      ? (event.session_id as string)
      : undefined;
  return {
    isInit: event.type === "system" && event.subtype === "init",
    isErrorResult: event.type === "result" && event.is_error === true,
    sessionId,
  };
}

/**
 * Session id to resume from, taken only from the init event
 * (`{"type":"system","subtype":"init","session_id":...}`); `undefined` for
 * every other line, including the error `result` a failed resume emits.
 */
export function extractSessionIdFromLine(line: string): string | undefined {
  const info = inspectClaudeLine(line);
  return info.isInit ? info.sessionId : undefined;
}

/** Output fragments Claude Code prints when `--resume <id>` can't find the session. */
const RESUME_FAILURE_PATTERNS = [
  /no conversation found/i,
  /session .*not found/i,
  /could not find session/i,
  /unable to resume/i,
  /failed to resume/i,
  /invalid session id/i,
];

export interface ResumeOutcomeInput {
  /** Whether this turn was launched with `--resume`. */
  resumed: boolean;
  /** Exit code reported by the sentinel (`null` if the sentinel never arrived). */
  exitCode: number | null;
  /** Whether the init event was seen, i.e. a real conversation started. */
  sawInit: boolean;
  /** Whether a `result` event with `is_error: true` was seen. */
  sawErrorResult: boolean;
  /** Raw (non-JSON) output collected during the turn, for pattern matching. */
  rawOutput: string;
}

/**
 * Decide whether a finished turn was a failed `--resume` that should be
 * retried as a fresh conversation. Only a resumed turn that never reached the
 * init event qualifies — a turn that got that far was a real conversation,
 * whatever happened afterwards. Among those, a known "session missing"
 * message, an error `result`, or a non-zero exit all count as a failed resume.
 */
export function shouldFallbackToFreshSession(input: ResumeOutcomeInput): boolean {
  if (!input.resumed || input.sawInit) return false;
  if (RESUME_FAILURE_PATTERNS.some((re) => re.test(input.rawOutput))) return true;
  if (input.sawErrorResult) return true;
  return input.exitCode !== null && input.exitCode !== 0;
}
