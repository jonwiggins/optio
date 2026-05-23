#!/bin/bash
set -euo pipefail

echo "[optio] Starting agent: ${OPTIO_AGENT_TYPE}"
echo "[optio] Task ID: ${OPTIO_TASK_ID}"
echo "[optio] Repo: ${OPTIO_REPO_URL} (branch: ${OPTIO_REPO_BRANCH})"
echo "[optio] Auth mode: ${OPTIO_AUTH_MODE:-api-key}"

# Configure git
git config --global user.name "Optio Agent"
git config --global user.email "optio-agent@noreply.github.com"

# Authenticate CLI tools
if [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "${GITHUB_TOKEN}" | gh auth login --with-token
  echo "[optio] GitHub CLI authenticated"
fi
if [ -n "${GITLAB_TOKEN:-}" ] && command -v glab >/dev/null 2>&1; then
  glab auth login --hostname "${GITLAB_HOST:-gitlab.com}" --token "${GITLAB_TOKEN}"
  echo "[optio] GitLab CLI authenticated"
fi
case "${OPTIO_REPO_URL:-}" in
  *git-codecommit.*.amazonaws.com*)
    if command -v aws >/dev/null 2>&1; then
      git config --global credential.helper '!aws codecommit credential-helper $@'
      git config --global credential.UseHttpPath true
      if [ -z "${AWS_DEFAULT_REGION:-}" ] && [ -n "${AWS_REGION:-}" ]; then
        export AWS_DEFAULT_REGION="${AWS_REGION}"
      fi
      echo "[optio] AWS CodeCommit credential helper configured (region: ${AWS_DEFAULT_REGION:-${AWS_REGION:-unset}})"
      aws sts get-caller-identity >/dev/null 2>&1 \
        && echo "[optio] AWS credentials valid" \
        || echo "[optio] WARNING: AWS credentials missing or invalid — clone/PR ops may fail"
    else
      echo "[optio] WARNING: aws CLI not found in image; CodeCommit operations will fail"
    fi
    ;;
esac

# Clone repo
cd /workspace
git clone --branch "${OPTIO_REPO_BRANCH}" "${OPTIO_REPO_URL}" repo
cd repo

# Create working branch
BRANCH_NAME="${OPTIO_BRANCH_NAME:-optio/task-${OPTIO_TASK_ID}}"
git checkout -b "${BRANCH_NAME}"
echo "[optio] Working on branch: ${BRANCH_NAME}"

# Create any setup files injected by the orchestrator
if [ -n "${OPTIO_SETUP_FILES:-}" ]; then
  echo "[optio] Writing setup files..."
  echo "${OPTIO_SETUP_FILES}" | base64 -d | python3 -c "
import json, sys, os, base64
files = json.load(sys.stdin)
for f in files:
    parent = os.path.dirname(f['path'])
    if parent:
        os.makedirs(parent, exist_ok=True)
    if 'contentBase64' in f and f['contentBase64'] is not None:
        with open(f['path'], 'wb') as fh:
            fh.write(base64.b64decode(f['contentBase64']))
    else:
        with open(f['path'], 'w') as fh:
            fh.write(f.get('content', ''))
    if f.get('executable'):
        os.chmod(f['path'], 0o755)
    elif f.get('sensitive'):
        # For sensitive files (service account keys, credentials), set restrictive permissions
        os.chmod(f['path'], 0o600)
    print(f'  wrote {f[\"path\"]}')
"
fi

