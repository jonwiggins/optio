import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentLimitWindow, LocalHostAgentLimits } from "@optio/shared";

/**
 * Codex CLI writes a `rate_limits` block into every `token_count` event of
 * its session rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`).
 * The newest one is the last thing Codex knew about the plan's limits —
 * no token needed, and the auth file's access token is usually expired
 * anyway. Freshness is whatever the last Codex turn was; callers show it.
 */

const TAIL_BYTES = 512 * 1024;
const MAX_FILES = 12;

export function codexSessionsDir(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
}

/** Newest rollout files first (by mtime), walking YYYY/MM/DD. */
export function listRolloutFiles(root: string, max = MAX_FILES): string[] {
  const files: Array<{ path: string; mtime: number }> = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 3) walk(p, depth + 1);
      } else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) {
        files.push({ path: p, mtime: st.mtimeMs });
      }
    }
  };
  walk(root, 0);
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, max)
    .map((f) => f.path);
}

function window(raw: any): AgentLimitWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const used = typeof raw.used_percent === "number" ? raw.used_percent : null;
  if (used == null) return null;
  const resets =
    typeof raw.resets_at === "number"
      ? new Date(raw.resets_at * 1000).toISOString()
      : typeof raw.resets_at === "string"
        ? raw.resets_at
        : null;
  return {
    usedPercent: Math.max(0, Math.min(100, used)),
    windowMinutes: typeof raw.window_minutes === "number" ? raw.window_minutes : null,
    resetsAt: resets,
  };
}

/** Parse one rollout line; returns the snapshot when it carries rate limits. */
export function parseRolloutLine(line: string): LocalHostAgentLimits["codex"] | null {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  const rl = d?.payload?.rate_limits;
  if (!rl || typeof rl !== "object") return null;
  const primary = window(rl.primary);
  const secondary = window(rl.secondary);
  if (!primary && !secondary) return null;
  return {
    primary,
    secondary,
    planType: typeof rl.plan_type === "string" ? rl.plan_type : null,
    observedAt:
      typeof d.timestamp === "string" && !isNaN(Date.parse(d.timestamp))
        ? new Date(d.timestamp).toISOString()
        : new Date().toISOString(),
  };
}

/** Last rate-limit snapshot in a file (reads only the tail). */
export function lastLimitsInFile(path: string): LocalHostAgentLimits["codex"] | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf-8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      const parsed = parseRolloutLine(lines[i]);
      if (parsed) return parsed;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The newest snapshot across recent rollouts, or null when Codex has never run here. */
export function readCodexLimits(root = codexSessionsDir()): LocalHostAgentLimits["codex"] | null {
  let best: LocalHostAgentLimits["codex"] | null = null;
  for (const file of listRolloutFiles(root)) {
    const found = lastLimitsInFile(file);
    if (found && (!best || found.observedAt > best.observedAt)) best = found;
  }
  return best;
}

/** Everything the daemon can read about agent limits on this machine. */
export function readAgentLimits(): LocalHostAgentLimits {
  const limits: LocalHostAgentLimits = {};
  const codex = readCodexLimits();
  if (codex) limits.codex = codex;
  return limits;
}
