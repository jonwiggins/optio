/**
 * Per-session agent usage, as summed from a Claude Code transcript by the
 * Optio Local daemon and shown in the terminal header. Token counts are
 * exact (they're what the API billed); the dollar figure is an estimate
 * from the public per-token prices below.
 */
export interface LocalTerminalUsage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Assistant turns (API calls) counted. */
  turns: number;
  /** Most-used model id, for the header label. */
  model: string | null;
  /** Estimated spend in USD; null when no model matched the price table. */
  costUsd: number | null;
  updatedAt: string;
}

export interface ModelPrice {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Public Claude API list prices (USD / MTok). Cache write is priced at the
 * 5-minute rate (1.25× input); cache read at 0.1× input except where the
 * model has a flat published rate. Ordered longest prefix first so
 * `claude-opus-4-5` doesn't match the `claude-opus-4` row.
 */
const PRICES: Array<[prefix: string, price: ModelPrice]> = [
  ["claude-fable-5-1", { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
  ["claude-mythos-5-1", { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
  ["claude-fable-5", { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-opus-4-8", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-opus-4-7", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-opus-4-6", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-opus-4-5", { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  ["claude-opus-4-1", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ["claude-opus-4", { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  ["claude-sonnet-4", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  ["claude-haiku-4", { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  ["claude-3-5-haiku", { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
];

export function priceForModel(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const [prefix, price] of PRICES) {
    if (m.startsWith(prefix)) return price;
  }
  return null;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** USD for one call's tokens at `price`. */
export function costForTokens(t: TokenCounts, price: ModelPrice): number {
  return (
    (t.inputTokens * price.input +
      t.outputTokens * price.output +
      t.cacheReadTokens * price.cacheRead +
      t.cacheWriteTokens * price.cacheWrite) /
    1_000_000
  );
}

/** Compact token count for a chip: 950 → "950", 12_345 → "12.3k", 2_100_000 → "2.1M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "$0.42", "$12.30"; sub-cent shows "<$0.01". */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
