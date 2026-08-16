#!/usr/bin/env bash
# Live-cluster smoke test against the deployed Optio stack (local Helm
# deployment by default). Verifies the API is healthy, the web UI serves,
# and — unless --no-llm — that a real agent run completes end-to-end
# through the Kubernetes pod pipeline (creates a tiny standalone Job with a
# one-line prompt, waits for completion, then deletes it).
#
# The LLM step costs a fraction of a cent and needs agent auth configured in
# the deployment (setup wizard). CI must use --no-llm (or better: the
# deterministic tiers — this script is for LIVE deployments only).
#
# Usage:
#   bash scripts/smoke-e2e.sh [--no-llm] [--api URL] [--web URL] [--timeout SECONDS]
set -euo pipefail

API_URL="http://localhost:30400"
WEB_URL="http://localhost:30310"
RUN_LLM=1
TIMEOUT_SECS=420

while [ $# -gt 0 ]; do
  case "$1" in
    --no-llm) RUN_LLM=0 ;;
    --api) API_URL="$2"; shift ;;
    --web) WEB_URL="$2"; shift ;;
    --timeout) TIMEOUT_SECS="$2"; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

fail() {
  echo "❌ $1" >&2
  exit 1
}

json_get() { # json_get '<json>' '<python expr on obj d>'
  python3 -c "import json,sys; d=json.loads(sys.argv[1]); print(eval(sys.argv[2]))" "$1" "$2"
}

echo "=== Optio live smoke test ==="
echo "API: $API_URL"
echo "Web: $WEB_URL"

# 1. API health
HEALTH=$(curl -fsS -m 10 "$API_URL/api/health") || fail "API health endpoint unreachable at $API_URL/api/health"
HEALTHY=$(json_get "$HEALTH" "d['healthy']")
[ "$HEALTHY" = "True" ] || fail "API reports unhealthy: $HEALTH"
echo "✓ API healthy ($(json_get "$HEALTH" "d['checks']"))"

# 2. Web UI serves
WEB_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -m 10 "$WEB_URL/") || fail "Web UI unreachable at $WEB_URL"
case "$WEB_STATUS" in
  2*|3*) echo "✓ Web UI responding ($WEB_STATUS)" ;;
  *) fail "Web UI returned $WEB_STATUS" ;;
esac

# 3. Setup status (informational — LLM step depends on it)
SETUP=$(curl -fsS -m 10 "$API_URL/api/setup/status" || echo '{}')
echo "  setup status: $SETUP"

if [ "$RUN_LLM" != "1" ]; then
  echo "=== Smoke test passed (LLM run skipped) ==="
  exit 0
fi

# 4. Live agent run: tiny standalone Job through the real pod pipeline.
STAMP=$(date +%s)
JOB_NAME="smoke-e2e-$STAMP"
CREATE=$(curl -fsS -m 15 -X POST "$API_URL/api/jobs" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"$JOB_NAME\",\"promptTemplate\":\"Reply with exactly the single word: OK\",\"agentRuntime\":\"claude-code\",\"maxRetries\":0}") \
  || fail "Could not create smoke job"
JOB_ID=$(json_get "$CREATE" "d['workflow']['id']")
echo "✓ Created smoke job $JOB_ID"

cleanup() {
  # Cancel any in-flight run first so its pod isn't orphaned by the cascade
  # delete, then remove the throwaway job — but keep the rows if the run is
  # somehow still non-terminal so the idle/zombie cleanup can reap the pod.
  if [ -n "${RUN_ID:-}" ]; then
    curl -fsS -m 15 -X POST "$API_URL/api/workflow-runs/$RUN_ID/cancel" >/dev/null 2>&1 || true
    sleep 2
    FINAL=$(curl -fsS -m 10 "$API_URL/api/workflow-runs/$RUN_ID" 2>/dev/null || echo '{}')
    FINAL_STATE=$(json_get "$FINAL" "d.get('run',{}).get('state','?')" 2>/dev/null || echo "?")
    case "$FINAL_STATE" in
      completed|failed) ;;
      *)
        echo "⚠ smoke run $RUN_ID still '$FINAL_STATE' — leaving job $JOB_ID for pod cleanup" >&2
        return 0
        ;;
    esac
  fi
  curl -fsS -m 15 -X DELETE "$API_URL/api/jobs/$JOB_ID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

RUN=$(curl -fsS -m 15 -X POST "$API_URL/api/jobs/$JOB_ID/runs" -H 'content-type: application/json' -d '{}') \
  || fail "Could not start smoke run"
RUN_ID=$(json_get "$RUN" "d['run']['id']")
echo "✓ Started run $RUN_ID — waiting for the agent (pod spin-up + LLM call)..."

DEADLINE=$(( $(date +%s) + TIMEOUT_SECS ))
STATE="queued"
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  BODY=$(curl -fsS -m 10 "$API_URL/api/workflow-runs/$RUN_ID" || echo '{}')
  STATE=$(json_get "$BODY" "d.get('run',{}).get('state','?')" 2>/dev/null || echo "?")
  case "$STATE" in
    completed)
      COST=$(json_get "$BODY" "d['run'].get('costUsd')" 2>/dev/null || echo "?")
      echo "✓ Run completed (cost: \$${COST})"
      echo "=== Smoke test PASSED — live agent pipeline verified ==="
      exit 0
      ;;
    failed)
      ERR=$(json_get "$BODY" "d['run'].get('errorMessage')" 2>/dev/null || echo "?")
      echo "--- last run logs ---"
      curl -fsS -m 10 "$API_URL/api/workflow-runs/$RUN_ID/logs" | python3 -c "
import json,sys
logs = json.load(sys.stdin).get('logs', [])
for l in logs[-20:]:
    print(f\"[{l.get('logType')}] {l.get('content','')[:300]}\")
" 2>/dev/null || true
      fail "Smoke run failed: $ERR"
      ;;
  esac
  printf "  state: %-12s\r" "$STATE"
  sleep 5
done

fail "Smoke run did not finish within ${TIMEOUT_SECS}s (last state: $STATE)"
