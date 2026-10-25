#!/usr/bin/env bash
# The check stage of .gitlab-ci.yml, one check per call, as upstream's
# .github/workflows/ci.yml runs them (the iOS, Android and site jobs left out):
#
#   docs/examples/ci/check.sh format       pnpm format:check (prettier --check .)
#   docs/examples/ci/check.sh lint         pnpm lint (eslint .)
#   docs/examples/ci/check.sh typecheck    pnpm turbo typecheck, every package but the site
#   docs/examples/ci/check.sh migrations   scripts/check-migration-prefixes.sh, and new migrations
#                            stay additive (scripts/check-migrations.mjs)
#   docs/examples/ci/check.sh scripts      the release scripts' and the e2e harness's own tests
#                            (pnpm test:selfhost)
#   docs/examples/ci/check.sh openapi      the API's OpenAPI document: dump, redocly lint, types
#
# Runs in the build/ci-node image (node 22, pnpm, the offline store at
# /pnpm-offline/store); installs the workspace first (docs/examples/ci/lib.sh). The same on
# a laptop: OPTIO_SKIP_INSTALL=1 docs/examples/ci/check.sh typecheck.
set -euo pipefail

cd "$(dirname "$0")/../../.."
. docs/examples/ci/lib.sh

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }
what="${1:-}"
case "$what" in
  format | lint | typecheck | migrations | scripts | openapi) ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

optio_trust_ca
export TURBO_TELEMETRY_DISABLED=1 NEXT_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1

case "$what" in
  migrations)
    # Shell and node only; no packages needed.
    section "Migration prefixes"
    bash scripts/check-migration-prefixes.sh
    # what a release hasn't shipped yet drops, renames or deletes nothing
    # without a reviewed marker (docs/backup.md).
    section "Migrations stay additive"
    node scripts/check-migrations.mjs
    ;;
  scripts)
    # node only; no packages needed.
    section "Release scripts' and e2e harness's tests"
    pnpm test:selfhost
    ;;
  format)
    optio_pnpm_install
    section "prettier --check ."
    pnpm format:check
    ;;
  lint)
    optio_pnpm_install
    section "eslint ."
    pnpm lint
    ;;
  typecheck)
    optio_pnpm_install
    section "turbo typecheck"
    pnpm turbo typecheck
    ;;
  openapi)
    optio_pnpm_install
    section "OpenAPI: dump, lint, types"
    export REDOCLY_TELEMETRY=off REDOCLY_SUPPRESS_UPDATE_NOTICE=true
    pnpm --filter @optio/api openapi:dump
    pnpm --filter @optio/api openapi:lint
    pnpm --filter @optio/api openapi:types
    (cd apps/api && pnpm exec tsc --noEmit --target es2022 --module esnext --moduleResolution bundler openapi.generated.d.ts)
    ;;
esac
