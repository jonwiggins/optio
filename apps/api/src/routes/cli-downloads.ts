import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErrorResponseSchema } from "../schemas/common.js";
import { START_SCRIPT } from "../services/remote-workspaces/start-script.js";

/**
 * The Optio CLI for a machine that can't reach a registry (docs/remote-workspaces.md):
 * `install.sh` (Linux, macOS) and `install.ps1` (Windows) fetch the bundle for
 * their OS from the same server — the built `apps/cli` with `ws` and
 * `node-pty`, made by scripts/build-cli-tarball.sh and baked into the API
 * image under /app/static: `optio-cli.tgz` (node-pty compiled for Linux),
 * `optio-cli-darwin.tgz` and `optio-cli-win32.tgz` (node-pty's own prebuilt
 * binaries). They unpack it into ~/.optio/cli and write the `optio` command
 * into ~/.optio/bin. `OPTIO_CLI_TARBALL`, `OPTIO_CLI_TARBALL_DARWIN` and
 * `OPTIO_CLI_TARBALL_WIN32` point elsewhere. All of it is public (a remote
 * workspace has no session yet; nothing in them is secret) and rate-limited,
 * as is `workspace-start.sh`, the script that pairs a remote workspace
 * (services/remote-workspaces/start-script.ts).
 */
export const CLI_TARBALL_IMAGE_PATH = "/app/static/optio-cli.tgz";

export function cliTarballPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPTIO_CLI_TARBALL?.trim() || CLI_TARBALL_IMAGE_PATH;
}

/** The operating systems a CLI bundle is built for (`process.platform` names). */
export const CLI_PLATFORMS = ["linux", "darwin", "win32"] as const;
export type CliPlatform = (typeof CLI_PLATFORMS)[number];

/** Each bundle's name under /api/cli/ (and /app/static/), and the variable that moves it. */
const CLI_BUNDLES: Record<CliPlatform, { file: string; envVar: string }> = {
  linux: { file: "optio-cli.tgz", envVar: "OPTIO_CLI_TARBALL" },
  darwin: { file: "optio-cli-darwin.tgz", envVar: "OPTIO_CLI_TARBALL_DARWIN" },
  win32: { file: "optio-cli-win32.tgz", envVar: "OPTIO_CLI_TARBALL_WIN32" },
};

export function cliBundleFile(platform: CliPlatform): string {
  return CLI_BUNDLES[platform].file;
}

/** Where the bundle for `platform` is on disk. */
export function cliBundlePath(platform: CliPlatform, env: NodeJS.ProcessEnv = process.env): string {
  const { file, envVar } = CLI_BUNDLES[platform];
  return env[envVar]?.trim() || `/app/static/${file}`;
}

/** The bundle's size, or null when this deployment doesn't carry it. */
async function bundleSize(file: string): Promise<number | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

/**
 * The server `install.sh` downloads from when the caller's environment has
 * no OPTIO_SERVER: the configured public origin, else the origin the request
 * came in on. Null when that isn't a plain http(s) origin — it goes into a
 * shell script.
 */
export function installServerOrigin(
  _request: { protocol: string; host: string },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // As services/oauth/provider.ts `publicApiOrigin` reads them.
  const own = env.PUBLIC_API_URL?.trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "");
  const shared = env.PUBLIC_URL?.trim().replace(/\/+$/, "");
  const candidate = own || shared;
  if (!candidate) return null;
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
# The Optio CLI installer for Linux and macOS (GET /api/cli/install.sh;
# docs/remote-workspaces.md). Installs the CLI into ~/.optio/cli and the
# \`optio\` command into ~/.optio/bin.
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

case "$(uname -s)" in
  Darwin) bundle="$OPTIO_SERVER/api/cli/optio-cli-darwin.tgz" ;;
  MINGW* | MSYS* | CYGWIN*)
    fail "on Windows, install from PowerShell: irm $OPTIO_SERVER/api/cli/install.ps1 | iex" ;;
  *) bundle="$OPTIO_SERVER/api/cli/optio-cli.tgz" ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fetch "$bundle" > "$tmp/optio-cli.tgz" || fail "couldn't download $bundle"
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

/**
 * The Windows installer, with `server` as the default OPTIO_SERVER. Run as
 * `irm <server>/api/cli/install.ps1 | iex` in Windows PowerShell 5.1 or
 * PowerShell 7, so it runs in a script block (nothing left behind in the
 * caller's session) and stops with `throw`, never `exit`, which would close
 * that window. It uses Windows' own tar.exe: another `tar` first on PATH
 * (Git for Windows ships GNU tar) reads `C:` as a remote host.
 */
