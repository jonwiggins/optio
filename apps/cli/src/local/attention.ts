import type { LocalAttentionState } from "@optio/shared";

/**
 * Per-terminal attention state machine (see docs/optio-local.md).
 *
 * Layered, best signal wins:
 * 1. Claude Code hooks — once any hook fires for a terminal, heuristics are
 *    disabled for it.
 * 2. Terminal bell — a BEL that is not an OSC/DCS/APC/PM string terminator.
 * 3. Silence — output → working; 12 s of quiet after prior output → idle
 *    (deliberately NOT needs_you).
 *
 * `needs_you` is sticky over the weaker heuristics: neither plain output nor
 * the silence timer may downgrade it (a bell followed by silence means the
 * terminal MOST needs you). It clears only on the "the human responded"
 * signals — a UserPromptSubmit hook, or user input via onInput().
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

const ESC = 0x1b;
const BEL = 0x07;

interface TermAttention {
  state: LocalAttentionState | null;
  reason: string | null;
  hasHooks: boolean;
  producedOutput: boolean;
  /** Inside an OSC/DCS/APC/PM string sequence (survives chunk splits). */
  inString: boolean;
  /** Previous byte was ESC (survives chunk splits). */
  pendingEsc: boolean;
  silenceTimer: unknown | null;
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

  constructor(opts: {
    onEvent?: (event: AttentionEvent) => void;
    scheduler?: AttentionScheduler;
    silenceMs?: number;
  }) {
    this.onEvent = opts.onEvent ?? (() => {});
    this.scheduler = opts.scheduler ?? defaultScheduler;
    this.silenceMs = opts.silenceMs ?? SILENCE_MS;
  }

  /** Feed a chunk of PTY output. Returns any synchronous transitions. */
  feed(terminalId: string, chunk: Buffer): AttentionEvent[] {
    const t = this.get(terminalId);
    if (t.hasHooks) return []; // hooks own this terminal

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
   * User input was written to the terminal's PTY — "the human responded".
   * Clears needs_you (and idle) back to working. Hook-owned terminals are
   * untouched: their UserPromptSubmit hook is the authoritative signal.
   */
  onInput(terminalId: string): AttentionEvent[] {
    const t = this.get(terminalId);
    if (t.hasHooks) return []; // hooks own this terminal
    if (t.state !== "needs_you" && t.state !== "idle") return [];
    const event = this.transition(t, terminalId, "working", "input");
    this.resetSilenceTimer(terminalId, t);
    return event ? [event] : [];
  }

  /** Whether hooks have fired for a terminal (heuristics disabled). */
  hasHooks(terminalId: string): boolean {
    return this.terminals.get(terminalId)?.hasHooks ?? false;
  }

  /** Forget a terminal (on exit): clears its timer and state. */
  remove(terminalId: string): void {
    const t = this.terminals.get(terminalId);
    if (!t) return;
    this.clearSilenceTimer(t);
    this.terminals.delete(terminalId);
  }

  private get(terminalId: string): TermAttention {
    let t = this.terminals.get(terminalId);
    if (!t) {
      t = {
        state: null,
        reason: null,
        hasHooks: false,
        producedOutput: false,
        inString: false,
        pendingEsc: false,
        silenceTimer: null,
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
    const event: AttentionEvent = { terminalId, state, reason };
    this.onEvent(event);
    return event;
  }

  private resetSilenceTimer(terminalId: string, t: TermAttention): void {
    this.clearSilenceTimer(t);
    t.silenceTimer = this.scheduler.setTimeout(() => {
      t.silenceTimer = null;
      // Silence is the weakest signal: it only downgrades working → idle.
      // A needs_you terminal that goes quiet is still waiting on the user.
      if (t.hasHooks || !t.producedOutput || t.state !== "working") return;
      this.transition(t, terminalId, "idle", "silence");
    }, this.silenceMs);
  }

  private clearSilenceTimer(t: TermAttention): void {
    if (t.silenceTimer !== null) {
      this.scheduler.clearTimeout(t.silenceTimer);
      t.silenceTimer = null;
    }
  }
}
