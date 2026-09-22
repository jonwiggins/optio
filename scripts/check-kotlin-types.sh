#!/usr/bin/env bash
# Fails when apps/android/core/model/src/main/kotlin/dev/optio/core/model/SharedTypes.kt is out
# of date with packages/shared/src/types. Run `pnpm gen:kotlin` to refresh it.
set -euo pipefail
cd "$(dirname "$0")/.."
FILE=apps/android/core/model/src/main/kotlin/dev/optio/core/model/SharedTypes.kt
pnpm gen:kotlin >/dev/null
# `git status` (not `git diff`) so a missing or never-committed file counts as stale too.
if [ -n "$(git status --porcelain -- "$FILE")" ]; then
  echo "SharedTypes.kt is stale. Run 'pnpm gen:kotlin' and commit the result." >&2
  git --no-pager diff --stat -- "$FILE" >&2
  exit 1
fi
echo "SharedTypes.kt is up to date."
