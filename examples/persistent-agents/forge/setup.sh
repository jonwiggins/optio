#!/usr/bin/env bash
# Provision the Forge multi-agent demo into the running Optio API.
#
# Usage:
#   OPTIO_API_URL=http://localhost:30400 ./demos/the-forge/setup.sh
#
# Idempotent: re-runs are safe (server-side slug uniqueness returns 409,
# which we treat as "already exists").

set -euo pipefail

API="${OPTIO_API_URL:-http://localhost:30400}"
DIR="$(cd "$(dirname "$0")" && pwd)"

# Optional bearer token for API auth — set OPTIO_API_TOKEN if your server
# requires session/JWT auth. Local dev with OPTIO_AUTH_DISABLED=true needs nothing.
AUTH_HEADER=()
if [ -n "${OPTIO_API_TOKEN:-}" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${OPTIO_API_TOKEN}")
fi

# Optional workspace id — if your server is multi-tenant.
WORKSPACE_HEADER=()
if [ -n "${OPTIO_WORKSPACE_ID:-}" ]; then
  WORKSPACE_HEADER=(-H "X-Optio-Workspace-Id: ${OPTIO_WORKSPACE_ID}")
fi

echo "→ Forge demo setup against $API"

create_agent() {
  local slug="$1"
  local file="$2"
  echo -n "  • $slug ... "

  local resp
  resp=$(curl -sS -w "\n%{http_code}" \
    ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} ${WORKSPACE_HEADER[@]+"${WORKSPACE_HEADER[@]}"} \
    -H "Content-Type: application/json" \
    -X POST "$API/api/persistent-agents" \
    --data @"$file")
  local code="${resp##*$'\n'}"
  local body="${resp%$'\n'*}"

  case "$code" in
    201)
      echo "created"
      ;;
    409)
      echo "already exists, skipping"
      ;;
    *)
      echo "failed (HTTP $code)"
      echo "    $body"
      return 1
      ;;
  esac
}

for slug in vesper forge sentinel chronicler; do
  create_agent "$slug" "$DIR/agents/$slug.json"
done

echo ""
echo "✓ Forge demo provisioned. Open the UI:"
echo "    /agents — see all four"
echo "    /agents/vesper — talk to the architect"
echo ""
echo "Try sending Vesper a feature request:"
echo "    Add a /healthz endpoint to the api server that returns OK"
