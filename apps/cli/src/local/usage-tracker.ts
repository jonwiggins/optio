import {
  costForTokens,
  priceForModel,
  type LocalTerminalUsage,
  type TokenCounts,
} from "@optio/shared";
import { JsonlTail } from "./jsonl-tail.js";
import type { TranscriptFormat } from "./transcript-tracker.js";

/**
 * Sums Claude Code transcripts and Codex rollouts into token / cost totals.
 *
 * Reads are incremental (JsonlTail remembers the byte offset consumed per
 * terminal), so a long session is not re-parsed on every turn. Assistant
 * turns are keyed by (message.id, requestId) because Claude Code writes one
 * JSONL line per content block and repeats the same `usage` on each — the
 * first line wins. Subagent (sidechain) lines count: they were billed.
 */

interface TerminalUsageState {
  transcriptPath: string;
  format: TranscriptFormat;
  tail: JsonlTail;
  seen: Set<string>;
  totals: TokenCounts;
  turns: number;
  costUsd: number;
  /** Whether every counted turn had a price; else cost is reported as null. */
  priced: boolean;
  modelCounts: Map<string, number>;
  codexModel: string | null;
  codexServiceTier: string | null;
  codexTotals: TokenCounts;
}

function emptyState(transcriptPath: string, format: TranscriptFormat): TerminalUsageState {
  return {
    transcriptPath,
    format,
    tail: new JsonlTail(transcriptPath),
    seen: new Set(),
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    turns: 0,
    costUsd: 0,
    priced: true,
    modelCounts: new Map(),
    codexModel: null,
    codexServiceTier: null,
    codexTotals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
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
  update(
    terminalId: string,
    transcriptPath: string,
    format: TranscriptFormat = "claude",
  ): LocalTerminalUsage | null {
    let state = this.byTerminal.get(terminalId);
    if (!state || state.transcriptPath !== transcriptPath || state.format !== format) {
      // A new session id (e.g. `claude --resume` inside the same terminal)
      // means a new transcript; start over rather than double count.
      state = emptyState(transcriptPath, format);
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
    state.tail.readNew((line) => this.fold(state, line));
  }

  private fold(state: TerminalUsageState, line: string): void {
    if (!line.trim()) return;
    if (state.format === "codex") {
      this.foldCodex(state, line);
      return;
    }
    const turn = parseTranscriptLine(line);
    if (!turn || state.seen.has(turn.key)) return;
    state.seen.add(turn.key);
    this.addTurn(state, turn.tokens, turn.model);
  }

  private addTurn(
    state: TerminalUsageState,
    tokens: TokenCounts,
    model: string | null,
    context?: { inputTokens?: number; serviceTier?: string | null },
  ): void {
    state.turns++;
    state.totals.inputTokens += tokens.inputTokens;
    state.totals.outputTokens += tokens.outputTokens;
    state.totals.cacheReadTokens += tokens.cacheReadTokens;
    state.totals.cacheWriteTokens += tokens.cacheWriteTokens;
    if (model) state.modelCounts.set(model, (state.modelCounts.get(model) ?? 0) + 1);
    const price = priceForModel(model, context);
    if (price) state.costUsd += costForTokens(tokens, price);
    else state.priced = false;
  }

  private foldCodex(state: TerminalUsageState, line: string): void {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    const payload = event?.payload;
    if (!payload) return;
    if (event.type === "turn_context" || event.type === "session_meta") {
      if (typeof payload.model === "string") state.codexModel = payload.model;
      if (event.type === "turn_context")
        state.codexServiceTier =
          typeof payload.service_tier === "string" ? payload.service_tier : null;
      return;
    }
    if (event.type !== "event_msg" || payload.type !== "token_count") return;
    const raw = payload.info?.total_token_usage;
    if (!raw || typeof raw.input_tokens !== "number" || typeof raw.output_tokens !== "number")
      return;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
    const next = {
      // Codex input includes cached tokens; reasoning is already in output.
      inputTokens: n(raw.input_tokens),
      outputTokens: n(raw.output_tokens),
      cacheReadTokens: n(raw.cached_input_tokens),
      cacheWriteTokens: n(raw.cache_write_input_tokens),
    };
    const keys = Object.keys(next) as Array<keyof TokenCounts>;
    // Rate-limit refreshes repeat totals. Replayed / stale snapshots must not
    // reduce the high-water mark and bill the same tokens a second time.
    if (keys.some((k) => next[k] < state.codexTotals[k])) return;
    const delta = Object.fromEntries(
      keys.map((k) => [k, next[k] - state.codexTotals[k]]),
    ) as unknown as TokenCounts;
    if (!keys.some((k) => delta[k] > 0)) return;
    state.codexTotals = next;
    const inputTokens = n(payload.info.last_token_usage?.input_tokens) || delta.inputTokens;
    delta.inputTokens = Math.max(
      0,
      delta.inputTokens - delta.cacheReadTokens - delta.cacheWriteTokens,
    );
    this.addTurn(state, delta, state.codexModel, {
      inputTokens,
      serviceTier: state.codexServiceTier,
    });
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
