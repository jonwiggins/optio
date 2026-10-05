/**
 * Codex reads its MCP servers from `$CODEX_HOME/config.toml` (`~/.codex` by
 * default) as `[mcp_servers.<name>]` tables — it never reads the `.mcp.json`
 * Claude Code takes from the checkout. So a Codex run gets the same servers
 * rendered as TOML in a `CODEX_HOME` of its own: one directory per run under
 * the agent's home, because concurrent runs on a repo pod (one per worktree)
 * can have different connections and must not share a config file, and
 * because Codex also writes its session logs there, which must never land in
 * the checkout.
 */
import { randomBytes } from "node:crypto";

/** An MCP server as `.mcp.json` carries it (stdio only). */
export interface CodexMcpServer {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The env var the exec scripts turn into `CODEX_HOME`. */
export const OPTIO_CODEX_HOME = "OPTIO_CODEX_HOME";

/**
 * A fresh `CODEX_HOME` for one run: the setup-file path (`/opt/optio/…` lands
 * in the agent's home, see `WRITE_SETUP_FILES`) and where the pod finds it.
 */
export function newCodexHome(): { setupPath: string; podPath: string } {
  const id = randomBytes(6).toString("hex");
  return {
    setupPath: `/opt/optio/codex/${id}/config.toml`,
    podPath: `/home/agent/optio/codex/${id}`,
  };
}

/** Script lines that point Codex at the run's own home, when it has one. */
export const EXPORT_CODEX_HOME: readonly string[] = [
  `if [ -n "\${${OPTIO_CODEX_HOME}:-}" ]; then export CODEX_HOME="\$${OPTIO_CODEX_HOME}"; fi`,
];

/** A TOML basic string: quoted, with quotes, backslashes, and control characters escaped. */
export function tomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

/** A TOML key: bare when it can be, quoted otherwise. */
export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

/**
 * The `config.toml` fragment declaring these MCP servers to Codex, in the
 * order given. Empty when there are none.
 */
export function codexMcpConfigToml(servers: Record<string, CodexMcpServer>): string {
  const lines: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${tomlKey(name)}]`);
    lines.push(`command = ${tomlString(server.command)}`);
    lines.push(`args = [${server.args.map(tomlString).join(", ")}]`);
    const env = Object.entries(server.env ?? {});
    if (env.length > 0) {
      lines.push("");
      lines.push(`[mcp_servers.${tomlKey(name)}.env]`);
      for (const [k, v] of env) lines.push(`${tomlKey(k)} = ${tomlString(v)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
