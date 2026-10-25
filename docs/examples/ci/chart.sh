#!/usr/bin/env bash
# Render optional monitoring and backup resources without a cluster.
set -euo pipefail
cd "$(dirname "$0")/../../.."
helm lint helm/optio
helm template optio helm/optio --kube-version 1.33.0 \
  --set publicUrl=https://optio.example.com \
  --set encryption.key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --set postgresql.auth.password=render-only \
  --set metrics.enabled=true --set metrics.networkPolicy.namespaces[0]=monitoring \
  --set backup.enabled=true >/dev/null
