#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

echo "=== Optio Local Setup ==="
echo ""

# Check prerequisites
command -v kubectl >/dev/null 2>&1 || { echo "❌ kubectl is required. Enable Kubernetes in Docker Desktop."; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "❌ pnpm is required. Install with: npm install -g pnpm"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "❌ docker is required. Install Docker Desktop."; exit 1; }
command -v helm >/dev/null 2>&1 || { echo "❌ helm is required. Install with: brew install helm"; exit 1; }

# Check cluster connectivity
if ! kubectl cluster-info >/dev/null 2>&1; then
  echo "❌ No Kubernetes cluster found."
  echo "   Enable Kubernetes in Docker Desktop: Settings → Kubernetes → Enable"
  exit 1
fi

echo "[1/6] Installing dependencies..."
pnpm install

echo "[2/6] Building agent images..."
echo "   Building optio-base (required)..."
docker build -t optio-base:latest -f images/base.Dockerfile . -q
docker tag optio-base:latest optio-agent:latest
echo "   Building optio-node..."
docker build -t optio-node:latest -f images/node.Dockerfile . -q &
echo "   Building optio-python..."
docker build -t optio-python:latest -f images/python.Dockerfile . -q &
echo "   Building optio-go..."
docker build -t optio-go:latest -f images/go.Dockerfile . -q &
echo "   Building optio-rust..."
docker build -t optio-rust:latest -f images/rust.Dockerfile . -q &
wait
echo "   Building optio-full..."
docker build -t optio-full:latest -f images/full.Dockerfile . -q
echo "   All agent images built."

echo "   Building optio-optio (operations assistant)..."
docker build -t optio-optio:latest -f Dockerfile.optio . -q

echo "[3/6] Building API and Web images..."
docker build -t optio-api:latest -f Dockerfile.api . -q
docker build -t optio-web:latest -f Dockerfile.web . -q
echo "   API and Web images built."

echo "[4/6] Installing metrics-server..."
if kubectl get deployment metrics-server -n kube-system &>/dev/null; then
  echo "   metrics-server already installed, skipping"
else
  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml 2>/dev/null || {
    echo "   ⚠ Failed to install metrics-server (resource utilization will show N/A)"
  }
  # Docker Desktop / kind / minikube need --kubelet-insecure-tls
  kubectl patch deployment metrics-server -n kube-system --type=json \
    -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' 2>/dev/null || true
  echo "   metrics-server installed (may take a minute to become ready)"
fi

echo "[5/6] Deploying Optio to Kubernetes via Helm..."
ENCRYPTION_KEY=$(openssl rand -hex 32)

if helm status optio -n optio &>/dev/null; then
  echo "   Existing release found, upgrading..."
  helm upgrade optio helm/optio -n optio \
    --set encryption.key="$ENCRYPTION_KEY" \
    --set api.image.pullPolicy=Never \
    --set web.image.pullPolicy=Never \
    --set agent.image.repository=optio-base \
    --set agent.image.tag=latest \
    --set agent.imagePullPolicy=Never \
    --set optio.image.pullPolicy=Never \
    --set auth.disabled=true \
    --set api.service.type=NodePort \
    --set api.service.nodePort=30400 \
    --set web.service.type=NodePort \
    --set web.service.nodePort=30310 \
    --set postgresql.auth.password=optio_dev \
    --wait --timeout=120s
else
  helm install optio helm/optio -n optio --create-namespace \
    --set encryption.key="$ENCRYPTION_KEY" \
    --set api.image.pullPolicy=Never \
    --set web.image.pullPolicy=Never \
    --set agent.image.repository=optio-base \
    --set agent.image.tag=latest \
    --set agent.imagePullPolicy=Never \
    --set optio.image.pullPolicy=Never \
    --set auth.disabled=true \
    --set api.service.type=NodePort \
    --set api.service.nodePort=30400 \
    --set web.service.type=NodePort \
    --set web.service.nodePort=30310 \
    --set postgresql.auth.password=optio_dev \
    --wait --timeout=120s
fi
echo "   Helm deployment complete."

echo "[6/6] Verifying deployment..."
kubectl wait --namespace optio --for=condition=available deployment/optio-api --timeout=60s 2>/dev/null || true
kubectl wait --namespace optio --for=condition=available deployment/optio-web --timeout=60s 2>/dev/null || true
kubectl wait --namespace optio --for=condition=available deployment/optio-optio --timeout=60s 2>/dev/null || true

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Services:"
echo "  Web UI ...... http://localhost:30310"
echo "  API ......... http://localhost:30400"
echo "  Postgres .... optio-postgres:5432 (K8s internal)"
echo "  Redis ....... optio-redis:6379 (K8s internal)"
echo ""
echo "Agent images:"
docker images --filter "reference=optio-*" --format "  {{.Repository}}:{{.Tag}}" 2>/dev/null || true
echo ""
echo "Next steps:"
echo ""
echo "  1. Open the setup wizard:"
echo "     http://localhost:30310/setup"
echo ""
echo "  2. After rebuilding images, redeploy with:"
echo "     docker build -t optio-api:latest -f Dockerfile.api ."
echo "     docker build -t optio-web:latest -f Dockerfile.web ."
echo "     kubectl rollout restart deployment/optio-api deployment/optio-web -n optio"
echo ""
echo "To tear down:"
echo "  helm uninstall optio -n optio"
