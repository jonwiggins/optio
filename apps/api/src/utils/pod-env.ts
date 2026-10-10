import { createHash } from "node:crypto";
/**
 * Helpers for injecting environment variables into agent pod exec scripts.
 *
 * Values (including the task prompt) are emitted as single-quoted `export`
 * statements embedded directly in the bash script. Single-quoted strings are
 * fully inert in bash — no command substitution, variable expansion, glob
 * expansion, or word splitting — and may span multiple lines, so prompt text
 * containing markdown backticks, `$VARS`, wildcards like `optio/task-*`, or
 * literal newlines round-trips exactly.
 *
 * The previous implementation piped base64-encoded JSON through python3 into
 * `eval $(...)`. Because the command substitution was unquoted, bash applied
 * word splitting and pathname expansion to the shlex-quoted output before
 * eval re-parsed it, which collapsed newlines in prompts to spaces and could
 * surface prompt fragments to the shell before the agent started.
 */

import { shellQuote } from "@optio/shared";
import {
  RUN_DIR_ENV,
  RUN_EXIT_MARKER,
  RUN_FILES,
  RUN_LOST_MARKER,
  RUN_MARK_ENV_READY_ENV,
  RUN_STARTED_MARKER,
  RUN_STDIN_ENV,
  STDIN_EOF_SENTINEL,
  SUPERVISOR_SCRIPT,
  attachRunScript,
  deliverStdinScript,
  killRunScript,
  superviseAgent,
} from "@optio/container-runtime";
import { REMOVE_RUN_HOME, runHome } from "./harness-config.js";

// The run protocol's script fragments (docs/plans/scale-out.md §1) live with
// the runtimes that run them (packages/container-runtime/src/run-protocol.ts)
// and are re-exported here, next to the other exec script pieces.
export {
  RUN_DIR_ENV,
  RUN_EXIT_MARKER,
  RUN_FILES,
  RUN_LOST_MARKER,
  RUN_MARK_ENV_READY_ENV,
  RUN_STARTED_MARKER,
  RUN_STDIN_ENV,
  STDIN_EOF_SENTINEL,
  SUPERVISOR_SCRIPT,
  attachRunScript,
  deliverStdinScript,
  killRunScript,
  superviseAgent,
};

export const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Env names a connection or provider may never set in a pod: Optio's own
 * (`OPTIO_*`), the shell's, the loader's, each agent runtime's home, and the
 * identity credentials Optio manages itself.
 */
const RESERVED_POD_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TMPDIR",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "GEMINI_CLI_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG_DIR",
  "COPILOT_HOME",
  "CURSOR_CONFIG_DIR",
  "NODE_OPTIONS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "CURSOR_API_KEY",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
]);

export function isReservedPodEnvName(name: string): boolean {
  return name.startsWith("OPTIO_") || name.startsWith("LD_") || RESERVED_POD_ENV_NAMES.has(name);
}

/**
 * Build `export KEY='value'` script lines for every env entry.
 * Throws on names bash would reject as identifiers — interpolating an
 * arbitrary name into `export <name>=` would otherwise allow injection.
 */
export function buildEnvExports(env: Record<string, string>): string[] {
  return Object.entries(env).map(([key, value]) => {
    if (!VALID_ENV_NAME.test(key)) {
      throw new Error(`Invalid environment variable name for pod exec: ${JSON.stringify(key)}`);
    }
    return `export ${key}=${shellQuote(String(value))}`;
  });
}

/**
 * Script lines that write the run's setup files (`OPTIO_SETUP_FILES`: base64
 * JSON of `{ path, content | contentBase64, executable, sensitive }`) into the
 * current directory; `/opt/optio/…` paths land in the agent's home. A
 * sensitive file (credentials) is readable by its owner only. A `merge:
 * "json"` file is merged into the JSON object already at its path, when
 * there is one (a repo's own runtime config). Files written into a git
 * checkout are added to its `info/exclude`, and a tracked file Optio wrote
 * over is marked `skip-worktree`, so an agent's `git add -A` never commits
 * Optio's `.mcp.json` (which can carry credentials) or skills. Every pod
 * exec script uses them, so a Job or a persistent agent gets the same
 * `.mcp.json` and skills a Repo Task does.
 */
