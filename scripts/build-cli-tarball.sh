#!/usr/bin/env bash
# The Optio CLI as one download for machines that can't reach a registry —
# a manually distributed archive (docs/air-gapped.md). Layout:
#
#   optio-cli/package.json                  (type: module, bin optio)
#   optio-cli/dist/optio.js (+ chunks)      (everything bundled but the two below)
#   optio-cli/node_modules/ws/
#   optio-cli/node_modules/node-pty/        (lib/ + a Linux build/Release/pty.node)
#
#   scripts/build-cli-tarball.sh [out.tgz]     # default: ./optio-cli.tgz
#
# Needs the workspace's dependencies installed (pnpm install) and node-pty
# built for Linux: run `pnpm --filter @optio/cli rebuild node-pty` with
# python3, make and g++ first. On a machine with Docker:
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
# it must run, and node-pty must load, on this (Linux) machine.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="${1:-optio-cli.tgz}"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac

# Where pnpm put the two dependencies the bundle leaves outside.
resolve() {
  node -e 'const p = require("path"); console.log(p.dirname(require.resolve(process.argv[1] + "/package.json", { paths: [process.argv[2]] })))' "$1" "$PWD/apps/cli"
}
WS_DIR="$(resolve ws)"
PTY_DIR="$(resolve node-pty)"
if [ ! -f "$PTY_DIR/build/Release/pty.node" ]; then
  echo "node-pty has no build/Release/pty.node — run \`pnpm --filter @optio/cli rebuild node-pty\` (python3, make, g++) first" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
CLI="$STAGE/optio-cli"
mkdir -p "$CLI/dist" "$CLI/node_modules/node-pty/build/Release"

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
cp "$PTY_DIR/build/Release/pty.node" "$CLI/node_modules/node-pty/build/Release/"

if [ "$(uname -s)" = "Linux" ]; then
  (cd "$CLI" && node -e 'require("node-pty"); require("ws")') || {
    echo "The bundled node-pty doesn't load on Linux ($(uname -m)) — rebuild it here first" >&2
    exit 1
  }
  node "$CLI/dist/optio.js" --version >/dev/null
fi

tar czf "$OUT" -C "$STAGE" optio-cli
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1)): optio-cli $VERSION for $(uname -s)-$(uname -m)"
