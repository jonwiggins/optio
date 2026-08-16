#!/bin/bash
# Refresh the CLAUDE_CODE_OAUTH_TOKEN secret in the local Optio cluster.
# Intended for Claude Code Max subscribers whose token has expired.
#
# Primary path (macOS): extract the OAuth token from the "Claude Code-credentials"
# Keychain entry that `claude login` populates, then POST it to the local API.
# This is the same mechanism the UI's token-refresh banner recommends, minus the
# pbcopy/paste step — we pipe the token straight into /api/secrets.
#
# Fallback (Linux / macOS without Keychain entry): prompt for a token pasted
# from `claude setup-token` output.
#
# Usage:
#   scripts/update-claude-auth.sh           # refresh the token
#   scripts/update-claude-auth.sh --check   # just report whether the stored
#                                           # token is still valid (exit 1 if
#                                           # missing/revoked); changes nothing

set -euo pipefail

API_URL="${OPTIO_API_URL:-http://localhost:30400}"

# Sanity check: API reachable before we start extracting secrets.
if ! curl -fsS "$API_URL/api/health" >/dev/null 2>&1; then
  echo "error: Optio API not reachable at $API_URL" >&2
  echo "       Start the local cluster with ./scripts/setup-local.sh or ./scripts/update-local.sh first." >&2
  echo "       Or override the URL with OPTIO_API_URL=... $0" >&2
  exit 1
fi

# ── --check: validate the stored token without touching it ─────────────────
# GET /api/auth/status probes the Anthropic API, so this catches revoked
# tokens (agents failing with 401 "OAuth access token has been revoked" /
# repeated [api_retry] authentication_failed), not just missing ones.
if [[ "${1:-}" == "--check" ]]; then
  STATUS_JSON="$(curl -fsS "$API_URL/api/auth/status")"
  echo "$STATUS_JSON"
  OK="$(printf '%s' "$STATUS_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin).get('subscription', {})
print('ok' if d.get('available') and not d.get('expired') else 'bad')
")"
  if [[ "$OK" == "ok" ]]; then
    echo "=== Stored Claude token is valid. ==="
    exit 0
  fi
  echo "=== Stored Claude token is missing, expired, or revoked — run $0 to refresh. ===" >&2
  exit 1
fi

echo "=== Optio — refresh Claude Code OAuth token ==="
echo ""

# ── Obtain token ────────────────────────────────────────────────────────────

TOKEN=""
SOURCE=""

# Path 1: macOS Keychain. Matches the UI banner's oneliner exactly.
if [[ "$(uname)" == "Darwin" ]] && command -v security >/dev/null 2>&1; then
  echo "Attempting to extract token from macOS Keychain entry \"Claude Code-credentials\"..."
  if KEYCHAIN_JSON="$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)"; then
    if EXTRACTED="$(printf '%s' "$KEYCHAIN_JSON" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    tok = d.get('claudeAiOauth', {}).get('accessToken')
    if tok:
        print(tok, end='')
except Exception:
    pass
" 2>/dev/null)" && [ -n "$EXTRACTED" ]; then
      TOKEN="$EXTRACTED"
      SOURCE="keychain"
      echo "  Found token in Keychain."
    else
      echo "  Keychain entry exists but has no claudeAiOauth.accessToken — falling back to manual paste." >&2
    fi
  else
    echo "  No \"Claude Code-credentials\" Keychain entry found (run 'claude login' first, or paste a token manually)." >&2
  fi
fi

# Path 2: manual paste (any platform).
if [ -z "$TOKEN" ]; then
  cat <<'INSTRUCTIONS'

Manual token entry.

  In a separate terminal, run:

      claude setup-token

  Sign in, approve OAuth, copy the printed token (starts with sk-ant-oat01-).

INSTRUCTIONS
  printf "Paste the token and press Enter: "
  read -r -s TOKEN
  echo ""
  # Strip accidental quotes/whitespace.
  TOKEN="${TOKEN#\"}"; TOKEN="${TOKEN%\"}"
  TOKEN="${TOKEN#\'}"; TOKEN="${TOKEN%\'}"
  TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
  SOURCE="paste"
fi

if [ -z "$TOKEN" ]; then
  echo "error: no token provided." >&2
  exit 1
fi

# ── Submit ──────────────────────────────────────────────────────────────────

echo "Submitting token to $API_URL/api/secrets (source: $SOURCE) ..."

# Build the JSON payload via python to avoid any shell-quoting mishap on the token.
PAYLOAD_FILE="$(mktemp)"
trap 'rm -f "$PAYLOAD_FILE"' EXIT
TOKEN="$TOKEN" python3 -c "
import json, os, sys
json.dump({'name': 'CLAUDE_CODE_OAUTH_TOKEN', 'value': os.environ['TOKEN']}, sys.stdout)
" >"$PAYLOAD_FILE"

RESPONSE="$(curl -sS -X POST "$API_URL/api/secrets" \
  -H "Content-Type: application/json" \
  --data-binary "@$PAYLOAD_FILE" \
  -w "\n__HTTP_STATUS__%{http_code}")"

BODY="${RESPONSE%$'\n'__HTTP_STATUS__*}"
STATUS="${RESPONSE##*__HTTP_STATUS__}"

if [ "$STATUS" != "200" ] && [ "$STATUS" != "201" ]; then
  echo "error: API returned HTTP $STATUS" >&2
  echo "$BODY" >&2
  exit 1
fi

# Read validation result; fall back to python if jq isn't installed.
if command -v jq >/dev/null 2>&1; then
  VALID="$(printf '%s' "$BODY" | jq -r '.validation.valid // empty')"
  VERROR="$(printf '%s' "$BODY" | jq -r '.validation.error // empty')"
else
  VALID="$(printf '%s' "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('validation',{}).get('valid',''))")"
  VERROR="$(printf '%s' "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('validation',{}).get('error',''))")"
fi

echo ""
if [ "$VALID" = "True" ] || [ "$VALID" = "true" ]; then
  echo "=== Claude OAuth token updated — validated against Anthropic. ==="
elif [ "$VALID" = "False" ] || [ "$VALID" = "false" ]; then
  echo "Token stored, but validation failed: ${VERROR:-unknown}" >&2
  echo "The token may be expired. Try running 'claude login' to refresh the Keychain entry, then re-run this script." >&2
  exit 1
else
  echo "=== Claude OAuth token updated (server did not return validation status). ==="
fi

echo ""
echo "Tasks that failed with an auth error can now be retried from the UI."
