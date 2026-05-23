#!/bin/bash
set -euo pipefail

echo "[optio] Initializing repo pod"
echo "[optio] Repo: ${OPTIO_REPO_URL} (branch: ${OPTIO_REPO_BRANCH})"

# Configure git author for initial clone (overridden per-worktree at task exec time)
git config --global user.name "${GIT_BOT_NAME:-${GITHUB_APP_BOT_NAME:-Optio Agent}}"
git config --global user.email "${GIT_BOT_EMAIL:-${GITHUB_APP_BOT_EMAIL:-optio-agent@noreply.github.com}}"

# Detect git platform from repo URL
OPTIO_GIT_HOST=""
case "${OPTIO_REPO_URL}" in
  *git-codecommit.*.amazonaws.com*) OPTIO_GIT_HOST="codecommit" ;;
  *gitlab*) OPTIO_GIT_HOST="gitlab" ;;
  *github*) OPTIO_GIT_HOST="github" ;;
  *)        OPTIO_GIT_HOST="github" ;; # default
esac
echo "[optio] Detected git platform: ${OPTIO_GIT_HOST}"

# Set up git credentials for initial clone.
# Priority: Envoy secret proxy > dynamic credential helper > static PAT fallback.
# Dynamic credential helpers are re-configured per-task at exec time by the API server.
if [ "${OPTIO_SECRET_PROXY:-}" = "true" ]; then
  echo "[optio] Secret proxy mode — configuring CA trust and proxy settings"

  # Update CA certificates if the Envoy CA cert has been mounted
  if [ -f /usr/local/share/ca-certificates/optio-envoy-ca.crt ]; then
    update-ca-certificates 2>/dev/null || true
    # Also set NODE_EXTRA_CA_CERTS for Node.js tools (gh, claude)
    export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/optio-envoy-ca.crt
    echo "export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/optio-envoy-ca.crt" >> ~/.bashrc
    echo "[optio] CA certificate trusted"
  fi

  # Configure git to use the proxy for HTTPS operations
  git config --global http.proxy "${HTTP_PROXY:-http://127.0.0.1:10080}"
  git config --global https.proxy "${HTTPS_PROXY:-http://127.0.0.1:10080}"
  echo "[optio] Git proxy configured"
  echo "[optio] Secret proxy configured — credentials are injected by the Envoy sidecar"

elif [ -n "${OPTIO_GIT_CREDENTIAL_URL:-}" ] && [ -f /usr/local/bin/optio-git-credential ]; then
  # Dynamic credential helper — fetches token from Optio API
  git config --global credential.helper '/usr/local/bin/optio-git-credential'
  echo "[optio] Dynamic git credential helper configured"
  # Authenticate glab CLI if GitLab token is available
  if [ -n "${GITLAB_TOKEN:-}" ] && command -v glab >/dev/null 2>&1; then
    GITLAB_HOST="gitlab.com"
    case "${OPTIO_REPO_URL}" in
      *://*) GITLAB_HOST=$(echo "${OPTIO_REPO_URL}" | sed -E 's|.*://([^/]+).*|\1|') ;;
    esac
    glab auth login --hostname "${GITLAB_HOST}" --token "${GITLAB_TOKEN}" 2>/dev/null || true
    echo "[optio] GitLab CLI authenticated (host: ${GITLAB_HOST})"
  fi

elif [ "${OPTIO_GIT_HOST}" = "codecommit" ] && command -v aws >/dev/null 2>&1; then
  # CodeCommit uses AWS SigV4 — wire git's credential helper to the AWS CLI helper.
  # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN / AWS_REGION are
  # injected by the API server when launching the pod (or come from instance profile / IRSA).
  git config --global credential.helper '!aws codecommit credential-helper $@'
  git config --global credential.UseHttpPath true
  if [ -z "${AWS_DEFAULT_REGION:-}" ] && [ -n "${AWS_REGION:-}" ]; then
    export AWS_DEFAULT_REGION="${AWS_REGION}"
  fi
  echo "[optio] CodeCommit credential helper configured (region: ${AWS_DEFAULT_REGION:-${AWS_REGION:-unset}})"

