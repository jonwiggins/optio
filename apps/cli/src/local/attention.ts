import type { LocalAttentionState } from "@optio/shared";
import type { ProgramStatusReport } from "./program-status.js";

/**
 * Per-terminal attention state machine (see docs/optio-local.md).
 *
 * Layered, best signal wins:
 * 0. Program status (OSC 7501) — the program says so itself: `working`,
 *    `blocked` (kind: permission / question / auth), `done`, `error`, `idle`.
 *    Once a terminal's program has reported, it owns the terminal: hooks,
 *    bells and silence are ignored for it (Claude Code sends both hooks and
 *    status, and the status is the finer of the two — a `Stop` hook followed
 *    by `idle` would otherwise leave a stale needs_you). One exception: a
 *    Codex turn boundary (layer 1) still ends a `working` status, which
 *    Codex keeps reporting after a turn while a goal is active or a
 *    background process is alive (see turnEvent).
 * 1. Claude Code hooks — once any hook fires for a terminal, heuristics are
 *    disabled for it.
 * 2. Terminal bell — a BEL that is not an OSC/DCS/APC/PM string terminator.
 * 3. Silence — output → working; 12 s of quiet after prior output means the
 *    terminal is waiting on the human → needs_you: for AGENT terminals always
 *    (reason `quiet`: a trust/login prompt before Claude Code's hooks start
 *    firing, or a non-hooked agent at its input line); for shells/commands
 *    once the human has typed in them (reason `finished`: your command is
 *    done). A shell nobody has typed in yet just went quiet at its prompt —
 *    that's idle, not a request.
 *
 * `needs_you` is sticky over the weaker heuristics: neither plain output nor
 * the silence timer may downgrade it (a bell followed by silence means the
 * terminal MOST needs you). It clears on the "the human responded" signals —
 * a UserPromptSubmit hook, or user input via onInput() — and decays to idle
 * (reason `stale`) after STALE_MS with no response, so a session you've
 * walked away from stops shouting. The decay applies to hook-owned terminals
 * too (a Stop you never answered).
 *
 * Emits transitions only. Pure of any WS concern: events surface both as the
 * return value of feed()/hookEvent()/onInput() and via the onEvent callback
 * (which also carries timer-driven idle transitions). Timers are injectable
 * for tests.
 */

export interface AttentionEvent {
  terminalId: string;
  state: LocalAttentionState;
  reason: string;
}

export interface AttentionScheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const SILENCE_MS = 12_000;
/** needs_you with no response for this long → idle (reason `stale`). */
export const STALE_MS = 2 * 60 * 60 * 1000;

/** Map a Claude Code hook event onto an attention transition (null = no-op). */
export function mapHookEvent(
  hookEventName: string,
): { state: LocalAttentionState; reason: string } | null {
  switch (hookEventName) {
    case "Stop":
      return { state: "needs_you", reason: "stop" };
    case "Notification":
      return { state: "needs_you", reason: "notification" };
    case "UserPromptSubmit":
      return { state: "working", reason: "prompt" };
    default:
      return null;
  }
}

/**
 * Map a program's own status report (OSC 7501, root record) onto an
 * attention transition. `blocked` names why in the reason (`permission`,
 * `question`, `auth`, or plain `blocked`); `clear` is not a state.
 */
export function mapProgramStatus(
  report: ProgramStatusReport,
): { state: LocalAttentionState; reason: string } | null {
  switch (report.state) {
    case "working":
      return { state: "working", reason: "status" };
    case "idle":
      return { state: "idle", reason: "status" };
    case "blocked":
      return { state: "needs_you", reason: report.kind ?? "blocked" };
    case "done":
      return { state: "needs_you", reason: "done" };
    case "error":
      return { state: "needs_you", reason: "error" };
    default:
      return null;
  }
}

const ESC = 0x1b;
const BEL = 0x07;

interface TermAttention {
  state: LocalAttentionState | null;
  reason: string | null;
  /** Agent CLI spawn: silence is read as "waiting on you", not idle. */
  agent: boolean;
  hasHooks: boolean;
  /** The program reports its own status (OSC 7501): nothing else counts. */
  hasStatus: boolean;
  producedOutput: boolean;
  /** Inside an OSC/DCS/APC/PM string sequence (survives chunk splits). */
  inString: boolean;
  /** Previous byte was ESC (survives chunk splits). */
  pendingEsc: boolean;
  silenceTimer: unknown | null;
  staleTimer: unknown | null;
  /** The human has typed in this terminal since spawn. */
  hadInput: boolean;
}

