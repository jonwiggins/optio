#!/usr/bin/env bash
# Fails when apps/ios/Optio/Generated/SharedTypes.swift is out of date with
# packages/shared/src/types. Run `pnpm gen:swift` to refresh it.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm gen:swift >/dev/null
if ! git diff --quiet -- apps/ios/Optio/Generated/SharedTypes.swift; then
  echo "SharedTypes.swift is stale. Run 'pnpm gen:swift' and commit the result." >&2
  git --no-pager diff --stat -- apps/ios/Optio/Generated/SharedTypes.swift >&2
  exit 1
fi
echo "SharedTypes.swift is up to date."
