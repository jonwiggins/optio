#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

QUICK=false
SKIP_PULL=false

usage() {
  echo "Usage: update-local.sh [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --quick, -q    Skip agent image rebuilds (api + web only)"
  echo "  --no-pull       Skip git pull"
  echo "  --help, -h     Show this help"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick|-q) QUICK=true; shift ;;
    --no-pull) SKIP_PULL=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

echo "=== Optio Local Update ==="
echo ""

# Pull latest code
if [ "$SKIP_PULL" = false ]; then
  echo "[1/4] Pulling latest code..."
  git pull --rebase
else
  echo "[1/4] Skipping git pull"
fi

# Install any new dependencies
echo "[2/4] Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# Build images
echo "[3/4] Building images..."

# API and Web always build in parallel
docker build -t optio-api:latest -f Dockerfile.api . -q &
API_PID=$!
docker build -t optio-web:latest -f Dockerfile.web . -q &
WEB_PID=$!

if [ "$QUICK" = false ]; then
  # Check if any agent image needs rebuilding
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

  # Rebuild optio-optio if missing
  if ! docker image inspect "optio-optio:latest" &>/dev/null; then
    echo "   Rebuilding optio-optio (operations assistant)..."
    docker build -t optio-optio:latest -f Dockerfile.optio . -q
  fi
fi

# Wait for API and Web builds
wait $API_PID || { echo "API image build failed"; exit 1; }
wait $WEB_PID || { echo "Web image build failed"; exit 1; }
echo "   Images built."

# Rolling restart
echo "[4/4] Restarting deployments..."
helm upgrade optio helm/optio -n optio -f helm/optio/values.local.yaml --reuse-values

DEPLOYMENTS="deployment/optio-api deployment/optio-web"
if kubectl get deployment optio-optio -n optio &>/dev/null; then
  DEPLOYMENTS="$DEPLOYMENTS deployment/optio-optio"
fi
kubectl rollout restart $DEPLOYMENTS -n optio

for dep in $DEPLOYMENTS; do
  kubectl rollout status "$dep" -n optio --timeout=90s 2>/dev/null || true
done

# Verify health
if curl -sf http://localhost:30400/api/health >/dev/null 2>&1; then
  HEALTH="healthy"
else
  HEALTH="not responding (may still be starting)"
fi

echo ""
echo "=== Update Complete ==="
echo ""
echo "  Web UI ...... http://localhost:30310"
echo "  API ......... http://localhost:30400"
echo "  API health .. $HEALTH"
if [ "$QUICK" = true ]; then
  echo ""
  echo "  (--quick mode: agent images were not rebuilt)"
fi
