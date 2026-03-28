#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Building Optio Agent Images ==="

# Base image (all others depend on this)
echo "[1/8] Building optio-base..."
docker build -t optio-base:latest -f "$SCRIPT_DIR/base.Dockerfile" "$ROOT_DIR"

# Language-specific images (can be built in parallel)
echo "[2/8] Building optio-node..."
docker build -t optio-node:latest -f "$SCRIPT_DIR/node.Dockerfile" "$ROOT_DIR" &

echo "[3/8] Building optio-python..."
docker build -t optio-python:latest -f "$SCRIPT_DIR/python.Dockerfile" "$ROOT_DIR" &

echo "[4/8] Building optio-go..."
docker build -t optio-go:latest -f "$SCRIPT_DIR/go.Dockerfile" "$ROOT_DIR" &

echo "[5/8] Building optio-rust..."
docker build -t optio-rust:latest -f "$SCRIPT_DIR/rust.Dockerfile" "$ROOT_DIR" &

echo "[6/8] Building optio-dind..."
docker build -t optio-dind:latest -f "$SCRIPT_DIR/dind.Dockerfile" "$ROOT_DIR" &

echo "[7/8] Building optio-optio (operations assistant)..."
docker build -t optio-optio:latest -f "$ROOT_DIR/Dockerfile.optio" "$ROOT_DIR" &

wait

echo "[8/8] Building optio-full..."
docker build -t optio-full:latest -f "$SCRIPT_DIR/full.Dockerfile" "$ROOT_DIR"

# Tag optio-base as the default
docker tag optio-base:latest optio-agent:latest

echo ""
echo "=== Images Built ==="
docker images --filter "reference=optio-*" --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}"
