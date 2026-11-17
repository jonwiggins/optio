/**
 * Offline baseline for agent pods (`OPTIO_AGENT_OFFLINE=true`, chart
 * `agent.offline: true`): environment variables that turn off the bundled
 * CLIs' telemetry, self-updates and update checks, so an agent pod makes no
 * non-essential connection. Off by default. Every agent pod creation path
 * (repo pods, StatefulSet / Job pods, workflow pods, persistent agents) adds
 * it under its own env, so a repository's or run's own value still wins.
 *
 * Each variable was checked against the CLI version the agent images ship
 * (images/base.Dockerfile, Dockerfile.agent):
 *
 * | Variable                                   | Read by (version checked)                 |
 * | ------------------------------------------ | ----------------------------------------- |
 * | `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | Claude Code 2.1.310                       |
 * | `DISABLE_TELEMETRY`                        | Claude Code 2.1.310                       |
 * | `DISABLE_ERROR_REPORTING`                  | Claude Code 2.1.310                       |
 * | `DISABLE_AUTOUPDATER`                      | Claude Code 2.1.310                       |
 * | `DO_NOT_TRACK`                             | Claude Code 2.1.310, gh (`gh help environment`) |
 * | `OPENCODE_DISABLE_AUTOUPDATE`              | OpenCode 1.14.20 (`true` / `1`)           |
 * | `OPENCODE_DISABLE_MODELS_FETCH`            | OpenCode 1.14.20: no models.dev fetch, the bundled model list is used |
 * | `OPENCODE_DISABLE_SHARE`                   | OpenCode 1.14.20                          |
 * | `OPENCODE_DISABLE_LSP_DOWNLOAD`            | OpenCode 1.14.20: no language-server downloads from GitHub |
 * | `COPILOT_AUTO_UPDATE`                      | GitHub Copilot CLI 1.0.103 (`false`)      |
 * | `PI_OFFLINE`, `PI_TELEMETRY`, `PI_SKIP_VERSION_CHECK` | pi 1.4.0 (`pi --help`)         |
 * | `GEMINI_TELEMETRY_ENABLED`                 | Gemini CLI 0.66 (already off by default)  |
 * | `GH_NO_UPDATE_NOTIFIER`, `GH_NO_EXTENSION_UPDATE_NOTIFIER`, `GH_TELEMETRY` | gh (`gh help environment`) |
 * | `GLAB_CHECK_UPDATE`, `GLAB_SEND_TELEMETRY` | glab 1.91.0 (`glab help`, README)         |
 * | `npm_config_update_notifier`               | npm 12 and pnpm 10 (`update-notifier`)    |
 *
 * Not covered by an environment variable: Codex (`config.toml`), Gemini CLI's
 * usage statistics and auto-update (`settings.json`) and Cursor's CLI.
 */
export const AGENT_OFFLINE_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  DO_NOT_TRACK: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
  OPENCODE_DISABLE_SHARE: "true",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
  COPILOT_AUTO_UPDATE: "false",
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  PI_SKIP_VERSION_CHECK: "1",
  GEMINI_TELEMETRY_ENABLED: "false",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  GH_TELEMETRY: "false",
  GLAB_CHECK_UPDATE: "false",
  GLAB_SEND_TELEMETRY: "false",
  npm_config_update_notifier: "false",
});

/** Whether the deployment asked for the offline baseline: `OPTIO_AGENT_OFFLINE` is true. */
export function isAgentOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.OPTIO_AGENT_OFFLINE ?? "").trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(raw);
}

/**
 * `podEnv` with the offline baseline underneath it when the deployment asked
 * for it; `podEnv` unchanged (the same values) otherwise.
 */
export function withAgentOfflineEnv(
  podEnv: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return isAgentOffline(env) ? { ...AGENT_OFFLINE_ENV, ...podEnv } : podEnv;
}
