#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Parse arguments
TAG="${1:-latest}"
PLATFORM=""

# Check for --platform flag in any position
i=0
next_is_platform=false
for arg in "$@"; do
  i=$((i + 1))
  if [[ "$next_is_platform" == true ]]; then
    PLATFORM="$arg"
    next_is_platform=false
  elif [[ "$arg" == --platform=* ]]; then
    PLATFORM="${arg#*=}"
  elif [[ "$arg" == "--platform" ]]; then
    next_is_platform=true
  fi
done

# Build platform flag if specified
PLATFORM_FLAG=""
if [ -n "${PLATFORM}" ]; then
  PLATFORM_FLAG="--platform ${PLATFORM}"
  echo "Building for platform: ${PLATFORM}"
fi

echo "=== Building Optio Agent Images ==="
echo "Tag: ${TAG}"

# Base image (all others depend on this)
echo "[1/8] Building optio-base..."
docker build ${PLATFORM_FLAG} -t "optio-base:${TAG}" -f "${SCRIPT_DIR}/base.Dockerfile" "${ROOT_DIR}"

echo "Using base internal image: optio-base:${TAG}"
BASE_IMAGE="optio-base:${TAG}"

# Language-specific images (can be built in parallel)
echo "[2/8] Building optio-node..."
docker build ${PLATFORM_FLAG} -t "optio-node:${TAG}" --build-arg BASE_IMAGE="${BASE_IMAGE}" -f "${SCRIPT_DIR}/node.Dockerfile" "${ROOT_DIR}" &

echo "[3/8] Building optio-python..."
docker build ${PLATFORM_FLAG} -t "optio-python:${TAG}" --build-arg BASE_IMAGE="${BASE_IMAGE}" -f "${SCRIPT_DIR}/python.Dockerfile" "${ROOT_DIR}" &

echo "[4/8] Building optio-go..."
docker build ${PLATFORM_FLAG} -t "optio-go:${TAG}" --build-arg BASE_IMAGE="${BASE_IMAGE}" -f "${SCRIPT_DIR}/go.Dockerfile" "${ROOT_DIR}" &

echo "[5/8] Building optio-rust..."
docker build ${PLATFORM_FLAG} -t "optio-rust:${TAG}" --build-arg BASE_IMAGE="${BASE_IMAGE}" -f "${SCRIPT_DIR}/rust.Dockerfile" "${ROOT_DIR}" &

echo "[6/8] Building optio-dind..."
docker build ${PLATFORM_FLAG} -t "optio-dind:${TAG}" -f "${SCRIPT_DIR}/dind.Dockerfile" "${ROOT_DIR}" &

echo "[7/8] Building optio-optio (operations assistant)..."
docker build ${PLATFORM_FLAG} -t "optio-optio:${TAG}" -f "${ROOT_DIR}/Dockerfile.optio" "${ROOT_DIR}" &

wait

echo "[8/8] Building optio-full..."
docker build ${PLATFORM_FLAG} -t "optio-full:${TAG}" --build-arg BASE_IMAGE="${BASE_IMAGE}" -f "${SCRIPT_DIR}/full.Dockerfile" "${ROOT_DIR}"

# Tag optio-base as the default
docker tag "optio-base:${TAG}" "optio-agent:${TAG}"

echo ""
echo "=== Images Built ==="
docker images --filter "reference=optio-*" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"
