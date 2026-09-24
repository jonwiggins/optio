import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import type { LocalAgentModel } from "@optio/shared";
import { scrubSpawnEnv } from "./terminal-manager.js";

/**
 * Read what the agent CLIs on this machine offer, by asking them — the same
 * login shell the daemon launches them from, so it's the `claude` / `codex`
 * a spawn would run. Nothing here sends a token anywhere: the CLIs use their
 * own logins, and only the answers (flags, model names) reach the server.
 */

/** What this machine's `claude` accepts, from `claude --help`. */
export interface ClaudeCliCaps {
  /**
   * `--permission-mode` values it takes, or null when the help doesn't list
   * them (then every mode is passed as asked). `default` (Manual) is always
   * in: every release with the flag knows it.
   */
  permissionModes: string[] | null;
  /** Whether it has `--effort`. */
  effort: boolean;
}

const EFFORT_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_MODELS = 50;

/** Parse `claude --help`; null when it isn't Claude Code's help. */
export function parseClaudeHelp(help: string): ClaudeCliCaps | null {
  if (!help.includes("--permission-mode")) return null;
  const listed = help.match(/--permission-mode\s+<mode>[\s\S]*?\(choices:([^)]*)\)/);
  const modes = listed ? [...listed[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null;
  return {
    permissionModes: modes ? [...new Set([...modes, "default"])] : null,
    effort: /(^|\s)--effort\b/m.test(help),
  };
}

/** `claude --help` on this machine, parsed; null when there is no usable `claude`. */
export async function probeClaudeCli(): Promise<ClaudeCliCaps | null> {
  const help = await runInLoginShell("claude --help", 20_000).catch(() => null);
  return help ? parseClaudeHelp(help) : null;
}

/**
 * Normalize a Codex model catalog (`codex debug models`, or the
 * `models_cache.json` Codex keeps): the models Codex lists in its picker,
 * in its priority order, with their reasoning efforts. Null when the text
 * isn't a catalog.
 */
export function parseCodexModels(text: string): LocalAgentModel[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const list = (data as { models?: unknown })?.models;
  if (!Array.isArray(list)) return null;
  const priority = (m: any) => (typeof m?.priority === "number" ? m.priority : Infinity);
  const ranked = list
    .map((m, i) => ({ m, i }))
    .sort((a, b) => priority(a.m) - priority(b.m) || a.i - b.i);
  const models: LocalAgentModel[] = [];
  const seen = new Set<string>();
  for (const { m } of ranked) {
    const id = typeof m?.slug === "string" ? m.slug.trim() : "";
    if (!id || id.length > 100 || seen.has(id)) continue;
    // Hidden entries are Codex's internal / retired models ("codex-auto-review").
    if (typeof m.visibility === "string" && m.visibility !== "list") continue;
    seen.add(id);
    const levels: unknown[] = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels
      : [];
    const efforts = levels
      .map((l: any) => (typeof l === "string" ? l : l?.effort))
      .filter((e): e is string => typeof e === "string" && EFFORT_NAME.test(e));
    const def = m.default_reasoning_level;
    const label = typeof m.display_name === "string" ? m.display_name.trim().slice(0, 100) : "";
    const description = typeof m.description === "string" ? m.description.trim().slice(0, 300) : "";
    models.push({
      id,
      label: label || id,
      ...(description ? { description } : {}),
      efforts: [...new Set(efforts)],
      defaultEffort: typeof def === "string" && EFFORT_NAME.test(def) ? def : null,
    });
    if (models.length >= MAX_MODELS) break;
  }
  return models.length > 0 ? models : null;
}

/**
 * The models this machine's Codex offers: `codex debug models` — Codex's own
 * catalog, refreshed from OpenAI the way Codex refreshes it, else the list
 * its release ships with. Falls back to the catalog cache Codex keeps when
 * the command fails; null when there is no Codex here.
 */
export async function probeCodexModels(): Promise<LocalAgentModel[] | null> {
  const out = await runInLoginShell("codex debug models", 30_000).catch(() => null);
  const models = out ? parseCodexModels(out) : null;
  if (models) return models;
  try {
    const home = process.env.CODEX_HOME || join(os.homedir(), ".codex");
    return parseCodexModels(readFileSync(join(home, "models_cache.json"), "utf-8"));
  } catch {
    return null;
  }
}

/** Run a command in the user's login shell (as spawns do) and return its stdout. */
function runInLoginShell(command: string, timeoutMs: number): Promise<string> {
  const shell = process.env.SHELL || "/bin/bash";
  return new Promise((resolve, reject) => {
    execFile(
      shell,
      ["-l", "-c", command],
      {
        cwd: os.homedir(),
        env: scrubSpawnEnv(process.env),
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}
