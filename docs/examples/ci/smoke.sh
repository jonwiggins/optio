#!/usr/bin/env bash
# Smoke test of a deployed environment: what a browser and a first sign-in hit.
#
#   docs/examples/ci/smoke.sh [<url>] [--profile <expected>] [--providers oidc,ldap] [--timeout 300]
#
#   1. GET /api/health            200 and "healthy":true (the API reaches its database)
#   2. GET /api/auth/providers    200, the expected profile, and each provider in
#                                 --providers among the sign-in providers
#   3. GET /api/setup/status      200 with isSetUp (what the setup wizard reads)
#   4. GET /                      the web UI answers (200, or a redirect)
#   5. GET /api/internal/…        refused at the ingress (anything but 2xx)
#
# <url>: the environment's publicUrl; default $DYNAMIC_ENVIRONMENT_URL (the
# deploy job's dotenv report), then $OPTIO_URL. --providers defaults to
# $OPTIO_SMOKE_PROVIDERS_<ENV> (the job's environment, $CI_ENVIRONMENT_NAME, in
# capitals: OPTIO_SMOKE_PROVIDERS_STAGING), then $OPTIO_SMOKE_PROVIDERS; empty =
# don't check which providers are on (a new environment has none until the
# setup wizard's Sign-in step). --profile defaults to $OPTIO_SMOKE_PROFILE, then
# no profile check. --timeout is how long /api/health may take to turn healthy.
# Trusts OPTIO_CA_FILE (docs/examples/ci/lib.sh).
set -euo pipefail

cd "$(dirname "$0")/../../.."
. docs/examples/ci/lib.sh

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }
URL=""
PROFILE="${OPTIO_SMOKE_PROFILE:-}"
ENV_SUFFIX="$(printf '%s' "${CI_ENVIRONMENT_NAME:-}" | tr '[:lower:]-' '[:upper:]_' | tr -c 'A-Z0-9_' '_')"
per_env="OPTIO_SMOKE_PROVIDERS_${ENV_SUFFIX:-NONE}"
PROVIDERS="${!per_env:-${OPTIO_SMOKE_PROVIDERS:-}}"
TIMEOUT=300
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?}"; shift ;;
    --providers) PROVIDERS="${2-}"; shift ;;
    --timeout) TIMEOUT="${2:?}"; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *) URL="$1" ;;
  esac
  shift
done
URL="${URL:-${DYNAMIC_ENVIRONMENT_URL:-${OPTIO_URL:-}}}"
[ -n "$URL" ] || { echo "No URL: pass one, or set DYNAMIC_ENVIRONMENT_URL / OPTIO_URL" >&2; exit 2; }
URL="${URL%/}"
optio_trust_ca

FAILED=0
pass() { echo "ok    $*"; }
fail() { echo "FAIL  $*" >&2; FAILED=1; }
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT
# get <path>: the HTTP status; the body in $BODY
get() { curl -sS -o "$BODY" -w '%{http_code}' --max-time 20 "$URL$1" 2>/dev/null || echo 000; }
# field <name>: a top-level JSON scalar of $BODY (no jq needed)
field() { tr -d '\n' <"$BODY" | sed -n "s/.*\"$1\" *: *\(\"[^\"]*\"\|[a-z0-9]*\).*/\1/p" | tr -d '"'; }

section "Smoke test of $URL (profile $PROFILE)"

# 1. Health, waiting for a rollout that is still starting
deadline=$((SECONDS + TIMEOUT))
while :; do
  status="$(get /api/health)"
  if [ "$status" = 200 ] && [ "$(field healthy)" = true ]; then break; fi
  if [ "$SECONDS" -ge "$deadline" ]; then break; fi
  sleep 5
done
if [ "$status" = 200 ] && [ "$(field healthy)" = true ]; then
  pass "/api/health healthy"
else
  fail "/api/health: HTTP $status $(head -c 300 "$BODY")"
  echo "The API is not healthy; the remaining checks would fail too." >&2
  exit 1
fi

# 2. Sign-in providers and the profile
status="$(get /api/auth/providers)"
if [ "$status" = 200 ]; then
  pass "/api/auth/providers answers"
  got_profile="$(field profile)"
  if [ -n "$PROFILE" ]; then
    if [ "$got_profile" = "$PROFILE" ]; then pass "profile $got_profile"; else fail "profile: got '$got_profile', want '$PROFILE'"; fi
  fi
  names="$(tr -d '\n' <"$BODY" | grep -o '"name" *: *"[^"]*"' | sed 's/"name" *: *"//; s/"$//' | sort -u | tr '\n' ' ')"
  echo "      sign-in providers: ${names:-none} (setupRequired: $(field setupRequired))"
  for want in ${PROVIDERS//,/ }; do
    case " $names " in
      *" $want "*) pass "sign-in provider $want is on" ;;
      *) fail "sign-in provider $want is not on (have: ${names:-none})" ;;
    esac
  done
else
  fail "/api/auth/providers: HTTP $status"
fi

# 3. Setup status
status="$(get /api/setup/status)"
if [ "$status" = 200 ] && grep -q '"isSetUp"' "$BODY"; then
  pass "/api/setup/status (isSetUp: $(field isSetUp))"
else
  fail "/api/setup/status: HTTP $status $(head -c 300 "$BODY")"
fi

# 4. The web UI
status="$(get /)"
case "$status" in
  200 | 30[1278]) pass "web UI answers (HTTP $status)" ;;
  *) fail "web UI: HTTP $status" ;;
esac

# 5. Pod-only endpoints stay off the ingress
status="$(get /api/internal/git-credentials)"
case "$status" in
  2??) fail "/api/internal/git-credentials is reachable from outside (HTTP $status)" ;;
  000) fail "/api/internal/git-credentials: no answer" ;;
  *) pass "/api/internal/* refused (HTTP $status)" ;;
esac

if [ "$FAILED" = 0 ]; then echo "Smoke test passed."; else exit 1; fi
