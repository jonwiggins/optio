/**
 * OpenCode runs that never stop to ask.
 *
 * Optio runs `opencode run` headless: nobody can answer a permission ask.
 * OpenCode 1.14 defaults `external_directory` (a tool touching a path outside
 * the working directory, such as a venv under /tmp) and `doom_loop` to
 * "ask"; a headless ask is rejected and the run aborts with exit 1
 * (upstream PR #585, found on OpenCode 1.14.20 behind LiteLLM).
 *
 * The fix, with the same keys as #585 so taking upstream's version later is
 * a straight replacement:
 *
 * - `permission` in every `opencode.json` Optio writes (the adapter's
 *   pre-seeded global file in Repo Task and review pods, and the run's own
 *   `OPENCODE_CONFIG`, which every OpenCode pod run gets: apps/api
 *   services/opencode-run-setup.ts): everything
 *   allowed, `question` denied (asking the user is impossible), paths outside
 *   the working directory denied except OpenCode's own tool-output directory,
 *   and `sudo` / `apt` / `apt-get` / `dpkg` denied. A denied call comes back
 *   to the agent as a tool error, so it works around it instead of aborting.
 * - `--dangerously-skip-permissions` on `opencode run` (1.14.20's "auto"
 *   mode: approve what no rule explicitly denies), so an ask that slips
 *   through any rule is approved rather than aborting the run.
 * - A global `AGENTS.md` telling the agent the same rules, so a smaller model
 *   on the gateway doesn't spend turns on paths it can't use (Job runs and
 *   other pooled pods get it from opencode-run-setup.ts).
 *
 * #585's workspace-guard plugin is left out: it blocks every absolute path a
 * bash command names (e.g. `/opt/optio/...`), which is stricter than this
 * site needs; the `external_directory` rule already keeps tools inside.
 */

/** OpenCode keeps long tool output here and reads it back with its own tools. */
export const OPENCODE_TOOL_OUTPUT_DIR = "/home/agent/.local/share/opencode/**";

/** The `permission` block of every `opencode.json` Optio writes. */
export function opencodeHeadlessPermission(): Record<string, string | Record<string, string>> {
  return {
    "*": "allow",
    question: "deny",
    bash: {
      "sudo *": "deny",
      "apt *": "deny",
      "apt-get *": "deny",
      "dpkg *": "deny",
    },
    external_directory: {
      "*": "deny",
      [OPENCODE_TOOL_OUTPUT_DIR]: "allow",
    },
  };
}

/** `opencode run`'s flag for approving every ask no rule denies. */
export const OPENCODE_AUTO_APPROVE_FLAG = "--dangerously-skip-permissions";

/** Where OpenCode reads global rules merged into every session. */
export const OPENCODE_GLOBAL_AGENTS_MD_PATH = "/home/agent/.config/opencode/AGENTS.md";

export const OPENCODE_GLOBAL_AGENTS_MD = `# Optio: headless run rules

You run non-interactively (\`opencode run\`), started by Optio in an isolated pod.
Your working directory is your workspace.

- Nobody can answer a question. Never ask one: state your assumption and go on.
- Stay inside the workspace. Put temporary files, caches and virtual environments
  inside it (for example \`./.tmp/\`), not in /tmp or your home directory, and
  remove them before you finish.
- No sudo and no system packages (apt, apt-get, dpkg). Work with the tools
  that are installed.
- When a tool call is refused because a path is outside the workspace, don't
  retry that path: use one inside the workspace.
`;
