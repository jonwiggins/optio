#!/usr/bin/env bash
# The test stage of .gitlab-ci.yml:
#
#   docs/examples/ci/test.sh unit [<package>...]     turbo test (every package but
#                                      container-runtime and the site, or the
#                                      packages named, e.g. @optio/shared) and
#                                      the push gate's own test
#   docs/examples/ci/test.sh integration [args...]   the API's *.int.test.ts against Postgres + Redis
#   docs/examples/ci/test.sh e2e [args...]           the API's e2e/ (a real API server, fake pods)
#
# integration and e2e take the databases from the job's services, never from
# Docker (OPTIO_TEST_NO_DOCKER=1):
#   OPTIO_TEST_PG_URL      postgres://optio_test:optio_test@postgres:5432/postgres
#   OPTIO_TEST_REDIS_URL   redis://redis:6379 (redis-server --databases 4096)
# The Redis Cluster tests skip themselves without OPTIO_TEST_REDIS_CLUSTER_URL.
# Extra arguments go to vitest (e.g. a file, or --maxWorkers 4).
# OPTIO_TURBO_CONCURRENCY: how many packages' unit tests run at once (default
# 2; each package's vitest uses every CPU the job has).
# OPTIO_TEST_TIMEOUT: a unit test's time limit in ms (default 20000; vitest's
# own 5 s is too tight on a runner that shares its node).
set -euo pipefail

cd "$(dirname "$0")/../../.."
. docs/examples/ci/lib.sh

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }
what="${1:-}"
case "$what" in
  unit | integration | e2e) shift ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

optio_trust_ca
export TURBO_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
optio_pnpm_install

# wait_for_postgres <url>: the service container accepts TCP before Postgres
# accepts logins, and the vitest global setup checks only once.
wait_for_postgres() {
  local url="$1"
  section "Waiting for Postgres (${url%%@*}@…)"
  (cd apps/api && PG_URL="$url" node --input-type=module -e '
    const { default: postgres } = await import("postgres");
    for (let i = 0; i < 90; i++) {
      const sql = postgres(process.env.PG_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
      try {
        await sql`SELECT 1`;
        await sql.end({ timeout: 1 });
        console.log("ready");
        process.exit(0);
      } catch (err) {
        await sql.end({ timeout: 1 }).catch(() => {});
        if (i % 10 === 0) console.log(`not yet: ${err.code ?? err.message}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    console.error("Postgres did not accept a login in 90s");
    process.exit(1);')
}

databases() {
  : "${OPTIO_TEST_PG_URL:?set OPTIO_TEST_PG_URL (the postgres service)}"
  : "${OPTIO_TEST_REDIS_URL:?set OPTIO_TEST_REDIS_URL (the redis service)}"
  export OPTIO_TEST_NO_DOCKER=1
  wait_for_postgres "$OPTIO_TEST_PG_URL"
}

case "$what" in
  unit)
    filters=(--filter='!@optio/container-runtime' --filter='!@optio/site')
    if [ $# -gt 0 ]; then filters=(); for pkg in "$@"; do filters+=(--filter="$pkg"); done; fi
    section "turbo test ${filters[*]}"
    pnpm turbo test "${filters[@]}" --concurrency="${OPTIO_TURBO_CONCURRENCY:-2}" \
      -- --testTimeout="${OPTIO_TEST_TIMEOUT:-20000}"
    section "push gate (scripts/check-push.test.mjs)"
    node --test scripts/check-push.test.mjs
    ;;
  integration)
    databases
    section "API integration tests"
    pnpm --filter @optio/api test:integration "$@"
    ;;
  e2e)
    databases
    section "API e2e tests (fake runtime)"
    pnpm --filter @optio/api test:e2e "$@"
    ;;
esac
