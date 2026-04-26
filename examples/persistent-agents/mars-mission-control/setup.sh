#!/usr/bin/env bash
# Provision the Mars Mission Control demo into the running Optio API.
#
# Usage:
#   OPTIO_API_URL=http://localhost:30400 ./setup.sh
#   SOL_INTERVAL_MINUTES=3 ./setup.sh   # faster demo
#
# Idempotent: agent slugs are unique per workspace, so re-runs skip existing
# agents (HTTP 409 → "already exists"). The Clock's schedule trigger is also
# upserted (a duplicate trigger is detected and skipped).

set -euo pipefail

API="${OPTIO_API_URL:-http://localhost:30400}"
SOL_INTERVAL_MINUTES="${SOL_INTERVAL_MINUTES:-10}"
DIR="$(cd "$(dirname "$0")" && pwd)"

AUTH_HEADER=()
if [ -n "${OPTIO_API_TOKEN:-}" ]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${OPTIO_API_TOKEN}")
fi
WORKSPACE_HEADER=()
if [ -n "${OPTIO_WORKSPACE_ID:-}" ]; then
  WORKSPACE_HEADER=(-H "X-Optio-Workspace-Id: ${OPTIO_WORKSPACE_ID}")
fi

echo "→ Mars Mission Control setup against $API"
echo "  sol interval: every ${SOL_INTERVAL_MINUTES} min"
echo ""

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
      echo "FAILED (HTTP $code)"
      echo "    $body"
      return 1
      ;;
  esac
}

# Provision in dependency order: specialists first, Director, Clock last
# (so by the time the Clock starts firing, everyone else is online).
for slug in trajectory comms life-support geology eva director clock; do
  create_agent "$slug" "$DIR/agents/$slug.json"
done

# Look up the Clock's id so we can attach the schedule trigger.
echo ""
echo -n "→ resolving clock id ... "
CLOCK_ID=$(curl -sS ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} ${WORKSPACE_HEADER[@]+"${WORKSPACE_HEADER[@]}"} \
  "$API/api/persistent-agents" \
  | jq -r '.agents[] | select(.slug=="clock") | .id')
if [ -z "$CLOCK_ID" ] || [ "$CLOCK_ID" = "null" ]; then
  echo "FAILED — clock agent not found"
  exit 1
fi
echo "$CLOCK_ID"

# Check whether a schedule trigger already exists; only create if not.
echo -n "→ checking existing triggers ... "
EXISTING=$(curl -sS ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} ${WORKSPACE_HEADER[@]+"${WORKSPACE_HEADER[@]}"} \
  "$API/api/persistent-agents/$CLOCK_ID/triggers" \
  | jq -r '.triggers[] | select(.type=="schedule") | .id' \
  | head -n1)
if [ -n "$EXISTING" ] && [ "$EXISTING" != "null" ]; then
  echo "schedule trigger already attached ($EXISTING), skipping"
else
  echo "none"
  CRON="*/${SOL_INTERVAL_MINUTES} * * * *"
  echo -n "→ attaching schedule trigger ($CRON) ... "
  resp=$(curl -sS -w "\n%{http_code}" \
    ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} ${WORKSPACE_HEADER[@]+"${WORKSPACE_HEADER[@]}"} \
    -H "Content-Type: application/json" \
    -X POST "$API/api/persistent-agents/$CLOCK_ID/triggers" \
    --data "$(jq -n --arg cron "$CRON" \
      '{type:"schedule", config:{cronExpression:$cron}, enabled:true}')")
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  if [ "$code" = "201" ]; then
    echo "attached"
  else
    echo "FAILED (HTTP $code)"
    echo "    $body"
    exit 1
  fi
fi

echo ""
echo "✓ Mars Mission Control provisioned."
echo ""
echo "  Open the UI:"
echo "    /agents             — see all seven"
echo "    /agents/director    — best view; mission log builds up here"
echo "    /agents/clock       — watch the cron tick advance the sols"
echo ""
echo "  First sol will broadcast within ~${SOL_INTERVAL_MINUTES} min."
echo "  Mission completes after Sol 5 (~$((SOL_INTERVAL_MINUTES * 5)) min total)."
