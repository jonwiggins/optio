#!/bin/bash
set -euo pipefail

echo "[optio] Initializing repo pod"
echo "[optio] Repo: ${OPTIO_REPO_URL} (branch: ${OPTIO_REPO_BRANCH})"

# Configure git
git config --global user.name "Optio Agent"
git config --global user.email "optio-agent@noreply.github.com"

# Set up git credential helper to use GITHUB_TOKEN for all github.com requests
if [ -n "${GITHUB_TOKEN:-}" ]; then
  git config --global credential.helper store
  echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > ~/.git-credentials
  chmod 600 ~/.git-credentials
  echo "[optio] Git credentials configured"

  # Also set up gh CLI (suppress interactive output)
  echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true
  echo "[optio] GitHub CLI configured"
fi

# Clone repo
cd /workspace
echo "[optio] Cloning..."
git clone --branch "${OPTIO_REPO_BRANCH}" "${OPTIO_REPO_URL}" repo 2>&1
echo "[optio] Repo cloned"

# Create tasks directory for worktrees
mkdir -p /workspace/tasks

# Run repo-level setup if present (.optio/setup.sh)
if [ -f /workspace/repo/.optio/setup.sh ]; then
  echo "[optio] Running repo setup script (.optio/setup.sh)..."
  chmod +x /workspace/repo/.optio/setup.sh
  cd /workspace/repo && ./.optio/setup.sh
  echo "[optio] Repo setup complete"
fi

# Signal that the pod is ready for tasks
touch /workspace/.ready
echo "[optio] Repo pod ready — waiting for tasks"

# Keep the pod alive
exec sleep infinity
