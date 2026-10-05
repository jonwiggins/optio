import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { runInLoginShell } from "./cli-probes.js";

/**
 * The machine's own Claude Code login, for refreshing the cluster's
 * CLAUDE_CODE_OAUTH_TOKEN from the daemon instead of a copy/paste. Reads
 * where `claude login` writes: the "Claude Code-credentials" Keychain item
 * on macOS, `$CLAUDE_CONFIG_DIR/.credentials.json` (default
 * `~/.claude/.credentials.json`) elsewhere. Only the access token leaves
 * the machine — the refresh token stays put.
 *
 * The access token is short-lived and Claude Code only renews it when it
 * runs, so a machine where nobody has run `claude` for a while holds an
 * expired one — the same token the cluster is trying to replace. Rather
 * than ask the person to open a terminal, the daemon runs `claude` once
 * itself (`renewClaudeLogin`) and reads the renewed login.
 */

export interface ClaudeCredentials {
  accessToken: string;
  expiresAt: string | null;
}

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const READ_TIMEOUT_MS = 5000;
/** A token this close to expiring is renewed first: the server would store one about to die. */
export const EXPIRY_MARGIN_MS = 10 * 60_000;
/** `claude -p` answers in a few seconds; a slow network or a renewal gets more. */
const RENEW_TIMEOUT_MS = 90_000;
/**
 * The cheapest thing that makes Claude Code use (and so renew) its login: one
 * short turn on the smallest model, no tools, no session file. Run in a
 * scratch directory so no project's CLAUDE.md or hooks come along.
 */
export const RENEW_COMMAND =
  'claude -p "Reply with only the word OK." --model haiku --max-turns 1 --no-session-persistence';

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

/** Whether the access token has expired or will within `EXPIRY_MARGIN_MS`. */
export function credentialsExpireSoon(creds: ClaudeCredentials, now = Date.now()): boolean {
  if (!creds.expiresAt) return false;
  const at = Date.parse(creds.expiresAt);
  return Number.isFinite(at) && at - now < EXPIRY_MARGIN_MS;
}

/**
 * Make this machine's Claude Code renew its login: `RENEW_COMMAND` in a
 * scratch directory, through the login shell a spawn would use (so it is the
 * same `claude`). Claude Code refreshes an expired access token with its
 * refresh token before its first request and writes the new one where
 * `claude login` does. Resolves to the failure's message, or null.
 */
export async function renewClaudeLogin(): Promise<string | null> {
  const dir = await mkdtemp(join(os.tmpdir(), "optio-claude-renew-"));
  try {
    await runInLoginShell(RENEW_COMMAND, RENEW_TIMEOUT_MS, dir);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return message.split("\n").find((l) => l.trim()) ?? "claude exited with an error";
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface FreshCredentials {
  creds: ClaudeCredentials | null;
  /** `claude` was run to renew the login (whether or not that worked). */
  renewed: boolean;
  /** Why there is no fresh login, when `creds` is null or still stale. */
  error?: string;
}

export interface FreshCredentialsDeps {
  read?: () => Promise<ClaudeCredentials | null>;
  renew?: () => Promise<string | null>;
  now?: () => number;
}

let inFlight: Promise<FreshCredentials> | null = null;

/**
 * The machine's login, renewed first when it is expired or about to be. Two
 * requests at once (the validation worker and the banner's button) share
 * one renewal.
 */
export function freshClaudeCredentials(deps: FreshCredentialsDeps = {}): Promise<FreshCredentials> {
  if (inFlight) return inFlight;
  inFlight = freshClaudeCredentialsOnce(deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function freshClaudeCredentialsOnce(deps: FreshCredentialsDeps): Promise<FreshCredentials> {
  const read = deps.read ?? readClaudeCredentials;
  const renew = deps.renew ?? renewClaudeLogin;
  const now = deps.now ?? Date.now;
  const before = await read().catch(() => null);
  if (!before) {
    return {
      creds: null,
      renewed: false,
      error: "No Claude Code login on this machine — run `claude` here and sign in first",
    };
  }
  if (!credentialsExpireSoon(before, now())) return { creds: before, renewed: false };
  const failure = await renew();
  const after = (await read().catch(() => null)) ?? before;
  if (!credentialsExpireSoon(after, now())) return { creds: after, renewed: true };
  return {
    creds: after,
    renewed: true,
    error: failure
      ? `The Claude login on this machine is expired and \`claude\` could not renew it (${failure}) — run \`claude\` here and sign in again`
      : "The Claude login on this machine is expired and running `claude` did not renew it — run `claude` here and sign in again",
  };
}
