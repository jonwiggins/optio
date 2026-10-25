/**
 * The MCP servers the agent images carry (`images/base.Dockerfile`, `npm
 * install -g`, pinned), so a Postgres or Filesystem connection starts with
 * no download. Upstream starts them with `npx -y <package>`, which asks the
 * npm registry for "latest" on every run — which fails with no internet access.
 *
 * Which form a provider's `mcpConfig` takes is decided here, once, when the
 * API boots (the built-in catalog is seeded from it, connection-service.ts):
 *
 * - `OPTIO_MCP_PREINSTALLED=1` (or `true`, `yes`, `on`) in the API's
 *   environment runs the installed binaries; the images that carry them
 *   set the same variable as a marker.
 * - Unset (or `0`), the catalog keeps upstream's `npx` form.
 *
 * See docs/air-gapped.md "Image build arguments".
 */

export const PREINSTALLED_MCP_SERVERS = {
  postgres: { bin: "mcp-server-postgres", pkg: "@modelcontextprotocol/server-postgres" },
  filesystem: { bin: "mcp-server-filesystem", pkg: "@modelcontextprotocol/server-filesystem" },
} as const;

export type PreinstalledMcpServer = keyof typeof PREINSTALLED_MCP_SERVERS;

const OFF = new Set(["0", "false", "no", "off"]);

/** Whether the built-in providers run the images' binaries rather than `npx`. */
export function mcpServersPreinstalled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.OPTIO_MCP_PREINSTALLED?.trim().toLowerCase();
  return !!flag && !OFF.has(flag);
}

/** The `command` and `args` of a built-in MCP server's `mcpConfig`. */
export function builtInMcpCommand(
  server: PreinstalledMcpServer,
  args: readonly string[] = [],
  preinstalled: boolean = mcpServersPreinstalled(),
): { command: string; args: string[] } {
  const spec = PREINSTALLED_MCP_SERVERS[server];
  return preinstalled
    ? { command: spec.bin, args: [...args] }
    : { command: "npx", args: ["-y", spec.pkg, ...args] };
}
