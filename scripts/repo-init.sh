#!/bin/bash
set -euo pipefail

echo "[optio] Initializing repo pod"
echo "[optio] Repo: ${OPTIO_REPO_URL} (branch: ${OPTIO_REPO_BRANCH})"

# Configure git
git config --global user.name "Optio Agent"
git config --global user.email "optio-agent@noreply.github.com"

# Set up GitHub credentials
if [ -n "${OPTIO_GIT_CREDENTIAL_URL:-}" ]; then
  # Dynamic credential helper — always-fresh tokens from Optio API
  git config --global credential.helper '/usr/local/bin/optio-git-credential'
  echo "[optio] Dynamic git credential helper configured"

  # Set up gh CLI wrapper for dynamic token refresh
  if [ -f /usr/bin/gh ] && [ -f /usr/local/bin/optio-gh-wrapper ]; then
    mv /usr/bin/gh /usr/bin/gh-real
    ln -s /usr/local/bin/optio-gh-wrapper /usr/bin/gh
    echo "[optio] gh CLI wrapper configured"
  fi

  # Verify connectivity
  if curl -sf "${OPTIO_GIT_CREDENTIAL_URL}" > /dev/null 2>&1; then
    echo "[optio] Credential service reachable"
  else
    echo "[optio] WARNING: Credential service not reachable at ${OPTIO_GIT_CREDENTIAL_URL}"
  fi
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  # Fallback: static PAT (existing behavior)
  git config --global credential.helper store
  echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > ~/.git-credentials
  chmod 600 ~/.git-credentials
  echo "[optio] Git credentials configured (static token)"

  echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true
  echo "[optio] GitHub CLI configured"
fi

# Install extra packages if requested (comma or space separated)
if [ -n "${OPTIO_EXTRA_PACKAGES:-}" ]; then
  PACKAGES=$(echo "${OPTIO_EXTRA_PACKAGES}" | tr ',' ' ')
  echo "[optio] Installing packages: ${PACKAGES}"
  sudo apt-get update -qq 2>/dev/null && sudo apt-get install -y -qq ${PACKAGES} 2>&1 | tail -3 || echo "[optio] Warning: package install failed"
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

# Run custom setup commands from Optio repo settings
if [ -n "${OPTIO_SETUP_COMMANDS:-}" ]; then
  echo "[optio] Running setup commands..."
  cd /workspace/repo
  eval "${OPTIO_SETUP_COMMANDS}"
  echo "[optio] Setup commands complete"
fi

# Signal that the pod is ready for tasks
touch /workspace/.ready
echo "[optio] Repo pod ready — waiting for tasks"

# Keep the pod alive
exec sleep infinity
