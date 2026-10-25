import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorResponseSchema } from "../schemas/common.js";
import { START_SCRIPT } from "../services/remote-workspaces/start-script.js";

/**
 * Downloads for people's own machines (docs/controller-mcp.md, "Connect your
 * own agent"): the stdio adapter for MCP clients that cannot speak
 * Streamable HTTP themselves. It is `packages/mcp-bridge`'s
 * `controller-mcp.js`, one self-contained file (tsup, `noExternal`), the
 * same one the agent images carry at /opt/optio/controller-mcp.js. With no
 * internet access, nobody can `pnpm --filter @optio/mcp-bridge build` from
 * a checkout, so the API hands it out.
 *
 * Where it comes from: `OPTIO_MCP_BRIDGE_DIST` (the file, or the directory
 * holding it) when set — set wrongly, it is a 404, not a silent fallback —
 * else /opt/optio/controller-mcp.js (the API image, when it bakes it in),
 * else the package's own dist in a source checkout (development).
 */

export const CONTROLLER_MCP_BUNDLE = "controller-mcp.js";
const IMAGE_PATH = `/opt/optio/${CONTROLLER_MCP_BUNDLE}`;

/** The files that may hold the bundle, most explicit first. */
export function bridgeBundleCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.OPTIO_MCP_BRIDGE_DIST?.trim();
  if (configured) {
    return [configured.endsWith(".js") ? configured : path.join(configured, CONTROLLER_MCP_BUNDLE)];
  }
  const packageDist = fileURLToPath(
    new URL(`../../../../packages/mcp-bridge/dist/${CONTROLLER_MCP_BUNDLE}`, import.meta.url),
  );
  return [IMAGE_PATH, packageDist];
}

/** The first candidate that is a file, or null. */
export async function findBridgeBundle(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  for (const candidate of bridgeBundleCandidates(env)) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // not there; try the next
    }
  }
  return null;
}

/**
 * The Optio CLI for a machine that can't reach a registry (docs/remote-workspaces.md):
 * `install.sh` fetches `optio-cli.tgz` from the same server — the built
 * `apps/cli` with `ws` and `node-pty` (a Linux build of its binary), made by
 * scripts/build-cli-tarball.sh and baked into the API image at
 * /app/static/optio-cli.tgz — unpacks it into ~/.optio/cli and writes the
 * `optio` command into ~/.optio/bin. `OPTIO_CLI_TARBALL` points elsewhere.
 * Both are public (a remote workspace has no session yet; nothing in them is
 * secret) and rate-limited, as is `workspace-start.sh`, the script that pairs
 * a remote workspace (services/remote-workspaces/start-script.ts).
 */
export const CLI_TARBALL_IMAGE_PATH = "/app/static/optio-cli.tgz";

export function cliTarballPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPTIO_CLI_TARBALL?.trim() || CLI_TARBALL_IMAGE_PATH;
}

/**
 * The server `install.sh` downloads from when the caller's environment has
 * no OPTIO_SERVER: the configured public origin, else the origin the request
 * came in on. Null when that isn't a plain http(s) origin — it goes into a
 * shell script.
 */
export function installServerOrigin(
  request: { protocol: string; host: string },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // As services/oauth/provider.ts `publicApiOrigin` reads them.
  const own = env.PUBLIC_API_URL?.trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "");
  const shared = env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  const candidate = own || shared || `${request.protocol}://${request.host}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const origin = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
    return /^[A-Za-z0-9:/.\-[\]_~%]+$/.test(origin) ? origin : null;
  } catch {
    return null;
  }
}

/** The installer, with `server` as the default OPTIO_SERVER. */
export function installScript(server: string): string {
  return `#!/bin/sh
# The Optio CLI installer (GET /api/cli/install.sh; docs/remote-workspaces.md).
# Installs the CLI into ~/.optio/cli and the \`optio\` command into ~/.optio/bin.
# Needs Node.js 20+ and tar; downloads with curl or wget.
set -eu

DEFAULT_SERVER='${server}'
OPTIO_SERVER="\${OPTIO_SERVER:-$DEFAULT_SERVER}"
OPTIO_HOME="\${OPTIO_HOME:-$HOME/.optio}"

fail() { echo "optio install: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js 20 or newer is needed (no node on PATH)"
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] 2>/dev/null || fail "Node.js 20 or newer is needed (found $(node --version))"
command -v tar >/dev/null 2>&1 || fail "tar is needed"

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else fail "curl or wget is needed"; fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fetch "$OPTIO_SERVER/api/cli/optio-cli.tgz" > "$tmp/optio-cli.tgz" ||
  fail "couldn't download $OPTIO_SERVER/api/cli/optio-cli.tgz"
mkdir -p "$tmp/x"
tar xzf "$tmp/optio-cli.tgz" -C "$tmp/x"
[ -f "$tmp/x/optio-cli/dist/optio.js" ] || fail "the download isn't an Optio CLI bundle"

mkdir -p "$OPTIO_HOME/bin"
rm -rf "$OPTIO_HOME/cli"
mv "$tmp/x/optio-cli" "$OPTIO_HOME/cli"
printf '#!/bin/sh\\nexec node "%s/cli/dist/optio.js" "$@"\\n' "$OPTIO_HOME" > "$OPTIO_HOME/bin/optio"
chmod +x "$OPTIO_HOME/bin/optio"

