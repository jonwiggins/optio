#!/usr/bin/env bash
# Generate VAPID keys for Web Push notifications.
# Output: JSON with publicKey and privateKey fields.
#
# Usage:
#   ./scripts/generate-vapid-keys.sh
#   ./scripts/generate-vapid-keys.sh --env   # Output as env vars

set -euo pipefail

if ! command -v npx &>/dev/null; then
  echo "Error: npx is required. Install Node.js to continue." >&2
  exit 1
fi

if [[ "${1:-}" == "--env" ]]; then
  KEYS=$(npx --yes web-push generate-vapid-keys --json 2>/dev/null)
  PUBLIC=$(echo "$KEYS" | grep -o '"publicKey":"[^"]*"' | cut -d'"' -f4)
  PRIVATE=$(echo "$KEYS" | grep -o '"privateKey":"[^"]*"' | cut -d'"' -f4)
  echo "OPTIO_VAPID_PUBLIC_KEY=$PUBLIC"
  echo "OPTIO_VAPID_PRIVATE_KEY=$PRIVATE"
  echo "OPTIO_VAPID_SUBJECT=mailto:ops@example.com"
else
  npx --yes web-push generate-vapid-keys --json 2>/dev/null
fi
