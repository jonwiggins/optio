import type { LogEntry } from "@/hooks/use-logs";

/**
 * How the log viewer folds a task's entries into rows: a tool call with
 * its result as one group, a run of consecutive "thinking" entries as one
 * fold (the agent's reasoning between two visible steps reads as one
 * thought), everything else one row each. `index` is the first entry's
 * position in the list the groups were built from, which search and
 * collapse state key on.
 */
export type LogGroup =
  | { type: "single"; entry: LogEntry; index: number }
  | { type: "tool_call"; use: LogEntry; result?: LogEntry; index: number }
  | { type: "thinking"; entries: LogEntry[]; index: number };

export function groupLogs(logs: LogEntry[], showResults: boolean): LogGroup[] {
  const groups: LogGroup[] = [];
  let i = 0;
  while (i < logs.length) {
    const entry = logs[i];
    if (entry.logType === "tool_use") {
      const next = i + 1 < logs.length ? logs[i + 1] : null;
      if (next?.logType === "tool_result") {
        groups.push({ type: "tool_call", use: entry, result: next, index: i });
        i += 2;
        continue;
      }
      groups.push({ type: "tool_call", use: entry, index: i });
      i++;
      continue;
    }
    if (entry.logType === "tool_result" && !showResults) {
      i++;
      continue;
    }
    if (entry.logType === "thinking") {
      const entries = [entry];
      let j = i + 1;
      while (j < logs.length && logs[j].logType === "thinking") {
        entries.push(logs[j]);
        j++;
      }
      groups.push({ type: "thinking", entries, index: i });
      i = j;
      continue;
    }
    groups.push({ type: "single", entry, index: i });
    i++;
  }
  return groups;
}

/** The positions a group covers, for search highlighting. */
export function groupIndices(g: LogGroup): number[] {
  if (g.type === "tool_call") return g.result ? [g.index, g.index + 1] : [g.index];
  if (g.type === "thinking") return g.entries.map((_, k) => g.index + k);
  return [g.index];
}

/**
 * The tokens a fold's thinking took: the parser's count per entry
 * (`metadata.thinkingTokens`, from the API's usage) when every entry has
 * one, else a rough estimate from the text (about four characters a
 * token), marked as such.
 */
export function thinkingTokens(entries: LogEntry[]): { tokens: number; estimated: boolean } {
  let tokens = 0;
  let estimated = false;
  for (const e of entries) {
    const counted = e.metadata?.thinkingTokens;
    if (typeof counted === "number" && counted >= 0) tokens += counted;
    else {
      tokens += Math.ceil(e.content.length / 4);
      estimated = true;
    }
  }
  return { tokens, estimated };
}

/** "Thinking (3 blocks · ~1.2K tokens)". */
export function thinkingSummary(entries: LogEntry[]): string {
  const { tokens, estimated } = thinkingTokens(entries);
  const n = entries.length;
  const count =
    tokens >= 1000 ? `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}K` : String(tokens);
  return `Thinking (${n} block${n === 1 ? "" : "s"} · ${estimated ? "~" : ""}${count} tokens)`;
}
