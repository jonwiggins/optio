import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import {
  costForTokens,
  priceForModel,
  type LocalTerminalUsage,
  type TokenCounts,
} from "@optio/shared";

/**
 * Sums a Claude Code transcript (the JSONL at the Stop hook's
 * `transcript_path`) into per-terminal token / cost totals.
 *
 * Reads are incremental: each terminal remembers the byte offset it has
 * consumed, so a long session is not re-parsed on every turn. Assistant
 * turns are keyed by (message.id, requestId) because Claude Code writes one
 * JSONL line per content block and repeats the same `usage` on each — the
 * first line wins. Subagent (sidechain) lines count: they were billed.
 */

interface TerminalUsageState {
  transcriptPath: string;
  offset: number;
  /** Trailing partial line carried to the next read. */
  carry: string;
  seen: Set<string>;
  totals: TokenCounts;
  turns: number;
  costUsd: number;
  /** Whether every counted turn had a price; else cost is reported as null. */
  priced: boolean;
  modelCounts: Map<string, number>;
}

const READ_CHUNK = 1 << 20;

function emptyState(transcriptPath: string): TerminalUsageState {
  return {
    transcriptPath,
    offset: 0,
    carry: "",
    seen: new Set(),
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    turns: 0,
    costUsd: 0,
    priced: true,
    modelCounts: new Map(),
  };
}

/** Parse one JSONL line into the turn it represents, or null when it isn't one. */
export function parseTranscriptLine(
  line: string,
): { key: string; model: string | null; tokens: TokenCounts } | null {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (!d || d.type !== "assistant" || !d.message || typeof d.message !== "object") return null;
  const usage = d.message.usage;
  if (!usage || typeof usage !== "object") return null;
  const id = typeof d.message.id === "string" ? d.message.id : null;
  const requestId = typeof d.requestId === "string" ? d.requestId : null;
  // Without any id the line can't be deduplicated; fall back to its uuid.
  const key =
    `${id ?? ""}|${requestId ?? ""}` === "|"
      ? `uuid:${d.uuid ?? line.length}`
      : `${id ?? ""}|${requestId ?? ""}`;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    key,
    model: typeof d.message.model === "string" ? d.message.model : null,
    tokens: {
      inputTokens: n(usage.input_tokens),
      outputTokens: n(usage.output_tokens),
      cacheReadTokens: n(usage.cache_read_input_tokens),
      cacheWriteTokens: n(usage.cache_creation_input_tokens),
    },
  };
}

export class UsageTracker {
  private byTerminal = new Map<string, TerminalUsageState>();

  /**
   * Point a terminal at its transcript (from the first hook that names it)
   * and fold in whatever has been appended since the last call. Returns the
   * new totals, or null when nothing changed.
   */
  update(terminalId: string, transcriptPath: string): LocalTerminalUsage | null {
    let state = this.byTerminal.get(terminalId);
    if (!state || state.transcriptPath !== transcriptPath) {
      // A new session id (e.g. `claude --resume` inside the same terminal)
      // means a new transcript; start over rather than double count.
      state = emptyState(transcriptPath);
      this.byTerminal.set(terminalId, state);
    }
    const before = state.turns;
    this.consume(state);
    if (state.turns === before) return null;
    return this.snapshot(state);
  }

  current(terminalId: string): LocalTerminalUsage | null {
    const state = this.byTerminal.get(terminalId);
    return state && state.turns > 0 ? this.snapshot(state) : null;
  }

  remove(terminalId: string): void {
    this.byTerminal.delete(terminalId);
  }

  private consume(state: TerminalUsageState): void {
    let fd: number;
    try {
      fd = openSync(state.transcriptPath, "r");
    } catch {
      return; // transcript not there (yet) — the next hook retries
    }
    try {
      const size = fstatSync(fd).size;
      if (size < state.offset) {
        // Truncated / rewritten: re-read from the top, dedupe protects totals.
        state.offset = 0;
        state.carry = "";
      }
      const buf = Buffer.allocUnsafe(READ_CHUNK);
      while (state.offset < size) {
        const n = readSync(fd, buf, 0, READ_CHUNK, state.offset);
        if (n <= 0) break;
        state.offset += n;
        const text = state.carry + buf.toString("utf-8", 0, n);
        const lines = text.split("\n");
        state.carry = lines.pop() ?? "";
        for (const line of lines) this.fold(state, line);
      }
    } finally {
      closeSync(fd);
    }
  }

  private fold(state: TerminalUsageState, line: string): void {
    if (!line.trim()) return;
    const turn = parseTranscriptLine(line);
    if (!turn || state.seen.has(turn.key)) return;
    state.seen.add(turn.key);
    state.turns++;
    state.totals.inputTokens += turn.tokens.inputTokens;
    state.totals.outputTokens += turn.tokens.outputTokens;
    state.totals.cacheReadTokens += turn.tokens.cacheReadTokens;
    state.totals.cacheWriteTokens += turn.tokens.cacheWriteTokens;
    if (turn.model) state.modelCounts.set(turn.model, (state.modelCounts.get(turn.model) ?? 0) + 1);
    const price = priceForModel(turn.model);
    if (price) state.costUsd += costForTokens(turn.tokens, price);
    else state.priced = false;
  }

  private snapshot(state: TerminalUsageState): LocalTerminalUsage {
    let model: string | null = null;
    let best = 0;
    for (const [m, c] of state.modelCounts) {
      if (c > best) {
        best = c;
        model = m;
      }
    }
    return {
      ...state.totals,
      turns: state.turns,
      model,
      costUsd: state.priced ? Math.round(state.costUsd * 1e6) / 1e6 : null,
      updatedAt: new Date().toISOString(),
    };
  }
}
