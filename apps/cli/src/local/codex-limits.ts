import { spawn } from "node:child_process";
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentLimitWindow, LocalHostAgentLimits } from "@optio/shared";
import { scrubSpawnEnv } from "./terminal-manager.js";

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

/** A window as Codex's app server reports it (`account/rateLimits/read`). */
function liveWindow(raw: unknown): AgentLimitWindow | null {
  const w = raw as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown };
  if (!w || typeof w !== "object" || typeof w.usedPercent !== "number") return null;
  return {
    usedPercent: Math.max(0, Math.min(100, w.usedPercent)),
    windowMinutes: typeof w.windowDurationMins === "number" ? w.windowDurationMins : null,
    resetsAt: typeof w.resetsAt === "number" ? new Date(w.resetsAt * 1000).toISOString() : null,
  };
}

/** Codex's `GetAccountRateLimitsResponse` as the limits Optio shows; null when it has none. */
export function parseLiveCodexLimits(
  result: unknown,
  now = new Date(),
): LocalHostAgentLimits["codex"] | null {
  const r =
    (result as { rateLimits?: unknown; rateLimitsByLimitId?: Record<string, unknown> })
      ?.rateLimitsByLimitId?.codex ?? (result as { rateLimits?: unknown })?.rateLimits;
  const snap = r as { primary?: unknown; secondary?: unknown; planType?: unknown } | undefined;
  if (!snap || typeof snap !== "object") return null;
  const primary = liveWindow(snap.primary);
  const secondary = liveWindow(snap.secondary);
  if (!primary && !secondary) return null;
  return {
    primary,
    secondary,
    planType: typeof snap.planType === "string" ? snap.planType : null,
    observedAt: now.toISOString(),
  };
}

/**
 * Ask the machine's Codex for its current limits: a short-lived `codex
 * app-server` (stdio JSON-RPC) answering `account/rateLimits/read`. Unlike
 * the session log, this is current even when Codex hasn't run lately.
 * Rejects with Codex's own message (e.g. it isn't signed in).
 */
export function fetchCodexLimitsLive(
  timeoutMs = 20_000,
): Promise<LocalHostAgentLimits["codex"] | null> {
  return new Promise((resolve, reject) => {
    const shell = process.env.SHELL || "/bin/bash";
    const child = spawn(shell, ["-l", "-c", "exec codex app-server"], {
      cwd: homedir(),
      env: scrubSpawnEnv(process.env),
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buf = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const timer = setTimeout(
      () => done(() => reject(new Error("Codex didn't answer in time"))),
      timeoutMs,
    );
    const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + "\n");
    child.on("error", (err) => done(() => reject(err)));
    child.on("exit", () =>
      done(() => reject(new Error("Codex isn't installed here, or its app server exited"))),
    );
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          if (m.error)
            return done(() => reject(new Error(m.error?.message ?? "initialize failed")));
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (m.id === 2) {
          if (m.error) {
            const msg = m.error.message ?? "Codex couldn't read its limits";
            return done(() =>
              reject(
                new Error(
                  /401|unauthori[sz]ed|sign(ing)? in/i.test(msg)
                    ? "Codex isn't signed in on this machine — run `codex login` there"
                    : msg.slice(0, 300),
                ),
              ),
            );
          }
          return done(() => resolve(parseLiveCodexLimits(m.result)));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "optio", version: "0" } } });
  });
}
