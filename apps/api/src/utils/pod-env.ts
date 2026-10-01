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
 * The exec script that runs one agent in a pooled pod (a Job's or a
 * persistent agent's): export the run's env, wait for the pod's init to
 * finish, then run the agent command in the run's own working directory and
 * exit with its status. `label` names the pod in the progress lines; without
 * it the script only speaks up on failure.
 */
export function buildPooledExecScript(input: {
  env: Record<string, string>;
  workDir: string;
  agentCommand: string[];
  label?: string;
}): string {
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
    `mkdir -p ${shellSingleQuote(input.workDir)}`,
    `cd ${shellSingleQuote(input.workDir)}`,
    `set +e`,
    ...input.agentCommand,
    `AGENT_EXIT=$?`,
    `exit $AGENT_EXIT`,
  ].join("\n");
}