export const WRITE_SETUP_FILES: readonly string[] = [
  `if [ -n "\${OPTIO_SETUP_FILES:-}" ]; then`,
  `  echo "[optio] Writing setup files..."`,
  `  echo "\${OPTIO_SETUP_FILES}" | base64 -d | python3 -c "`,
  `import base64, json, os, subprocess, sys`,
  `here = os.getcwd()`,
  `written = []`,
  `for f in json.load(sys.stdin):`,
  `    p = f['path']`,
  `    if p.startswith('/opt/optio/'):`,
  `        p = '/home/agent/optio/' + p[len('/opt/optio/'):]`,
  `    elif not p.startswith('/'):`,
  `        p = os.path.join(here, p)`,
  `    os.makedirs(os.path.dirname(p), exist_ok=True)`,
  `    data = base64.b64decode(f['contentBase64']) if f.get('contentBase64') else f.get('content', '').encode()`,
  `    if f.get('merge') == 'json' and os.path.isfile(p):`,
  `        try:`,
  `            old = json.load(open(p))`,
  `            new = json.loads(data)`,
  `            if isinstance(old, dict) and isinstance(new, dict):`,
  `                for k, v in new.items():`,
  `                    old[k] = {**old[k], **v} if isinstance(v, dict) and isinstance(old.get(k), dict) else v`,
  `                data = json.dumps(old, indent=2).encode()`,
  `        except Exception:`,
  `            pass`,
  `    mode = 0o600 if f.get('sensitive') else 0o644`,
  `    if f.get('executable'):`,
  `        mode |= 0o100 if f.get('sensitive') else 0o111`,
  `    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)`,
  `    with os.fdopen(fd, 'wb') as fh:`,
  `        fh.write(data)`,
  `    os.chmod(p, mode)`,
  `    if os.path.commonpath([here, os.path.abspath(p)]) == here:`,
  `        written.append(os.path.relpath(p, here))`,
  `    print(f'  wrote {p}')`,
  `git = subprocess.run(['git', 'rev-parse', '--git-path', 'info/exclude'], capture_output=True, text=True)`,
  `if written and git.returncode == 0 and git.stdout.strip():`,
  `    exclude = git.stdout.strip()`,
  `    os.makedirs(os.path.dirname(os.path.abspath(exclude)), exist_ok=True)`,
  `    have = set(open(exclude).read().splitlines()) if os.path.exists(exclude) else set()`,
  `    with open(exclude, 'a') as fh:`,
  `        for rel in written:`,
  `            if '/' + rel not in have:`,
  `                fh.write('/' + rel + chr(10))`,
  `    tracked = subprocess.run(['git', 'ls-files', '--'] + written, capture_output=True, text=True).stdout.split(chr(10))`,
  `    tracked = [t for t in tracked if t]`,
  `    if tracked:`,
  `        subprocess.run(['git', 'update-index', '--skip-worktree', '--'] + tracked, capture_output=True)`,
  `"`,
  `fi`,
];

/**
 * Script lines that run, in the current directory just before the agent
 * starts, the MCP servers' install commands (`OPTIO_MCP_INSTALL_COMMANDS`; a
 * failure is only a warning — the agent can still work without that server)
 * and then the work's own setup commands (`OPTIO_WORK_SETUP_COMMANDS`, from
 * its settings), stopping the run if they fail.
 */
export const RUN_WORK_SETUP_COMMANDS: readonly string[] = [
  `if [ -n "\${OPTIO_MCP_INSTALL_COMMANDS:-}" ]; then`,
  `  echo "[optio] Installing MCP servers..."`,
  `  bash -c "\$OPTIO_MCP_INSTALL_COMMANDS" || echo "[optio] Warning: an MCP server install failed"`,
  `fi`,
  `if [ -n "\${OPTIO_WORK_SETUP_COMMANDS:-}" ]; then`,
  `  echo "[optio] Running setup commands..."`,
  `  bash -c "\$OPTIO_WORK_SETUP_COMMANDS" || { echo "[optio] ERROR: setup commands failed"; exit 1; }`,
  `fi`,
];

/** Where a pooled pod keeps the checkout of a persistent agent's repo. */
export const POOLED_CHECKOUT_DIR = "/workspace/repo";

/**
 * Script lines that give a pooled pod a checkout of `$OPTIO_REPO_URL` at
 * `POOLED_CHECKOUT_DIR`: cloned on first use at `$OPTIO_REPO_BRANCH`, then
 * only fetched, so whatever the agent left in it between turns stays —
 * unless the work moves to another repo (a fresh clone) or another branch
 * (checked out, when the tree allows). Git signs in the way repo pods do
 * (repo-init.sh): Optio's credential helper, else a GitHub / GitLab token.
 */
