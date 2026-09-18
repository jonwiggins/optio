import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mapHookEvent } from "./attention.js";

/**
 * Localhost hook receiver for Claude Code hooks. Agent spawns run with
 * OPTIO_LOCAL_DAEMON_PORT / OPTIO_LOCAL_TERMINAL_ID in their environment; the
 * injected settings file makes Claude Code POST hook events back here.
 * Binds 127.0.0.1 only — the daemon never accepts non-local connections.
 */

const MAX_BODY_BYTES = 64 * 1024;
const BODY_TIMEOUT_MS = 1000;
const HOOK_PATH_RE = /^\/hook\/([A-Za-z0-9-]{1,100})$/;

export interface HookServer {
  port: number;
  close(): Promise<void>;
}

/** The fields of a Claude Code hook payload the daemon acts on. */
export interface HookPayload {
  /** Absolute path of the session's JSONL transcript (usage lives there). */
  transcriptPath?: string;
  sessionId?: string;
}

export function startHookServer(
  onHook: (terminalId: string, hookEventName: string, payload: HookPayload) => void,
): Promise<HookServer> {
  const server: Server = createServer((req, res) => {
    const match = req.method === "POST" ? HOOK_PATH_RE.exec(req.url ?? "") : null;
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const terminalId = match[1];

    let done = false;
    const finish = (status: number) => {
      if (done) return;
      done = true;
      clearTimeout(bodyTimer);
      res.writeHead(status).end();
    };

    const bodyTimer = setTimeout(() => {
      finish(408);
      req.destroy();
    }, BODY_TIMEOUT_MS);

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        finish(413);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => finish(400));
    req.on("end", () => {
      if (done) return;
      let eventName: string | undefined;
      const payload: HookPayload = {};
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
          hook_event_name?: unknown;
          transcript_path?: unknown;
          session_id?: unknown;
        };
        if (typeof body.hook_event_name === "string") eventName = body.hook_event_name;
        if (typeof body.transcript_path === "string" && body.transcript_path.startsWith("/")) {
          payload.transcriptPath = body.transcript_path;
        }
        if (typeof body.session_id === "string") payload.sessionId = body.session_id;
      } catch {
        // fall through — respond 204, nothing to act on
      }
      if (!eventName) {
        finish(204);
        return;
      }
      // Any hook receipt marks hasHooks; unknown events are attention no-ops.
      const known = mapHookEvent(eventName) !== null;
      finish(known ? 200 : 204);
      onHook(terminalId, eventName, payload);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
            // Don't wait on keep-alive sockets during shutdown.
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

// The ${...} placeholders are expanded by the shell running the hook, from
// the terminal process's environment — not by the daemon.
const HOOK_COMMAND = `curl -sf -m 3 -X POST "http://127.0.0.1:\${OPTIO_LOCAL_DAEMON_PORT}/hook/\${OPTIO_LOCAL_TERMINAL_ID}" --data-binary @- -H 'Content-Type: application/json'`;

/**
 * A `claude` shim, prepended to PATH for every spawn, so a Claude Code you
 * start by hand inside an Optio shell gets the same hook settings as an
 * agent spawn (attention + usage). Finds the real binary by walking PATH
 * past its own directory; adds nothing when the caller already passes
 * `--settings`. Returns the directory to prepend to PATH.
 */
export function writeClaudeShim(dir: string): string {
  const script = `#!/bin/sh
# Optio Local shim: run Claude Code with this terminal's hook settings so the
# cockpit can tell when it needs you and how much it has used. Installed on
# PATH by the daemon for terminals it spawns; harmless elsewhere.
shim_dir=$(cd "$(dirname "$0")" && pwd)
real=""
old_ifs=$IFS; IFS=:
for d in $PATH; do
  [ "$d" = "$shim_dir" ] && continue
  if [ -x "$d/claude" ] && [ ! -d "$d/claude" ]; then real="$d/claude"; break; fi
done
IFS=$old_ifs
if [ -z "$real" ]; then
  echo "claude: command not found (Optio shim could not locate Claude Code on PATH)" >&2
  exit 127
fi
for a in "$@"; do
  case "$a" in --settings|--settings=*) exec "$real" "$@" ;; esac
done
if [ -n "$OPTIO_LOCAL_HOOK_SETTINGS" ] && [ -f "$OPTIO_LOCAL_HOOK_SETTINGS" ]; then
  exec "$real" --settings "$OPTIO_LOCAL_HOOK_SETTINGS" "$@"
fi
exec "$real" "$@"
`;
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/claude`;
  writeFileSync(path, script, { encoding: "utf-8", mode: 0o755 });
  chmodSync(path, 0o755);
  return dir;
}

/**
 * Write a ZDOTDIR wrapper so the `claude` shim stays FIRST on PATH in zsh
 * terminals. A plain PATH prepend is fragile: the user's own rc files run
 * after the daemon sets PATH and routinely prepend their own bins (~/.local/bin,
 * asdf shims), pushing the shim behind the real `claude`. The wrapper sources
 * each of the user's dotfiles from their real ZDOTDIR (or $HOME) and then, at
 * the end of .zshrc and .zlogin — the last files zsh reads for interactive and
 * `-l -c` login shells respectively — moves the shim dir back to the front.
 * Same trick VS Code's shell integration uses. Bash keeps the plain prepend.
 */
export function writeZshDotDir(dir: string): string {
  const header = `# Optio Local wrapper — sources your real zsh dotfile, then keeps the
# \`claude\` shim first on PATH so Optio can see when a session needs you.
_optio_zdotdir="$ZDOTDIR"
ZDOTDIR="\${OPTIO_USER_ZDOTDIR:-$HOME}"
`;
  const footer = `export OPTIO_USER_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$_optio_zdotdir"
unset _optio_zdotdir
`;
  const shimFirst = `if [[ -n "$OPTIO_LOCAL_SHIM_DIR" && -d "$OPTIO_LOCAL_SHIM_DIR" ]]; then
  path=("$OPTIO_LOCAL_SHIM_DIR" \${path:#$OPTIO_LOCAL_SHIM_DIR})
  export PATH
fi
`;
  const wrapper = (name: string, fixPath: boolean) =>
    `${header}[[ -f "$ZDOTDIR/${name}" ]] && source "$ZDOTDIR/${name}"
${footer}${fixPath ? shimFirst : ""}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/.zshenv`, wrapper(".zshenv", false), "utf-8");
  writeFileSync(`${dir}/.zprofile`, wrapper(".zprofile", false), "utf-8");
  writeFileSync(`${dir}/.zshrc`, wrapper(".zshrc", true), "utf-8");
  writeFileSync(`${dir}/.zlogin`, wrapper(".zlogin", true), "utf-8");
  return dir;
}

/**
 * Write the Claude Code settings file injected via `claude --settings` for
 * agent spawns. Uses the documented hooks schema.
 */
export function writeClaudeHookSettings(path: string): void {
  const hook = { type: "command", command: HOOK_COMMAND };
  const settings = {
    hooks: {
      Stop: [{ hooks: [hook] }],
      Notification: [{ hooks: [hook] }],
      UserPromptSubmit: [{ hooks: [hook] }],
    },
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}
