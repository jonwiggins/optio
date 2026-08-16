#!/usr/bin/env bash
# Manage the throwaway Postgres + Redis containers used by the integration and
# e2e test tiers. The vitest globalSetup calls `start` automatically when the
# databases are unreachable, so you rarely need to run this by hand.
#
# Usage:  bash scripts/test-infra.sh start|stop|status
#
# Ports are non-standard on purpose so the test infra never collides with the
# Helm-deployed dev stack (5432/6379 inside the cluster) or a host Postgres.
set -euo pipefail

PG_CONTAINER=optio-test-postgres
REDIS_CONTAINER=optio-test-redis
PG_PORT="${OPTIO_TEST_PG_PORT:-54329}"
REDIS_PORT="${OPTIO_TEST_REDIS_PORT:-63790}"
PG_IMAGE="${OPTIO_TEST_PG_IMAGE:-postgres:16-alpine}"
REDIS_IMAGE="${OPTIO_TEST_REDIS_IMAGE:-redis:7-alpine}"

ensure_container() {
  local name="$1"
  shift
  local state
  # docker inspect may emit a blank stdout line for missing containers
  # (observed on Docker 29), so strip whitespace and treat empty as absent.
  state=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null | tr -d '[:space:]' || true)
  [ -n "$state" ] || state="absent"
  case "$state" in
    running) echo "   $name already running" ;;
    absent)
      # Tolerate losing a create race against a concurrent `start` by
      # falling back to starting the winner's container.
      docker run -d --name "$name" "$@" >/dev/null 2>&1 || docker start "$name" >/dev/null
      echo "   $name started"
      ;;
    *)
      docker start "$name" >/dev/null
      echo "   $name restarted (was $state)"
      ;;
  esac
}

start() {
  # Bind to loopback only — throwaway credentials, not for the network.
  ensure_container "$PG_CONTAINER" \
    -p "127.0.0.1:${PG_PORT}:5432" \
    -e POSTGRES_USER=optio_test \
    -e POSTGRES_PASSWORD=optio_test \
    -e POSTGRES_DB=postgres \
    "$PG_IMAGE"
  # Many logical databases so concurrent test runs get distinct indexes
  # (allocated round-robin via a Postgres sequence in the test global setup).
  ensure_container "$REDIS_CONTAINER" \
    -p "127.0.0.1:${REDIS_PORT}:6379" \
    "$REDIS_IMAGE" redis-server --databases 4096

  echo -n "   waiting for postgres"
  for _ in $(seq 1 60); do
    if docker exec "$PG_CONTAINER" pg_isready -U optio_test -d postgres >/dev/null 2>&1; then
      echo " — ready"
      return 0
    fi
    echo -n "."
    sleep 0.5
  done
  echo ""
  echo "❌ postgres did not become ready in 30s" >&2
  exit 1
}

stop() {
  docker rm -f "$PG_CONTAINER" "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  echo "   test infra stopped"
}

status() {
  for name in "$PG_CONTAINER" "$REDIS_CONTAINER"; do
    local_state=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo "absent")
    echo "   $name: $local_state"
  done
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *)
    echo "Usage: $0 start|stop|status" >&2
    exit 1
    ;;
esac
