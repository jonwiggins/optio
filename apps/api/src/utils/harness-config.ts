/**
 * Where each agent runtime reads its MCP servers, and the per-run home that
 * keeps one run's config apart from the next on a shared pod.
 *
 * `buildAgentEnvironment` renders a run's MCP servers (the workspace's and
 * the repo's, plus its connections) as `.mcp.json` in the working directory.
 * Only Claude Code reads that file. Every other runtime has a file and a
 * shape of its own, established from the versions the agent image installs
 * (`images/base.Dockerfile`) by reading their installed code and docs:
 *
 * | Runtime                   | Reads                                                                 | Shape                                                                                   |
 * | ------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
 * | Codex 0.160               | `$CODEX_HOME/config.toml`                                             | `[mcp_servers.<name>]` tables (`codex-config.ts`)                                       |
 * | Gemini CLI 0.62           | `$GEMINI_CLI_HOME/.gemini/settings.json` (the user settings file)     | `mcpServers: { <name>: { command, args, env, trust } }`                                 |
 * | OpenCode 1.14             | `$OPENCODE_CONFIG` (merged after the global, before the project file) | `mcp: { <name>: { type: "local", command: [cmd, ...args], environment, enabled } }`     |
 * | Cursor CLI 2026.10        | `<project>/.cursor/mcp.json` (merged over `~/.cursor/mcp.json`)       | `mcpServers: { <name>: { command, args, env } }`; `--approve-mcps` skips the approval   |
 * | GitHub Copilot CLI 1.0.20 | `--additional-mcp-config @<file>` (adds to `~/.copilot/mcp-config.json`) | `mcpServers: { <name>: { type: "local", command, args, env, tools: ["*"] } }`        |
 *
 * Sources: Gemini's bundle reads `GEMINI_CLI_HOME` in place of the home
 * directory for every path under `.gemini` (`homedir()` in
 * `@google/gemini-cli/bundle`), applies workspace settings only to a trusted
 * folder, and expands `$NAME` in settings values that name an environment
 * variable of the process (`resolveEnvVarsInString`; unknown names are kept).
 * OpenCode's `config.ts` loads `Flag.OPENCODE_CONFIG` right after the global
 * config, so the project's own `opencode.json` still applies, and its
 * `ConfigMCP.Local` schema is `{ type, command[], environment?, enabled? }`.
 * Cursor's bundle reads `<projectRoot>/.cursor/mcp.json` and
 * `~/.cursor/mcp.json` (the config dir env vars do not move the latter), and
 * every server needs approval unless `--approve-mcps` is passed. Copilot's
 * `--additional-mcp-config` takes a JSON string or `@path`, validated as
 * `{ mcpServers }` with `type` `local` | `stdio` and a `tools` list.
 *
 * Why a per-run home: concurrent runs on a repo pod (one per worktree) can
 * have different connections, so no two may share a config file under the
 * agent's home, and Codex and Gemini write session logs next to their
 * settings, which must never land in a checkout. Every run gets
 * `/home/agent/optio/runs/<run id>` (`OPTIO_RUN_HOME`), named after the run
 * so a retry or a resume lands in the same place, and removed when the run's
 * script exits (`REMOVE_RUN_HOME`) and again with the run's worktree
 * (`removeRunHome`). Files whose only sane place is the working directory
 * (Cursor's) are merged into the repo's own file when it has one and kept
 * out of git by the setup-file writer.
 */
import { randomBytes } from "node:crypto";
import { shellQuote } from "@optio/shared";
import type { CodexMcpServer } from "./codex-config.js";

/** An MCP server as `.mcp.json` carries it (stdio only). */
export type McpStdioServer = CodexMcpServer;

/** The run's own directory under the agent's home; removed when the run ends. */
export const OPTIO_RUN_HOME = "OPTIO_RUN_HOME";
/** The run's `GEMINI_CLI_HOME`, when its Gemini run has MCP servers. */
export const OPTIO_GEMINI_HOME = "OPTIO_GEMINI_HOME";
/** The run's `OPENCODE_CONFIG` file, when its OpenCode run has MCP servers. */
export const OPTIO_OPENCODE_CONFIG = "OPTIO_OPENCODE_CONFIG";
/** The run's Copilot MCP config file, passed as `--additional-mcp-config`. */
export const OPTIO_COPILOT_MCP_CONFIG = "OPTIO_COPILOT_MCP_CONFIG";

