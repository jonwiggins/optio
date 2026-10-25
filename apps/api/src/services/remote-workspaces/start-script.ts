/**
 * The start script (docs/remote-workspaces.md, "The start script"): what
 * pairs a workspace with Optio when the workspace doesn't do it itself. It
 * applies the agent policy, checks out the repository, installs the Optio
 * CLI from the server and starts `optio local up` in the checkout, detached,
 * logging to /tmp/optio-local.log. Everything it needs comes from OPTIO_*
 * variables (`startScriptEnv`), so the same script serves:
 *
 * - Daytona and E2B: Optio runs it in the sandbox (`runStartScript`), with
 *   the variables in the command's environment;
 * - GitHub Codespaces: the devcontainer's postStartCommand fetches it from
 *   `GET /api/cli/workspace-start.sh` (routes/cli-downloads.ts) after reading
 *   the variables from the codespace's pairing secret
 *   (examples/remote-workspaces/codespaces).
 *
 * A Coder template starts the daemon in its own startup script
 * (examples/coder/optio-workspace).
 */
import { REMOTE_WORKSPACE_REPO_PARAMETER } from "@optio/shared";
import type { PairingBundle } from "./types.js";

/** The parameters that carry the agent policy (agent-policy.ts `remoteWorkspacePolicyParameters`). */
const POLICY_PARAMETERS = {
  claude: "optio_claude_managed_settings",
  opencode: "optio_opencode_managed_config",
} as const;

/** The start script's environment for one start. */
export function startScriptEnv(input: {
  bundle: PairingBundle;
  checkoutDir: string;
  /** The machine's name in Optio (the workspace's). */
  hostname: string;
  /** The start's parameters: the repository and the agent policy are read from them. */
  parameters: Record<string, string>;
}): Record<string, string> {
  const p = input.parameters;
  return {
    OPTIO_SERVER: input.bundle.OPTIO_SERVER,
    OPTIO_TOKEN: input.bundle.OPTIO_TOKEN,
    OPTIO_LOCAL_HOST_ID: input.bundle.OPTIO_LOCAL_HOST_ID,
    OPTIO_LOCAL_HOSTNAME: input.hostname,
    OPTIO_CHECKOUT_DIR: input.checkoutDir,
    OPTIO_REPO_URL: p[REMOTE_WORKSPACE_REPO_PARAMETER] ?? "",
    OPTIO_CLAUDE_MANAGED_SETTINGS: p[POLICY_PARAMETERS.claude] ?? "",
    OPTIO_OPENCODE_MANAGED_CONFIG: p[POLICY_PARAMETERS.opencode] ?? "",
  };
}

/** The script itself (POSIX sh). */
export const START_SCRIPT = `#!/bin/sh
# Pairs this workspace with Optio as a machine (docs/remote-workspaces.md).
# Reads OPTIO_SERVER, OPTIO_TOKEN, OPTIO_LOCAL_HOST_ID, OPTIO_LOCAL_HOSTNAME,
# OPTIO_CHECKOUT_DIR, OPTIO_REPO_URL and the agent policy from the
# environment; needs Node.js 20+, git, curl (or wget) and tar.
set -u
if [ -z "\${OPTIO_SERVER:-}" ] || [ -z "\${OPTIO_TOKEN:-}" ] || [ -z "\${OPTIO_LOCAL_HOST_ID:-}" ]; then
  echo "optio: no pairing bundle here; nothing to start"
  exit 0
fi
dir="\${OPTIO_CHECKOUT_DIR:-$HOME/repo}"
name="\${OPTIO_LOCAL_HOSTNAME:-$(hostname)}"

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo -n "$@"
  else return 1; fi
}

# The agent policy (docs/agent-policy.md): Claude Code's managed settings and
# OpenCode's managed config, the tier a repo's own settings can't override.
# Rules that can't be written stop the start: the agent never runs without
# them. No rules: an earlier start's files go.
policy() {
  if [ -n "$2" ]; then
    as_root mkdir -p "$(dirname "$1")" &&
      printf '%s' "$2" | as_root tee "$1" >/dev/null &&
      as_root chmod 0644 "$1" ||
      { echo "optio: couldn't write $1 (root or sudo is needed); not starting"; exit 1; }
  elif [ -e "$1" ]; then
    as_root rm -f "$1" 2>/dev/null || true
  fi
}
policy /etc/claude-code/managed-settings.json "\${OPTIO_CLAUDE_MANAGED_SETTINGS:-}"
policy /etc/opencode/opencode.json "\${OPTIO_OPENCODE_MANAGED_CONFIG:-}"

# An earlier start's daemon pairs with a token that is revoked by now. (The
# brackets keep the pattern from matching this script's own command line.)
pkill -f 'optio[.]js local up' 2>/dev/null || true

mkdir -p "$dir"
if [ -n "\${OPTIO_REPO_URL:-}" ] && [ ! -e "$dir/.git" ] && [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
  git clone "$OPTIO_REPO_URL" "$dir" || echo "optio: couldn't clone $OPTIO_REPO_URL into $dir"
fi

if command -v curl >/dev/null 2>&1; then curl -fsSL "$OPTIO_SERVER/api/cli/install.sh" | sh
else wget -qO- "$OPTIO_SERVER/api/cli/install.sh" | sh; fi || {
  echo "optio: couldn't install the Optio CLI from $OPTIO_SERVER"; exit 1; }

export OPTIO_SERVER OPTIO_TOKEN OPTIO_LOCAL_HOST_ID
export OPTIO_LOCAL_HOSTNAME="$name"
nohup "$HOME/.optio/bin/optio" local up --no-remote-dirs --dir "$dir" --name "$name" \\
  >>/tmp/optio-local.log 2>&1 &
echo "optio: started the daemon for $dir (log: /tmp/optio-local.log)"
`;

/**
 * The command a provider runs to start it detached: the script travels in
 * OPTIO_START_SCRIPT next to the other variables, so nothing in the command
 * line needs quoting and no secret is in it.
 */
export const START_COMMAND = `nohup sh -c "$OPTIO_START_SCRIPT" >>/tmp/optio-local.log 2>&1 &`;

/** `env` and the script, as one environment for START_COMMAND. */
export function startCommandEnv(env: Record<string, string>): Record<string, string> {
  return { ...env, OPTIO_START_SCRIPT: START_SCRIPT };
}

/**
 * `env` as a shell file of `export NAME='value'` lines (for a provider that
 * hands the variables over as one value, Codespaces' secret).
 */
export function shellExports(env: Record<string, string>): string {
  const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return Object.entries(env)
    .map(([k, v]) => `export ${k}=${quote(v)}`)
    .join("\n");
}