export function installPowerShellScript(server: string): string {
  return String.raw`# The Optio CLI installer for Windows (GET /api/cli/install.ps1;
# docs/remote-workspaces.md). Installs the CLI into $HOME\.optio\cli and the
# optio command (optio.cmd) into $HOME\.optio\bin. Needs Node.js 20+ and
# Windows 10 1803 or later (for tar.exe).
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $DefaultServer = '${server}'
  $Server = if ($env:OPTIO_SERVER) { $env:OPTIO_SERVER.TrimEnd('/') } else { $DefaultServer }
  $OptioHome = if ($env:OPTIO_HOME) { $env:OPTIO_HOME } else { Join-Path $HOME '.optio' }

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'optio install: Node.js 20 or newer is needed (no node on PATH)'
  }
  $major = [int](& node -p "process.versions.node.split('.')[0]")
  if ($major -lt 20) { throw "optio install: Node.js 20 or newer is needed (found $(& node --version))" }
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path $tar)) { throw 'optio install: tar.exe is needed (Windows 10 1803 or later)' }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('optio-install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $bundle = "$Server/api/cli/optio-cli-win32.tgz"
    $tgz = Join-Path $tmp 'optio-cli.tgz'
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $bundle -OutFile $tgz
    } catch {
      throw "optio install: couldn't download $bundle ($($_.Exception.Message))"
    }
    $x = Join-Path $tmp 'x'
    New-Item -ItemType Directory -Path $x | Out-Null
    & $tar -xzf $tgz -C $x
    if ($LASTEXITCODE -ne 0) { throw "optio install: couldn't unpack $bundle" }
    if (-not (Test-Path (Join-Path $x 'optio-cli\dist\optio.js'))) {
      throw "optio install: the download isn't an Optio CLI bundle"
    }

    $bin = Join-Path $OptioHome 'bin'
    $cli = Join-Path $OptioHome 'cli'
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    if (Test-Path $cli) { Remove-Item -Recurse -Force $cli }
    Copy-Item -Recurse (Join-Path $x 'optio-cli') $cli
    Set-Content -Path (Join-Path $bin 'optio.cmd') -Encoding Ascii -Value @(
      '@echo off',
      'node "%~dp0..\cli\dist\optio.js" %*'
    )
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  $optio = Join-Path $bin 'optio.cmd'
  $version = & $optio --version 2>$null
  if (-not $version) { $version = 'optio' }
  Write-Host "Installed $version at $optio"
  if (-not (($env:Path -split ';') -contains $bin)) {
    Write-Host 'Add it to your PATH, for this window and for new ones:'
    Write-Host "  $('$')env:Path = '$bin;' + $('$')env:Path"
    Write-Host "  [Environment]::SetEnvironmentVariable('Path', '$bin;' + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
  }
}
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
          "OPTIO_SERVER, OPTIO_TOKEN and OPTIO_LOCAL_HOST_ID in its environment it " +
          "clones OPTIO_REPO_URL into OPTIO_CHECKOUT_DIR, installs the CLI " +
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
    "/api/cli/install.ps1",
    {
      config: DOWNLOAD_RATE_LIMIT,
      schema: {
        operationId: "getCliInstallPowerShellScript",
        summary: "The Optio CLI installer for Windows",
        description:
          "A PowerShell script: `irm <server>/api/cli/install.ps1 | iex` checks for Node.js " +
          "20+, downloads /api/cli/optio-cli-win32.tgz from OPTIO_SERVER (default: this " +
          "server), unpacks it into ~/.optio/cli and writes ~/.optio/bin/optio.cmd. Public.",
        tags: ["System"],
        security: [],
        response: { 200: z.string().describe("The PowerShell script"), 500: ErrorResponseSchema },
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
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Cache-Control", "no-cache")
        .send(installPowerShellScript(server));
    },
  );

  app.get(
    "/api/cli/downloads",
    {
      config: DOWNLOAD_RATE_LIMIT,
      schema: {
        operationId: "listCliDownloads",
        summary: "Which Optio CLI bundles this deployment serves",
        description:
          "For each OS (linux, darwin, win32), whether its bundle is on this deployment, so a " +
          "client can offer the installer only where it works. Public.",
        tags: ["System"],
        security: [],
        response: {
          200: z.object({
            bundles: z.object({ linux: z.boolean(), darwin: z.boolean(), win32: z.boolean() }),
          }),
        },
      },
    },
    async (_req, reply) => {
      const entries = await Promise.all(
        CLI_PLATFORMS.map(
          async (platform) =>
            [platform, (await bundleSize(cliBundlePath(platform))) !== null] as const,
        ),
      );
      return reply
        .header("Cache-Control", "no-cache")
        .send({ bundles: Object.fromEntries(entries) as Record<CliPlatform, boolean> });
    },
  );

  const nativePart: Record<CliPlatform, string> = {
    linux: "node-pty with a Linux binary",
    darwin: "node-pty with its prebuilt macOS binaries, x64 and arm64",
    win32: "node-pty with its prebuilt Windows binaries, x64 and arm64",
  };
  for (const platform of CLI_PLATFORMS) {
    const file = cliBundleFile(platform);
    const { envVar } = CLI_BUNDLES[platform];
    app.get(
      `/api/cli/${file}`,
      {
        config: DOWNLOAD_RATE_LIMIT,
        schema: {
          operationId:
            platform === "linux"
              ? "downloadCliTarball"
              : `downloadCliTarball${platform === "darwin" ? "Darwin" : "Win32"}`,
          summary: `Download the Optio CLI bundle (${platform})`,
          description:
            "`optio-cli/` as a gzipped tar: dist/optio.js and its two native dependencies " +
            `(ws, ${nativePart[platform]}). 404 when this deployment doesn't carry it ` +
            `(${envVar}, default /app/static/${file}). Public.`,
          tags: ["System"],
          security: [],
          response: { 200: z.any().describe("application/gzip"), 404: ErrorResponseSchema },
        },
      },
      async (_req, reply) => {
        const bundlePath = cliBundlePath(platform);
        const size = await bundleSize(bundlePath);
        if (size === null) {
          const build =
            platform === "linux"
              ? "scripts/build-cli-tarball.sh"
              : `scripts/build-cli-tarball.sh --platform ${platform}`;
          return reply.status(404).send({
            error:
              `The Optio CLI bundle is not available on this deployment: no file at ${bundlePath}. ` +
              `Build it with ${build} and set ${envVar} to it.`,
          });
        }
        return reply
          .header("Content-Type", "application/gzip")
          .header("Content-Length", String(size))
          .header("Content-Disposition", `attachment; filename="${file}"`)
          .header("Cache-Control", "no-cache")
          .send(createReadStream(bundlePath));
      },
    );
  }
}