/** Where run homes live in the pod. */
export const RUN_HOMES_DIR = "/home/agent/optio/runs";
/** The setup-file prefix that lands in `RUN_HOMES_DIR` (`WRITE_SETUP_FILES`). */
const RUN_HOMES_SETUP_DIR = "/opt/optio/runs";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * One run's home: the setup-file path prefix (`/opt/optio/…` lands in the
 * agent's home) and where the pod finds it. Named after the run id when it
 * is one Optio minted (a UUID); a random name otherwise.
 */
export function runHome(runId?: string | null): { setupDir: string; podDir: string } {
  const id = runId && SAFE_RUN_ID.test(runId) ? runId : randomBytes(6).toString("hex");
  return { setupDir: `${RUN_HOMES_SETUP_DIR}/${id}`, podDir: `${RUN_HOMES_DIR}/${id}` };
}

/** The pod path of a run's home, for the cleanup that follows its worktree. */
export function runHomePath(runId: string): string | null {
  return SAFE_RUN_ID.test(runId) ? `${RUN_HOMES_DIR}/${runId}` : null;
}

/** A script line removing a run's home, for the worktree cleanup commands. */
export function removeRunHome(runId: string): string {
  const path = runHomePath(runId);
  return path ? `rm -rf ${shellQuote(path)}` : "true";
}

/**
 * Removes the run's own home when its script exits. Guarded to the runs
 * directory, and free of single quotes so it fits inside a `trap '…' EXIT`.
 */
export const REMOVE_RUN_HOME = `case "\${${OPTIO_RUN_HOME}:-}" in ${RUN_HOMES_DIR}/*) rm -rf "\$${OPTIO_RUN_HOME}";; esac`;

/** Script lines that point Gemini at the run's own home, when it has one. */
export const EXPORT_GEMINI_HOME: readonly string[] = [
  `if [ -n "\${${OPTIO_GEMINI_HOME}:-}" ]; then export GEMINI_CLI_HOME="\$${OPTIO_GEMINI_HOME}"; fi`,
];

/** Script lines that point OpenCode at the run's own config, when it has one. */
export const EXPORT_OPENCODE_CONFIG: readonly string[] = [
  `if [ -n "\${${OPTIO_OPENCODE_CONFIG}:-}" ]; then export OPENCODE_CONFIG="\$${OPTIO_OPENCODE_CONFIG}"; fi`,
];

/** Copilot's flag naming the run's MCP config file, or nothing. */
export function copilotMcpConfigFlag(env: Record<string, string>): string {
  const file = env[OPTIO_COPILOT_MCP_CONFIG];
  return file ? ` --additional-mcp-config ${shellQuote(`@${file}`)}` : "";
}

type Servers = Record<string, McpStdioServer>;

const withEnv = <T extends object>(base: T, env: Record<string, string> | undefined) =>
  env && Object.keys(env).length > 0 ? { ...base, env } : base;

/**
 * Gemini's `settings.json`: `base` (the adapter's own settings — auth,
 * approval mode, turn limit) plus the servers, each trusted so its tools run
 * without a confirmation the headless run could never answer.
 */
export function geminiSettingsJson(base: Record<string, unknown>, servers: Servers): string {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(servers)) {
    mcpServers[name] = withEnv({ command: s.command, args: s.args, trust: true }, s.env);
  }
  return JSON.stringify({ ...base, mcpServers }, null, 2);
}

/** OpenCode's `opencode.json` with the servers as `mcp` entries. */
export function opencodeConfigJson(servers: Servers): string {
  const mcp: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(servers)) {
    mcp[name] = {
      type: "local",
      command: [s.command, ...s.args],
      ...(s.env && Object.keys(s.env).length > 0 ? { environment: s.env } : {}),
      enabled: true,
    };
  }
  return JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp }, null, 2);
}

/** Cursor's `.cursor/mcp.json`. */
export function cursorMcpJson(servers: Servers): string {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(servers)) {
    mcpServers[name] = withEnv({ command: s.command, args: s.args }, s.env);
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

/** Copilot's MCP config, every tool of every server enabled. */
export function copilotMcpConfigJson(servers: Servers): string {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(servers)) {
    mcpServers[name] = {
      type: "local",
      command: s.command,
      args: s.args,
      ...(s.env && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
      tools: ["*"],
    };
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

/** Whether any server carries env (credentials): its file is then owner-only. */
export function carriesEnv(servers: Servers): boolean {
  return Object.values(servers).some((s) => s.env && Object.keys(s.env).length > 0);
}
