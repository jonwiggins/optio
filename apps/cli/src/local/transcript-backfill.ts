import { closeSync, existsSync, openSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalTranscriptEntry } from "@optio/shared";
import { TranscriptTracker } from "./transcript-tracker.js";

/**
 * Reads a finished agent session's whole conversation off disk, for the
 * server to store when the session's transcript was never streamed: it ran
 * under a daemon that predates transcripts, or its hooks never named the
 * file. Claude Code keeps every session at
 * `<config dir>/projects/<slug of the working dir>/<session id>.jsonl`.
 *
 * Only a session that ran inside one of the daemon's allowlisted dirs is
 * read: the daemon never hands over a conversation from a folder that
 * wasn't shared with Optio.
 */

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How far into the transcript to look for the session's working dir. */
const CWD_SCAN_MAX = 8 * 1024 * 1024;
const CWD_CHUNK = 64 * 1024;

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * The transcript file of a Claude Code session, or null. Session ids are
 * UUIDs, unique across projects, so every project folder is searched
 * rather than re-deriving Claude's slug of the working dir.
 */
export function findClaudeTranscript(
  sessionId: string,
  configDir = claudeConfigDir(),
): string | null {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const projects = join(configDir, "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const path = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

/** The working dir the session ran in: the first `cwd` its transcript records. */
export function transcriptCwd(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(CWD_CHUNK);
    let carry = "";
    for (let offset = 0; offset < CWD_SCAN_MAX; ) {
      const n = readSync(fd, buf, 0, CWD_CHUNK, offset);
      if (n <= 0) break;
      offset += n;
      const lines = (carry + buf.toString("utf-8", 0, n)).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.includes('"cwd"')) continue;
        try {
          const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
          if (typeof cwd === "string" && cwd.startsWith("/")) return cwd;
        } catch {
          // a torn or foreign line: keep looking
        }
      }
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

function insideAny(dir: string, allowed: string[]): boolean {
  if (dir.split("/").includes("..")) return false;
  return allowed.some((a) => {
    const root = a.length > 1 && a.endsWith("/") ? a.slice(0, -1) : a;
    return dir === root || dir.startsWith(`${root}/`);
  });
}

export interface SessionTranscript {
  entries: LocalTranscriptEntry[];
  /** Why there is nothing to show, when there isn't. */
  error?: string;
}

/** The conversation of a finished session, distilled the same way the live stream is. */
export function readSessionTranscript(opts: {
  agent: string;
  sessionId: string;
  allowedDirs: string[];
  configDir?: string;
}): SessionTranscript {
  if (opts.agent !== "claude-code") {
    return { entries: [], error: `No transcripts are read for ${opts.agent} sessions` };
  }
  const path = findClaudeTranscript(opts.sessionId, opts.configDir);
  if (!path) return { entries: [], error: "No transcript for this session on this machine" };
  const cwd = transcriptCwd(path);
  if (!cwd || !insideAny(cwd, opts.allowedDirs)) {
    return { entries: [], error: "The session ran outside this machine's allowlisted dirs" };
  }
  return { entries: new TranscriptTracker().update("backfill", path) };
}
