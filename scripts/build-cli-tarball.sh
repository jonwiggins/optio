#!/usr/bin/env bash
# The Optio CLI as one download for machines that can't reach a registry:
# the bundles the API serves (GET /api/cli/optio-cli*.tgz, unpacked by
# install.sh / install.ps1; docs/remote-workspaces.md) or a manually
# distributed archive (docs/air-gapped.md). Layout:
#
#   optio-cli/package.json                  (type: module, bin optio)
#   optio-cli/dist/optio.js (+ chunks)      (everything bundled but the two below)
#   optio-cli/node_modules/ws/
#   optio-cli/node_modules/node-pty/        (lib/ + the native part for one OS)
#
#   scripts/build-cli-tarball.sh [--platform linux|darwin|win32] [out.tgz]
#
# --platform picks the native part of node-pty (default linux):
#   linux   build/Release/pty.node, compiled on this machine (node-pty has no
#           Linux prebuild). Built for this machine's CPU only.
#   darwin  node-pty's own prebuilds for macOS (x64 and arm64), as its npm
#           package ships them: nothing is compiled or downloaded.
#   win32   node-pty's own prebuilds for Windows (x64 and arm64), without
#           their debug symbols (*.pdb).
# The default output is ./optio-cli.tgz (linux) or ./optio-cli-<platform>.tgz.
#
# Needs the workspace's dependencies installed (pnpm install). For linux,
# node-pty must be built first: `pnpm --filter @optio/cli rebuild node-pty`
# with python3, make and g++. On a machine with Docker:
#
#   docker run --rm -v "$PWD:/repo" -w /repo -e npm_config_nodedir=/usr/local node:26 bash -c '
#     apt-get update && apt-get install -y --no-install-recommends python3 make g++ &&
#     npm install -g pnpm@10.34.8 && pnpm --filter @optio/cli rebuild node-pty && scripts/build-cli-tarball.sh'
#
# apps/cli's own build (`pnpm --filter @optio/cli build`, tsup.config.ts)
# leaves its npm dependencies (commander, yaml, @xterm/*, open) to
# node_modules, as a package does. The bundle carries no node_modules but ws
# and node-pty, so this is the same build with everything else bundled in
# (and a `require` for the CommonJS ones). It is checked before it is packed:
# a linux bundle must run, and node-pty must load, on this (Linux) machine; a
# darwin or win32 bundle can't run here, so its script must parse and the
# prebuilt files node-pty loads on that OS must be there.
set -euo pipefail

PLATFORM=linux
if [ "${1:-}" = "--platform" ]; then
  PLATFORM="${2:-}"
  shift 2 || true
fi
case "$PLATFORM" in
  linux) DEFAULT_OUT=optio-cli.tgz ;;
  darwin | win32) DEFAULT_OUT="optio-cli-$PLATFORM.tgz" ;;
  *)
    echo "--platform must be linux, darwin or win32 (got '$PLATFORM')" >&2
    exit 2
    ;;
esac

cd "$(dirname "$0")/.."
OUT="${1:-$DEFAULT_OUT}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac

# Where pnpm put the two dependencies the bundle leaves outside.
resolve() {
  node -e 'const p = require("path"); console.log(p.dirname(require.resolve(process.argv[1] + "/package.json", { paths: [process.argv[2]] })))' "$1" "$PWD/apps/cli"
}
WS_DIR="$(resolve ws)"
PTY_DIR="$(resolve node-pty)"
# The native files node-pty loads on each OS (lib/utils.js loadNativeModule,
# lib/windowsPtyAgent.js): prebuilds/<os>-<arch>/.
case "$PLATFORM" in
  darwin) PREBUILT_FILES="pty.node spawn-helper" ;;
  win32) PREBUILT_FILES="pty.node conpty.node conpty_console_list.node winpty.dll winpty-agent.exe conpty/conpty.dll conpty/OpenConsole.exe" ;;
  *) PREBUILT_FILES="" ;;