elif [ -n "${GITHUB_TOKEN:-}" ] || [ -n "${GITLAB_TOKEN:-}" ]; then
  # Static PAT fallback — configure credentials for the detected platform
  git config --global credential.helper store
  : > ~/.git-credentials
  chmod 600 ~/.git-credentials

  if [ -n "${GITHUB_TOKEN:-}" ]; then
    echo "https://x-access-token:${GITHUB_TOKEN}@github.com" >> ~/.git-credentials
    echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true
    echo "[optio] GitHub credentials configured"
  fi

  if [ -n "${GITLAB_TOKEN:-}" ]; then
    # Extract GitLab host from repo URL, default to gitlab.com
    GITLAB_HOST="gitlab.com"
    case "${OPTIO_REPO_URL}" in
      *://*)
        GITLAB_HOST=$(echo "${OPTIO_REPO_URL}" | sed -E 's|.*://([^/]+).*|\1|')
        ;;
    esac
    echo "https://oauth2:${GITLAB_TOKEN}@${GITLAB_HOST}" >> ~/.git-credentials
    # Authenticate glab CLI if available
    if command -v glab >/dev/null 2>&1; then
      glab auth login --hostname "${GITLAB_HOST}" --token "${GITLAB_TOKEN}" 2>/dev/null || true
    fi
    echo "[optio] GitLab credentials configured (host: ${GITLAB_HOST})"
  fi

  echo "[optio] Git credentials configured (static token)"
fi

# Install extra packages if requested (comma or space separated)
if [ -n "${OPTIO_EXTRA_PACKAGES:-}" ]; then
  PACKAGES=$(echo "${OPTIO_EXTRA_PACKAGES}" | tr ',' ' ')
  # Validate package names to prevent command injection
  for pkg in ${PACKAGES}; do
    if [[ ! "$pkg" =~ ^[a-zA-Z0-9][a-zA-Z0-9.+\-]+$ ]]; then
      echo "[optio] Error: invalid package name: $pkg" >&2
      exit 1
    fi
  done
  echo "[optio] Installing packages: ${PACKAGES}"
  sudo apt-get update -qq 2>/dev/null && sudo apt-get install -y -qq ${PACKAGES} 2>&1 | tail -3 || echo "[optio] Warning: package install failed"
fi

# Clone repo (--recurse-submodules handles repos with submodules)
cd /workspace
echo "[optio] Cloning..."
git clone --branch "${OPTIO_REPO_BRANCH}" --recurse-submodules "${OPTIO_REPO_URL}" repo 2>&1
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
# NOTE: .optio/setup.sh is the preferred extensibility hook.
# OPTIO_SETUP_COMMANDS is deprecated and will be removed in a future release.
if [ -n "${OPTIO_SETUP_COMMANDS:-}" ]; then
  echo "[optio] Running setup commands (consider migrating to .optio/setup.sh)..."
  cd /workspace/repo
  SETUP_SCRIPT="$(mktemp /tmp/optio-setup-XXXXXX.sh)"
  printf '%s\n' "${OPTIO_SETUP_COMMANDS}" > "${SETUP_SCRIPT}"
  chmod 700 "${SETUP_SCRIPT}"
  bash "${SETUP_SCRIPT}"
  SETUP_EXIT=$?
  rm -f "${SETUP_SCRIPT}"
  if [ "${SETUP_EXIT}" -ne 0 ]; then
    echo "[optio] Warning: setup commands exited with status ${SETUP_EXIT}" >&2
  fi
  echo "[optio] Setup commands complete"
fi

# Signal that the pod is ready for tasks
touch /workspace/.ready
echo "[optio] Repo pod ready — waiting for tasks"

# Keep the pod alive
exec sleep infinity