echo "Installed $("$OPTIO_HOME/bin/optio" --version 2>/dev/null || echo optio) at $OPTIO_HOME/bin/optio"
case ":$PATH:" in
  *":$OPTIO_HOME/bin:"*) ;;
  *) echo "Add it to your PATH: export PATH=\\"$OPTIO_HOME/bin:\\$PATH\\"" ;;
esac
`;
}

/** Per-IP limits for the public downloads. */
const DOWNLOAD_RATE_LIMIT = { rateLimit: { max: 30, timeWindow: "1 minute" } };

export async function cliDownloadRoutes(rawApp: FastifyInstance) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  app.get(
    "/api/cli/install.sh",
    {
      config: DOWNLOAD_RATE_LIMIT,
      schema: {
        operationId: "getCliInstallScript",
        summary: "The Optio CLI installer",
        description:
          "A POSIX shell script: `curl -fsSL <server>/api/cli/install.sh | sh` checks for " +
          "Node.js 20+, downloads /api/cli/optio-cli.tgz from OPTIO_SERVER (default: this " +
          "server), unpacks it into ~/.optio/cli and writes ~/.optio/bin/optio. Public.",
        tags: ["System"],
        security: [],
        response: { 200: z.string().describe("The shell script"), 500: ErrorResponseSchema },
      },
    },
    async (req, reply) => {
      const server = installServerOrigin({ protocol: req.protocol, host: req.host });
      if (!server) {
        return reply.status(500).send({
          error: "Can't tell this server's address: set PUBLIC_API_URL (or PUBLIC_URL)",
        });
      }
      return reply
        .header("Content-Type", "text/x-shellscript; charset=utf-8")
        .header("Cache-Control", "no-cache")
        .send(installScript(server));
    },
  );

  app.get(
    "/api/cli/workspace-start.sh",
    {
      config: DOWNLOAD_RATE_LIMIT,
      schema: {
        operationId: "getWorkspaceStartScript",
        summary: "The script that pairs a remote workspace",
        description:
          'A POSIX shell script (docs/remote-workspaces.md, "The start script"): with ' +
          "OPTIO_SERVER, OPTIO_TOKEN and OPTIO_LOCAL_HOST_ID in its environment it applies " +
          "the agent policy, clones OPTIO_REPO_URL into OPTIO_CHECKOUT_DIR, installs the CLI " +
          "(/api/cli/install.sh) and starts `optio local up` there. Without them it does " +
          "nothing. Public; it holds no secret.",
        tags: ["System"],
        security: [],
        response: { 200: z.string().describe("The shell script") },
      },
    },
    async (_req, reply) =>
      reply
        .header("Content-Type", "text/x-shellscript; charset=utf-8")
        .header("Cache-Control", "no-cache")
        .send(START_SCRIPT),
  );

  app.get(
    "/api/cli/optio-cli.tgz",
    {
      config: DOWNLOAD_RATE_LIMIT,
      schema: {
        operationId: "downloadCliTarball",
        summary: "Download the Optio CLI bundle",
        description:
          "`optio-cli/` as a gzipped tar: dist/optio.js and its two native dependencies " +
          "(ws, node-pty with a Linux binary). 404 when this deployment doesn't carry it " +
          "(OPTIO_CLI_TARBALL, default /app/static/optio-cli.tgz). Public.",
        tags: ["System"],
        security: [],
        response: { 200: z.any().describe("application/gzip"), 404: ErrorResponseSchema },
      },
    },
    async (_req, reply) => {
      const file = cliTarballPath();
      let size: number;
      try {
        const info = await stat(file);
        if (!info.isFile()) throw new Error("not a file");
        size = info.size;
      } catch {
        return reply.status(404).send({
          error:
            `The Optio CLI bundle is not available on this deployment: no file at ${file}. ` +
            "Build it with scripts/build-cli-tarball.sh and set OPTIO_CLI_TARBALL to it.",
        });
      }
      return reply
        .header("Content-Type", "application/gzip")
        .header("Content-Length", String(size))
        .header("Content-Disposition", 'attachment; filename="optio-cli.tgz"')
        .header("Cache-Control", "no-cache")
        .send(createReadStream(file));
    },
  );

  app.get(
    `/api/downloads/${CONTROLLER_MCP_BUNDLE}`,
    {
      schema: {
        operationId: "downloadControllerMcpBridge",
        summary: "Download the stdio adapter for the Optio controller MCP",
        description:
          "The single-file `controller-mcp.js` (packages/mcp-bridge) that an MCP " +
          "client without Streamable HTTP support runs with `node`; it relays " +
          "tool calls to /api/mcp with OPTIO_MCP_URL, OPTIO_MCP_TOKEN and " +
          "OPTIO_WORKSPACE_ID from its environment. 404 when this deployment " +
          "does not carry the bundle.",
        tags: ["System"],
        response: {
          200: z.string().describe("The JavaScript bundle, as an attachment"),
          404: ErrorResponseSchema,
        },
      },
    },
    async (_req, reply) => {
      const file = await findBridgeBundle();
      if (!file) {
        return reply.status(404).send({
          error:
            "The stdio adapter is not available on this deployment: no controller-mcp.js " +
            "at OPTIO_MCP_BRIDGE_DIST or /opt/optio. Build it with " +
            "`pnpm --filter @optio/mcp-bridge build` and set OPTIO_MCP_BRIDGE_DIST to its dist directory.",
        });
      }
      return reply
        .header("Content-Type", "text/javascript; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="optio-${CONTROLLER_MCP_BUNDLE}"`)
        .header("Cache-Control", "no-cache")
        .send(await readFile(file, "utf8"));
    },
  );
}
