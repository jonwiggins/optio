/**
 * Node preload (`node --import`) for the isolated test daemon started by
 * apps/android/scripts/test-daemon.sh.
 *
 * A daemon whose machine has a Claude Code login advertises `claudeCredentials: true`, and the
 * API it connects to may then pull that OAuth access token and store it as its global
 * CLAUDE_CODE_OAUTH_TOKEN (services/local-auth-refresh-service.ts: on hello when no valid token
 * is stored, from the validation worker, or via POST /api/auth/claude-token/refresh-from-host).
 * The private test API must never receive the user's real token, so this preload hides the
 * login from the daemon PROCESS ONLY: its Keychain probe runs /usr/bin/false instead of
 * `security`, and a Claude credentials file reads as missing.
 *
 * Terminals the daemon spawns are separate processes that do not load this file, so a `claude`
 * agent started in one still uses the machine's own login. test-daemon.sh skips the preload when
 * OPTIO_DEVLAB_SHARE_CLAUDE_LOGIN=1 (only for deliberately testing "refresh from machine").
 */
import childProcess from "node:child_process";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const KEYCHAIN_ITEM = "Claude Code-credentials";

const realExecFile = childProcess.execFile;
childProcess.execFile = function execFile(file, args, ...rest) {
  if (file === "security" && Array.isArray(args) && args.includes(KEYCHAIN_ITEM)) {
    return realExecFile.call(this, "/usr/bin/false", [], ...rest);
  }
  return realExecFile.call(this, file, args, ...rest);
};

const realReadFile = fsPromises.readFile;
fsPromises.readFile = function readFile(path, ...rest) {
  if (typeof path === "string" && path.endsWith("/.credentials.json")) {
    const err = new Error(`ENOENT: hidden from the Optio DevLab test daemon, open '${path}'`);
    err.code = "ENOENT";
    return Promise.reject(err);
  }
  return realReadFile.call(this, path, ...rest);
};

// Update the live ESM bindings (`import { execFile } from "node:child_process"`) of modules
// that load after this preload.
syncBuiltinESMExports();
