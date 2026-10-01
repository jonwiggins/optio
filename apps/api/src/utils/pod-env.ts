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

const VALID_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Escape a value as an inert single-quoted bash literal (`'\''` for embedded quotes). */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
    return `export ${key}=${shellSingleQuote(String(value))}`;
  });
}

/**
 * Script lines that write the run's setup files (`OPTIO_SETUP_FILES`: base64
 * JSON of `{ path, content | contentBase64, executable }`) into the current
 * directory; `/opt/optio/…` paths land in the agent's home. Every pod exec
 * script uses them, so a Job or a persistent agent gets the same `.mcp.json`
 * and skills a Repo Task does.
 */
export const WRITE_SETUP_FILES: readonly string[] = [
  `if [ -n "\${OPTIO_SETUP_FILES:-}" ]; then`,
  `  echo "[optio] Writing setup files..."`,
  `  echo "\${OPTIO_SETUP_FILES}" | base64 -d | python3 -c "`,
  `import base64, json, os, sys`,
  `for f in json.load(sys.stdin):`,
  `    p = f['path']`,
  `    if p.startswith('/opt/optio/'):`,
  `        p = '/home/agent/optio/' + p[len('/opt/optio/'):]`,
  `    elif not p.startswith('/'):`,
  `        p = os.path.join(os.getcwd(), p)`,
  `    os.makedirs(os.path.dirname(p), exist_ok=True)`,
  `    data = base64.b64decode(f['contentBase64']) if f.get('contentBase64') else f.get('content', '').encode()`,
  `    with open(p, 'wb') as fh:`,
  `        fh.write(data)`,
  `    if f.get('executable'):`,
  `        os.chmod(p, 0o755)`,
  `    print(f'  wrote {p}')`,
  `"`,
  `fi`,
];

/**
 * Script lines that run the work's own setup commands
 * (`OPTIO_WORK_SETUP_COMMANDS`, from its settings) in the current directory
 * just before the agent starts, stopping the run if they fail.
 */
export const RUN_WORK_SETUP_COMMANDS: readonly string[] = [
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
 * only fetched, so whatever the agent left in it between turns stays. Git
 * signs in the way repo pods do (repo-init.sh): Optio's credential helper,
 * else a GitHub / GitLab token.
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
  `if [ ! -d ${POOLED_CHECKOUT_DIR}/.git ]; then`,
  `  echo "[optio] Cloning $OPTIO_REPO_URL ($OPTIO_REPO_BRANCH)..."`,
  `  git clone --branch "$OPTIO_REPO_BRANCH" "$OPTIO_REPO_URL" ${POOLED_CHECKOUT_DIR} || { echo "[optio] ERROR: clone failed"; exit 1; }`,
  `else`,
  `  git -C ${POOLED_CHECKOUT_DIR} fetch origin --quiet || echo "[optio] Warning: fetch failed"`,
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
    ...(input.checkout ? CHECKOUT_REPO : [`mkdir -p ${shellSingleQuote(dir)}`]),
    `cd ${shellSingleQuote(dir)}`,
    ...WRITE_SETUP_FILES,
    ...RUN_WORK_SETUP_COMMANDS,
    `set +e`,
    ...input.agentCommand,
    `AGENT_EXIT=$?`,
    `exit $AGENT_EXIT`,
  ].join("\n");
}