export const CHECKOUT_REPO: readonly string[] = [
  `if [ -n "\${OPTIO_GIT_CREDENTIAL_URL:-}" ] && [ -f /usr/local/bin/optio-git-credential ]; then`,
  `  git config --global credential.helper '/usr/local/bin/optio-git-credential'`,
  `elif [ -n "\${GITHUB_TOKEN:-}" ] || [ -n "\${GITLAB_TOKEN:-}" ]; then`,
  `  git config --global credential.helper store`,
  `  : > ~/.git-credentials && chmod 600 ~/.git-credentials`,
  `  if [ -n "\${GITHUB_TOKEN:-}" ]; then`,
  `    echo "https://x-access-token:\${GITHUB_TOKEN}@github.com" >> ~/.git-credentials`,
  `  fi`,
  `  if [ -n "\${GITLAB_TOKEN:-}" ]; then`,
  `    echo "https://oauth2:\${GITLAB_TOKEN}@$(echo "$OPTIO_REPO_URL" | sed -E 's|.*://([^/]+).*|\\1|')" >> ~/.git-credentials`,
  `  fi`,
  `fi`,
  `git config --global user.name "\${GITHUB_APP_BOT_NAME:-Optio Agent}"`,
  `git config --global user.email "\${GITHUB_APP_BOT_EMAIL:-optio-agent@noreply.github.com}"`,
  // Another repo since the last turn: start over with a fresh clone.
  `if [ -d ${POOLED_CHECKOUT_DIR}/.git ] && [ "$(git -C ${POOLED_CHECKOUT_DIR} remote get-url origin 2>/dev/null)" != "$OPTIO_REPO_URL" ]; then`,
  `  echo "[optio] The repo changed — cloning it fresh"`,
  `  rm -rf ${POOLED_CHECKOUT_DIR}`,
  `fi`,
  `if [ ! -d ${POOLED_CHECKOUT_DIR}/.git ]; then`,
  `  echo "[optio] Cloning $OPTIO_REPO_URL ($OPTIO_REPO_BRANCH)..."`,
  `  git clone --branch "$OPTIO_REPO_BRANCH" "$OPTIO_REPO_URL" ${POOLED_CHECKOUT_DIR} || { echo "[optio] ERROR: clone failed"; exit 1; }`,
  `  echo "$OPTIO_REPO_BRANCH" > ${POOLED_CHECKOUT_DIR}/.git/optio-branch`,
  `else`,
  `  git -C ${POOLED_CHECKOUT_DIR} fetch origin --quiet || echo "[optio] Warning: fetch failed"`,
  // The agent's own branches stay as it left them; only a new configured
  // branch moves the checkout.
  `  if [ "$(cat ${POOLED_CHECKOUT_DIR}/.git/optio-branch 2>/dev/null)" != "$OPTIO_REPO_BRANCH" ]; then`,
  `    if git -C ${POOLED_CHECKOUT_DIR} checkout "$OPTIO_REPO_BRANCH" 2>/dev/null || git -C ${POOLED_CHECKOUT_DIR} checkout -b "$OPTIO_REPO_BRANCH" "origin/$OPTIO_REPO_BRANCH"; then`,
  `      echo "$OPTIO_REPO_BRANCH" > ${POOLED_CHECKOUT_DIR}/.git/optio-branch`,
  `    else`,
  `      echo "[optio] Warning: couldn't switch to $OPTIO_REPO_BRANCH (uncommitted changes?)"`,
  `    fi`,
  `  fi`,
  `fi`,
];

/**
 * The exec script that runs one agent in a pooled pod (a Job's or a
 * persistent agent's): export the run's env, wait for the pod's init to
 * finish, then, in the run's own working directory, write its setup files,
 * run its setup commands, and run the agent command, exiting with its
 * status. `label` names the pod in the progress lines; without it the script
 * only speaks up on failure.
 */
