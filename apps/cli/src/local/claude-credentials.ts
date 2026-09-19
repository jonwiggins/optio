import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

/**
 * The machine's own Claude Code login, for refreshing the cluster's
 * CLAUDE_CODE_OAUTH_TOKEN from the daemon instead of a copy/paste. Reads
 * where `claude login` writes: the "Claude Code-credentials" Keychain item
 * on macOS, `$CLAUDE_CONFIG_DIR/.credentials.json` (default
 * `~/.claude/.credentials.json`) elsewhere. Only the access token leaves
 * the machine — the refresh token stays put.
 */

export interface ClaudeCredentials {
  accessToken: string;
  expiresAt: string | null;
}

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const READ_TIMEOUT_MS = 5000;

function credentialsFilePath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), ".claude");
  return join(dir, ".credentials.json");
}

/** Parse the credentials JSON `claude login` writes; null when it holds no OAuth token. */
export function parseClaudeCredentials(raw: string): ClaudeCredentials | null {
  let d: any;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = d?.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken) return null;
  const expiresAt =
    typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
      ? new Date(oauth.expiresAt).toISOString()
      : typeof oauth.expiresAt === "string"
        ? oauth.expiresAt
        : null;
  return { accessToken: oauth.accessToken, expiresAt };
}

function readKeychain(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: READ_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });
}

async function readCredentialsFile(): Promise<string | null> {
  try {
    return await readFile(credentialsFilePath(), "utf-8");
  } catch {
    return null;
  }
}

/** The machine's current Claude OAuth credentials, or null when not logged in here. */
export async function readClaudeCredentials(): Promise<ClaudeCredentials | null> {
  if (process.platform === "darwin") {
    const fromKeychain = await readKeychain();
    if (fromKeychain) {
      const parsed = parseClaudeCredentials(fromKeychain);
      if (parsed) return parsed;
    }
  }
  const fromFile = await readCredentialsFile();
  return fromFile ? parseClaudeCredentials(fromFile) : null;
}

/** Cheap presence check for the hello frame (no token leaves this function). */
export async function hasClaudeCredentials(): Promise<boolean> {
  return (await readClaudeCredentials()) !== null;
}
