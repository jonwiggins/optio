#!/bin/sh
# Pairs this codespace with Optio when Optio started it for a piece of work
# (docs/remote-workspaces.md, "GitHub Codespaces"). Optio sealed the pairing
# bundle into the Codespaces secret OPTIO_PAIRING_<this codespace's name>,
# which GitHub hands the codespace as an environment variable when it starts.
# A codespace someone opened by hand has none: nothing happens.
set -eu
name=$(printf '%s' "${CODESPACE_NAME:-}" | tr 'a-z' 'A-Z' | tr -c 'A-Z0-9' '_')
bundle=$(printenv "OPTIO_PAIRING_$name" || true)
[ -n "$bundle" ] || exit 0
# The secret is `export OPTIO_…='…'` lines, base64-encoded.
eval "$(printf '%s' "$bundle" | base64 -d)"
# The start script: the agent policy, the CLI from Optio, `optio local up`.
curl -fsSL "$OPTIO_SERVER/api/cli/workspace-start.sh" | sh