export function buildPooledExecScript(input: {
  env: Record<string, string>;
  /** The run's directory; ignored with `checkout` (the run works in the checkout). */
  workDir: string;
  agentCommand: string[];
  label?: string;
  /** Work in a checkout of `$OPTIO_REPO_URL` (`CHECKOUT_REPO`). */
  checkout?: boolean;
}): string {
  const dir = input.checkout ? POOLED_CHECKOUT_DIR : input.workDir;
  const what = input.label ?? "pod";
  const lock = createHash("sha256").update(input.workDir).digest("hex").slice(0, 32);
  return [
    "set -e",
    // Env values (including the prompt) are embedded as inert single-quoted
    // exports — see buildEnvExports.
    ...buildEnvExports(input.env),
    ...(input.label ? [`echo "[optio] Waiting for ${what} to be ready..."`] : []),
    `for i in $(seq 1 120); do [ -f /workspace/.ready ] && break; sleep 1; done`,
    `[ -f /workspace/.ready ] || { echo "[optio] ERROR: ${what} not ready after 120s"; exit 1; }`,
    ...(input.label ? [`echo "[optio] ${what[0].toUpperCase()}${what.slice(1)} ready"`] : []),
    `exec 7>/workspace/.run-${lock}.lock`,
    "flock -n 7 || { echo 'Previous run is still active; inspect before retrying.' >&2; exit 75; }",
    ...(input.checkout ? CHECKOUT_REPO : [`mkdir -p ${shellQuote(dir)}`]),
    `cd ${shellQuote(dir)}`,
    // The run's own home (its runtime's MCP config) goes with the run.
    `trap '${REMOVE_RUN_HOME}' EXIT`,
    ...WRITE_SETUP_FILES,
    ...RUN_WORK_SETUP_COMMANDS,
    `set +e`,
    "(",
    ...input.agentCommand,
    ")",
    `AGENT_EXIT=$?`,
    `echo "__OPTIO_RUN_EXIT__:$AGENT_EXIT"`,
    `exit $AGENT_EXIT`,
  ].join("\n");
}

/**
 * The run protocol's start script for a pooled pod (a Job run or a
 * persistent-agent turn): the same setup as `buildPooledExecScript`, then
 * the agent launched under the supervisor in the run's own home
 * (`runHome(runId)`), so the exec returns once the agent runs and any API
 * instance can attach to it later (run-protocol.ts). The run lock stays:
 * a second start of the same run while its supervisor lives exits 75. No
 * trap removes the run home; it is removed once the run is over and
 * consumed.
 */
export function buildPooledStartScript(input: {
  env: Record<string, string>;
  /** Optio's id for the run (a Job run or turn id): names its run home. */
  runId: string;
  /** The run's directory; ignored with `checkout` (the run works in the checkout). */
  workDir: string;
  agentCommand: string[];
  label?: string;
  /** Work in a checkout of `$OPTIO_REPO_URL` (`CHECKOUT_REPO`). */
  checkout?: boolean;
}): string {
  const dir = input.checkout ? POOLED_CHECKOUT_DIR : input.workDir;
  const what = input.label ?? "pod";
  const lock = createHash("sha256").update(input.workDir).digest("hex").slice(0, 32);
  const home = runHome(input.runId);
  return [
    "set -e",
    ...buildEnvExports(input.env),
    ...(input.label ? [`echo "[optio] Waiting for ${what} to be ready..."`] : []),
    `for i in $(seq 1 120); do [ -f /workspace/.ready ] && break; sleep 1; done`,
    `[ -f /workspace/.ready ] || { echo "[optio] ERROR: ${what} not ready after 120s"; exit 1; }`,
    ...(input.label ? [`echo "[optio] ${what[0].toUpperCase()}${what.slice(1)} ready"`] : []),
    // The lock is held by the start exec only while it sets up: the
    // supervisor's pid file is what says a run is live (killRunScript).
    `exec 7>/workspace/.run-${lock}.lock`,
    "flock -n 7 || { echo 'Previous run is still active; inspect before retrying.' >&2; exit 75; }",
    `if [ -s ${shellQuote(`${home.podDir}/${RUN_FILES.pid}`)} ] && kill -0 "$(cat ${shellQuote(`${home.podDir}/${RUN_FILES.pid}`)})" 2>/dev/null; then echo 'Previous run is still active; inspect before retrying.' >&2; exit 75; fi`,
    ...(input.checkout ? CHECKOUT_REPO : [`mkdir -p ${shellQuote(dir)}`]),
    `cd ${shellQuote(dir)}`,
    ...WRITE_SETUP_FILES,
    ...RUN_WORK_SETUP_COMMANDS,
    ...superviseAgent(home.podDir, input.agentCommand),
  ].join("\n");
}