esac
if [ "$PLATFORM" = linux ]; then
  if [ ! -f "$PTY_DIR/build/Release/pty.node" ]; then
    echo "node-pty has no build/Release/pty.node — run \`pnpm --filter @optio/cli rebuild node-pty\` (python3, make, g++) first" >&2
    exit 1
  fi
else
  for arch in x64 arm64; do
    for f in $PREBUILT_FILES; do
      if [ ! -f "$PTY_DIR/prebuilds/$PLATFORM-$arch/$f" ]; then
        echo "node-pty has no prebuilds/$PLATFORM-$arch/$f: this node-pty package ships no $PLATFORM build" >&2
        exit 1
      fi
    done
  done
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
CLI="$STAGE/optio-cli"
mkdir -p "$CLI/dist" "$CLI/node_modules/node-pty"

cat > "$STAGE/tsup.config.mjs" <<CONFIG
export default {
  entry: { optio: "src/index.ts" },
  format: "esm",
  target: "node20",
  bundle: true,
  sourcemap: true,
  outDir: "$CLI/dist",
  dts: false,
  external: ["ws", "node-pty"],
  noExternal: [/^(?!ws\$|node-pty\$)/],
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __optioCreateRequire } from "node:module";',
      "const require = __optioCreateRequire(import.meta.url);",
    ].join("\\n"),
  },
  shims: false,
};
CONFIG
echo "Building @optio/cli (bundled) ..."
pnpm --filter @optio/cli exec tsup --config "$STAGE/tsup.config.mjs" >/dev/null

VERSION="$(node -p 'require("./apps/cli/package.json").version')"
cat > "$CLI/package.json" <<PACKAGE
{
  "name": "@optio/cli",
  "version": "$VERSION",
  "type": "module",
  "bin": { "optio": "./dist/optio.js" },
  "engines": { "node": ">=20" }
}
PACKAGE

cp -RL "$WS_DIR" "$CLI/node_modules/ws"
cp -RL "$PTY_DIR/lib" "$PTY_DIR/package.json" "$CLI/node_modules/node-pty/"
if [ -f "$PTY_DIR/LICENSE" ]; then cp "$PTY_DIR/LICENSE" "$CLI/node_modules/node-pty/"; fi
if [ "$PLATFORM" = linux ]; then
  mkdir -p "$CLI/node_modules/node-pty/build/Release"
  cp "$PTY_DIR/build/Release/pty.node" "$CLI/node_modules/node-pty/build/Release/"
  TARGET="$(uname -s)-$(uname -m)"
else
  for arch in x64 arm64; do
    for f in $PREBUILT_FILES; do
      mkdir -p "$(dirname "$CLI/node_modules/node-pty/prebuilds/$PLATFORM-$arch/$f")"
      cp "$PTY_DIR/prebuilds/$PLATFORM-$arch/$f" "$CLI/node_modules/node-pty/prebuilds/$PLATFORM-$arch/$f"
    done
  done
  # pnpm unpacks spawn-helper without its execute bit; the tarball keeps one.
  if [ "$PLATFORM" = darwin ]; then
    chmod 755 "$CLI"/node_modules/node-pty/prebuilds/darwin-*/spawn-helper
  fi
  TARGET="$PLATFORM-x64+arm64"
fi

if [ "$PLATFORM" = linux ] && [ "$(uname -s)" = "Linux" ]; then
  (cd "$CLI" && node -e 'require("node-pty"); require("ws")') || {
    echo "The bundled node-pty doesn't load on Linux ($(uname -m)) — rebuild it here first" >&2
    exit 1
  }
  node "$CLI/dist/optio.js" --version >/dev/null
elif [ "$PLATFORM" != linux ]; then
  node --check "$CLI/dist/optio.js"
fi

tar czf "$OUT" -C "$STAGE" optio-cli
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1)): optio-cli $VERSION for $TARGET"
