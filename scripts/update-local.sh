#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

echo "=== Optio Local Update ==="
echo ""

# Pull latest code
echo "[1/4] Pulling latest code..."
git pull --rebase

# Install any new dependencies
echo "[2/4] Installing dependencies..."
pnpm install

# Rebuild images
echo "[3/4] Building images..."
docker build -t optio-api:latest -f Dockerfile.api . -q
docker build -t optio-web:latest -f Dockerfile.web . -q

# Check if any agent base image needs rebuilding
REBUILD_AGENTS=false
for preset in base node python go rust full; do
  if ! docker image inspect "optio-${preset}:latest" &>/dev/null; then
    REBUILD_AGENTS=true
    break
  fi
done

if [ "$REBUILD_AGENTS" = true ]; then
  echo "   Rebuilding agent images (new presets detected)..."
  docker build -t optio-base:latest -f images/base.Dockerfile . -q
  docker tag optio-base:latest optio-agent:latest
  docker build -t optio-node:latest -f images/node.Dockerfile . -q &
  docker build -t optio-python:latest -f images/python.Dockerfile . -q &
  docker build -t optio-go:latest -f images/go.Dockerfile . -q &
  docker build -t optio-rust:latest -f images/rust.Dockerfile . -q &
  wait
  docker build -t optio-full:latest -f images/full.Dockerfile . -q
fi

# Rebuild the Optio operations assistant image if missing
if ! docker image inspect "optio-optio:latest" &>/dev/null; then
  echo "   Rebuilding optio-optio (operations assistant)..."
  docker build -t optio-optio:latest -f Dockerfile.optio . -q
fi

echo "   Images built."

# Rolling restart
echo "[4/4] Restarting deployments..."
helm upgrade optio helm/optio -n optio --reuse-values
kubectl rollout restart deployment/optio-api deployment/optio-web deployment/optio-optio -n optio
kubectl rollout status deployment/optio-api -n optio --timeout=60s 2>/dev/null || true
kubectl rollout status deployment/optio-web -n optio --timeout=60s 2>/dev/null || true
kubectl rollout status deployment/optio-optio -n optio --timeout=60s 2>/dev/null || true

echo ""
echo "=== Update Complete ==="
echo ""
echo "  Web UI ...... http://localhost:30310"
echo "  API ......... http://localhost:30400"