# Run the appropriate agent
case "${OPTIO_AGENT_TYPE}" in
  claude-code)
    # Set up auth based on mode
    if [ "${OPTIO_AUTH_MODE:-api-key}" = "max-subscription" ]; then
      echo "[optio] Using Max subscription (token proxy)"
      # Verify the token proxy is reachable
      if curl -sf "${OPTIO_API_URL}/api/auth/claude-token" > /dev/null 2>&1; then
        echo "[optio] Token proxy reachable"
      else
        echo "[optio] WARNING: Token proxy not reachable at ${OPTIO_API_URL}"
      fi
      # Unset API key so Claude Code uses the apiKeyHelper
      unset ANTHROPIC_API_KEY 2>/dev/null || true
    elif [ "${OPTIO_AUTH_MODE:-api-key}" = "vertex-ai" ]; then
      echo "[optio] Using Vertex AI (Google Cloud)"
      # Validate required env vars for Vertex AI
      if [ -z "${ANTHROPIC_VERTEX_PROJECT_ID:-}" ]; then
        echo "[optio] ERROR: ANTHROPIC_VERTEX_PROJECT_ID is required for Vertex AI mode"
        echo "[optio] Set this via the Vertex AI section of the setup wizard at /setup"
        exit 1
      fi
      if [ -z "${CLOUD_ML_REGION:-}" ]; then
        echo "[optio] ERROR: CLOUD_ML_REGION is required for Vertex AI mode"
        echo "[optio] Set this via the Vertex AI section of the setup wizard at /setup"
        exit 1
      fi
      echo "[optio] GCP Project: ${ANTHROPIC_VERTEX_PROJECT_ID}"
      echo "[optio] Region: ${CLOUD_ML_REGION}"
      if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
        echo "[optio] Using service account key at: ${GOOGLE_APPLICATION_CREDENTIALS}"
      else
        echo "[optio] Using workload identity (no service account key provided)"
      fi
      # Unset API key so Claude Code uses Vertex AI
      unset ANTHROPIC_API_KEY 2>/dev/null || true
    else
      echo "[optio] Using API key"
    fi

    echo "[optio] Running Claude Code..."
    claude -p "${OPTIO_PROMPT}" \
      --allowedTools "Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch" \
      --output-format stream-json \
      --verbose
    ;;
  codex)
    echo "[optio] Running OpenAI Codex..."
    codex exec --full-auto "${OPTIO_PROMPT}" --json
    ;;
  copilot)
    echo "[optio] Running GitHub Copilot..."
    COPILOT_FLAGS="--autopilot --yolo --output-format json --no-ask-user"
    if [ -n "${COPILOT_MODEL:-}" ]; then
      COPILOT_FLAGS="${COPILOT_FLAGS} --model ${COPILOT_MODEL}"
    fi
    if [ -n "${COPILOT_EFFORT:-}" ]; then
      COPILOT_FLAGS="${COPILOT_FLAGS} --effort ${COPILOT_EFFORT}"
    fi
    copilot ${COPILOT_FLAGS} -p "${OPTIO_PROMPT}"
    ;;
  opencode)
    echo "[optio] Running OpenCode (experimental)..."
    OPENCODE_FLAGS="run --format json"
    if [ -n "${OPTIO_OPENCODE_MODEL:-}" ]; then
      OPENCODE_FLAGS="${OPENCODE_FLAGS} --model ${OPTIO_OPENCODE_MODEL}"
    fi
    if [ -n "${OPTIO_OPENCODE_AGENT:-}" ]; then
      OPENCODE_FLAGS="${OPENCODE_FLAGS} --agent ${OPTIO_OPENCODE_AGENT}"
    fi
    opencode ${OPENCODE_FLAGS} "${OPTIO_PROMPT}"
    ;;
  gemini)
    echo "[optio] Running Google Gemini..."
    GEMINI_FLAGS="--output-format stream-json --approval-mode yolo"
    if [ -n "${OPTIO_GEMINI_MODEL:-}" ]; then
      GEMINI_FLAGS="${GEMINI_FLAGS} -m ${OPTIO_GEMINI_MODEL}"
    fi
    gemini ${GEMINI_FLAGS} -p "${OPTIO_PROMPT}"
    ;;
  *)
    echo "[optio] Unknown agent type: ${OPTIO_AGENT_TYPE}"
    exit 1
    ;;
esac

echo "[optio] Agent finished"
