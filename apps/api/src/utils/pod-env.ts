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

const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
 * sensitive file (credentials) is readable by its owner only. Files written
 * into a git checkout are added to its `info/exclude`, so an agent's
 * `git add -A` never commits Optio's `.mcp.json` (which can carry
 * credentials) or skills. Every pod exec script uses them, so a Job or a
 * persistent agent gets the same `.mcp.json` and skills a Repo Task does.
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
  return [
    "set -e",
    // Env values (including the prompt) are embedded as inert single-quoted
    // exports — see buildEnvExports.
    ...buildEnvExports(input.env),
    ...(input.label ? [`echo "[optio] Waiting for ${what} to be ready..."`] : []),
    `for i in $(seq 1 120); do [ -f /workspace/.ready ] && break; sleep 1; done`,
    `[ -f /workspace/.ready ] || { echo "[optio] ERROR: ${what} not ready after 120s"; exit 1; }`,
    ...(input.label ? [`echo "[optio] ${what[0].toUpperCase()}${what.slice(1)} ready"`] : []),
    ...(input.checkout ? CHECKOUT_REPO : [`mkdir -p ${shellQuote(dir)}`]),
    `cd ${shellQuote(dir)}`,
    ...WRITE_SETUP_FILES,
    ...RUN_WORK_SETUP_COMMANDS,
    `set +e`,
    ...input.agentCommand,
    `AGENT_EXIT=$?`,
    `exit $AGENT_EXIT`,
  ].join("\n");
}