const defaultScheduler: AttentionScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class AttentionTracker {
  private readonly terminals = new Map<string, TermAttention>();
  private readonly onEvent: (event: AttentionEvent) => void;
  private readonly scheduler: AttentionScheduler;
  private readonly silenceMs: number;
  private readonly staleMs: number;

  constructor(opts: {
    onEvent?: (event: AttentionEvent) => void;
    scheduler?: AttentionScheduler;
    silenceMs?: number;
    staleMs?: number;
  }) {
    this.onEvent = opts.onEvent ?? (() => {});
    this.scheduler = opts.scheduler ?? defaultScheduler;
    this.silenceMs = opts.silenceMs ?? SILENCE_MS;
    this.staleMs = opts.staleMs ?? STALE_MS;
  }

  /**
   * Declare a terminal as an agent CLI spawn (call before its first output).
   * Flips the silence heuristic from idle to needs_you for it.
   */
  markAgent(terminalId: string): void {
    this.get(terminalId).agent = true;
  }

  /** Feed a chunk of PTY output. Returns any synchronous transitions. */
  feed(terminalId: string, chunk: Buffer): AttentionEvent[] {
    const t = this.get(terminalId);
    if (t.hasHooks || t.hasStatus) return []; // hooks or the program own this terminal

    const events: AttentionEvent[] = [];
    t.producedOutput = true;

    // Any output → working (only when not already working), EXCEPT while
    // needs_you: a bell-flagged terminal redrawing its prompt is still
    // waiting on the user — only input or a hook clears it.
    if (t.state !== "needs_you") {
      const working = this.transition(t, terminalId, "working", "output");
      if (working) events.push(working);
    }

    for (const byte of chunk) {
      if (t.pendingEsc) {
        t.pendingEsc = false;
        if (t.inString) {
          if (byte === 0x5c) {
            // ESC \ (ST) terminates the string
            t.inString = false;
            continue;
          }
          // Not ST — fall through and process the byte normally (still in string).
        } else if (byte === 0x5d || byte === 0x50 || byte === 0x5f || byte === 0x5e) {
          // ESC ] (OSC), ESC P (DCS), ESC _ (APC), ESC ^ (PM) open a string
          t.inString = true;
          continue;
        }
        // Any other byte after ESC: process normally below.
      }
      if (byte === ESC) {
        t.pendingEsc = true;
        continue;
      }
      if (byte === BEL) {
        if (t.inString) {
          // BEL terminates the string sequence — not an attention bell.
          t.inString = false;
          continue;
        }
        const bell = this.transition(t, terminalId, "needs_you", "bell");
        if (bell) events.push(bell);
      }
    }

    this.resetSilenceTimer(terminalId, t);
    return events;
  }

  /** A Claude Code hook fired for this terminal. Returns any transition. */
  hookEvent(terminalId: string, hookEventName: string): AttentionEvent[] {
    const t = this.get(terminalId);
    if (t.hasStatus) return []; // the program reports its own status
    if (!t.hasHooks) {
      t.hasHooks = true;
      this.clearSilenceTimer(t);
    }
    const mapped = mapHookEvent(hookEventName);
    if (!mapped) return [];
    const event = this.transition(t, terminalId, mapped.state, mapped.reason);
    return event ? [event] : [];
  }

  /**
   * A Codex rollout marked a turn boundary for this terminal. Until the
   * program reports its own status this has the same authority as a Claude
   * Code hook (a turn started → working; a turn ended → needs_you) and like
   * hooks it retires the heuristics: Codex's TUI keeps repainting after it
   * finishes, so silence never comes.
   *
   * Once Codex reports status (0.164+), the boundary still rules on one
   * thing: a turn that ended while the status says `working` is a halt the
   * status will not report. Codex keeps reporting `working` after a turn
   * while a thread goal (`/goal`) is active or a background process it
   * started is alive — even as it sits at its prompt waiting for you — and
   * since it only sends a status that changed, no later report corrects it.
   * The status keeps saying what it alone knows: `blocked` and its kind,
   * `idle` on your keystroke, `done` when nothing keeps it "working".
   */
  turnEvent(terminalId: string, signal: "started" | "complete" | "aborted"): AttentionEvent[] {
    const t = this.get(terminalId);
    if (!t.hasStatus) {
      return this.hookEvent(terminalId, signal === "started" ? "UserPromptSubmit" : "Stop");
    }
    if (signal === "started") {
      if (t.state === "working") return [];
      const event = this.transition(t, terminalId, "working", "prompt");
      return event ? [event] : [];
    }
    if (t.state !== "working") return [];
    const event = this.transition(t, terminalId, "needs_you", "stop");
    return event ? [event] : [];
  }

  /**
   * The program reported its own status over OSC 7501 (from the screen
   * model). The first report retires every other signal for the terminal.
   * Only the root record drives attention: a subagent's record (`id`) says
   * nothing about whether the program as a whole is waiting on you, and
   * `clear` removes records without saying what the program is doing.
   */
  statusEvent(terminalId: string, report: ProgramStatusReport): AttentionEvent[] {
    const t = this.get(terminalId);
    if (!t.hasStatus) {
      t.hasStatus = true;
      this.clearSilenceTimer(t);
    }
    if (report.id !== null) return [];
    const mapped = mapProgramStatus(report);
    if (!mapped) return [];
    const event = this.transition(t, terminalId, mapped.state, mapped.reason);
    return event ? [event] : [];
  }

  /**
   * User input was written to the terminal's PTY — "the human responded".
   * Clears needs_you (and idle) back to working. Hook-owned terminals are
   * untouched: their UserPromptSubmit hook is the authoritative signal.
   */
  onInput(terminalId: string): AttentionEvent[] {
    const t = this.get(terminalId);
    t.hadInput = true;
    // Any keystroke answers a needs_you for staleness purposes, even on a
    // hook-owned terminal (an Enter in a menu fires no UserPromptSubmit).
    this.clearStaleTimer(t);
    if (t.hasHooks || t.hasStatus) return []; // hooks or the program own this terminal
    if (t.state !== "needs_you" && t.state !== "idle") return [];
    const event = this.transition(t, terminalId, "working", "input");
    this.resetSilenceTimer(terminalId, t);
    return event ? [event] : [];
  }

  /** Whether hooks have fired for a terminal (heuristics disabled). */
  hasHooks(terminalId: string): boolean {
    return this.terminals.get(terminalId)?.hasHooks ?? false;
  }

  /** Whether the program reports its own status for a terminal (everything else ignored). */
  hasStatus(terminalId: string): boolean {
    return this.terminals.get(terminalId)?.hasStatus ?? false;
  }

  /** Forget a terminal (on exit): clears its timer and state. */
  remove(terminalId: string): void {
    const t = this.terminals.get(terminalId);
    if (!t) return;
    this.clearSilenceTimer(t);
    this.clearStaleTimer(t);
    this.terminals.delete(terminalId);
  }

  private get(terminalId: string): TermAttention {
    let t = this.terminals.get(terminalId);
    if (!t) {
      t = {
        state: null,
        reason: null,
        agent: false,
        hasHooks: false,
        hasStatus: false,
        producedOutput: false,
        inString: false,
        pendingEsc: false,
        silenceTimer: null,
        staleTimer: null,
        hadInput: false,
      };
      this.terminals.set(terminalId, t);
    }
    return t;
  }

  /** Emit only on (state, reason) change. */
  private transition(
    t: TermAttention,
    terminalId: string,
    state: LocalAttentionState,
    reason: string,
  ): AttentionEvent | null {
    if (t.state === state && t.reason === reason) return null;
    t.state = state;
    t.reason = reason;
    if (state === "needs_you") this.armStaleTimer(terminalId, t);
    else this.clearStaleTimer(t);
    const event: AttentionEvent = { terminalId, state, reason };
    this.onEvent(event);
    return event;
  }

  private armStaleTimer(terminalId: string, t: TermAttention): void {
    this.clearStaleTimer(t);
    t.staleTimer = this.scheduler.setTimeout(() => {
      t.staleTimer = null;
      if (t.state !== "needs_you") return;
      this.transition(t, terminalId, "idle", "stale");
    }, this.staleMs);
  }

  private clearStaleTimer(t: TermAttention): void {
    if (t.staleTimer !== null) {
      this.scheduler.clearTimeout(t.staleTimer);
      t.staleTimer = null;
    }
  }

  private resetSilenceTimer(terminalId: string, t: TermAttention): void {
    this.clearSilenceTimer(t);
    t.silenceTimer = this.scheduler.setTimeout(() => {
      t.silenceTimer = null;
      // Silence is the weakest signal: it only moves a `working` terminal.
      // A needs_you terminal that goes quiet is still waiting on the user.
      if (t.hasHooks || t.hasStatus || !t.producedOutput || t.state !== "working") return;
      if (t.agent) this.transition(t, terminalId, "needs_you", "quiet");
      else if (t.hadInput) this.transition(t, terminalId, "needs_you", "finished");
      else this.transition(t, terminalId, "idle", "silence");
    }, this.silenceMs);
  }

  private clearSilenceTimer(t: TermAttention): void {
    if (t.silenceTimer !== null) {
      this.scheduler.clearTimeout(t.silenceTimer);
      t.silenceTimer = null;
    }
  }
}
