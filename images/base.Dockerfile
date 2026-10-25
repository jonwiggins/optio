# ---- Building with no network (docs/air-gapped.md) ----
# Every default below builds as upstream does, from the internet. Offline, the
# offline kit's images replace them (scripts/offline/build-images.sh --offline):
#   NODE_SLIM_IMAGE, UBUNTU_IMAGE  the base images, from your own registry
#   AGENT_TOOLCHAIN_IMAGE          the agent-toolchain stage below, built ahead
#                                  (toolchain/agent; a preset's toolchain/<preset>
#                                  is images/<preset>.Dockerfile on it): the
#                                  image starts from it and nothing is fetched
#   PNPM_OFFLINE=1                 the bridge installs from the pnpm-offline
#                                  context (Dockerfile.web describes it)
ARG NODE_SLIM_IMAGE=node:22-slim
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:186072bba1b2f436cbb91ef2567abca677337cfc786c86e107d25b7072feef0c
ARG AGENT_TOOLCHAIN_IMAGE=

# Empty unless PNPM_OFFLINE=1 (store/ and pnpm.tgz).
FROM scratch AS pnpm-offline

# ---- MCP bridge build stage ----
# @optio/mcp-bridge is a stdio MCP server that proxies one token-authenticated
# REST API for the agent. It is bundled to one file and baked in at
# /opt/optio/mcp-bridge.js (launched as `node /opt/optio/mcp-bridge.js`).
FROM ${NODE_SLIM_IMAGE} AS bridge
ARG PNPM_OFFLINE=0
RUN --mount=type=bind,from=pnpm-offline,target=/pnpm-offline \
    if [ "$PNPM_OFFLINE" = "1" ]; then \
      corepack enable && COREPACK_ENABLE_NETWORK=0 corepack install -g --cache-only /pnpm-offline/pnpm.tgz; \
    else corepack enable && corepack prepare pnpm@10 --activate; fi
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/mcp-bridge/ packages/mcp-bridge/
RUN --mount=type=bind,from=pnpm-offline,target=/pnpm-offline,rw \
    if [ "$PNPM_OFFLINE" = "1" ]; then \
      export COREPACK_ENABLE_NETWORK=0 && pnpm install --frozen-lockfile --ignore-scripts \
        --filter @optio/mcp-bridge --offline --store-dir /pnpm-offline/store; \
    else pnpm install --frozen-lockfile --ignore-scripts --filter @optio/mcp-bridge; fi \
    && pnpm --filter @optio/mcp-bridge build

# ---- The agent's third-party toolchain ----
# Everything below up to the next stage comes from apt, npm and release
# downloads, and none of it is Optio's: the offline kit builds this stage
# ahead (--target agent-toolchain, as toolchain/agent) and an offline build
# starts the image from it (AGENT_TOOLCHAIN_IMAGE). Unset, the image builds on
# this stage as before.
FROM ${UBUNTU_IMAGE} AS agent-toolchain

ENV DEBIAN_FRONTEND=noninteractive

# Comma-separated agent runtimes; all preserves the complete toolchain.
ARG AGENT_CLIS=all
ARG CLAUDE_CODE_VERSION=2.1.112

# System essentials
# tini: the pods' pid 1 (`exec tini -- sleep infinity` ends every init
# script), so the run supervisors reparented to it are reaped (run protocol).
RUN apt-get update && apt-get install -y \
    git curl wget jq unzip tmux tini \
    ca-certificates gnupg \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# GitLab CLI
ARG GLAB_VERSION=1.91.0
RUN ARCH=$(dpkg --print-architecture) \
    && curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${ARCH}.deb" -o /tmp/glab.deb \
    && dpkg -i /tmp/glab.deb \
    && rm /tmp/glab.deb

# AWS CLI v2 (used for AWS CodeCommit clone auth via `aws codecommit credential-helper`
# and for `aws codecommit create-pull-request` from agents)
RUN ARCH_RAW=$(dpkg --print-architecture) \
    && case "$ARCH_RAW" in \
         amd64) AWS_ARCH=x86_64 ;; \
         arm64) AWS_ARCH=aarch64 ;; \
         *) echo "Unsupported arch: $ARCH_RAW" && exit 1 ;; \
       esac \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWS_ARCH}.zip" -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/awscliv2.zip /tmp/aws

# Node.js 22 (needed for Claude Code)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Verify Node ships OpenSSL >= 3.5 for post-quantum TLS (X25519MLKEM768)
RUN node -e 'const [maj,min] = process.versions.openssl.split(".").map(Number); if (maj < 3 || (maj === 3 && min < 5)) { console.error("OpenSSL " + process.versions.openssl + " too old; need >= 3.5"); process.exit(1); }'

# pnpm (installed globally before switching to non-root user)
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@10 --activate \
    && chmod -R a+rX /opt/corepack

# Claude Code
# PINNED to work around a Bun regression, NOT for feature reasons.
# 2.1.112 is the last release shipped as a plain Node.js bundle (bin/cli.js).
# Starting at 2.1.113 the CLI ships as a Bun-compiled single-file binary
# (bin/claude.exe), and every such build embeds Bun >= 1.3.13 — which segfaults
# with "embedder failed to suspend thread ... for TLC" when the binary is launched
# via `docker exec` / `kubectl exec` (i.e. NOT as PID 1) on Linux kernel >= 7.0.
# Optio ALWAYS execs the agent inside the long-lived repo pod, so it always hits this.
# Upstream regression: https://github.com/oven-sh/bun/issues/31832 (Bun 1.3.12-1.3.14).
# TODO(#566): bump back to latest once upstream Bun ships a fix and claude-code adopts it.
RUN case ",${AGENT_CLIS}," in *,all,*|*,claude-code,*) npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" ;; esac

# OpenAI Codex CLI. The entrypoint runs `codex exec
# --dangerously-bypass-approvals-and-sandbox` (the pod is the sandbox; the
# older `--full-auto` is gone from 0.162+): fail the build, not every run, if
# the Codex this image gets no longer takes it.
RUN case ",${AGENT_CLIS}," in *,all,*|*,codex,*) npm install -g @openai/codex \
    && codex exec --help | grep -q -- --dangerously-bypass-approvals-and-sandbox ;; esac

# GitHub Copilot CLI (pinned + best-effort — package may be temporarily unavailable)
RUN case ",${AGENT_CLIS}," in *,all,*|*,copilot,*) npm install -g @github/copilot@1.0.20 || echo "WARN: @github/copilot install failed; copilot agent will not be available in this image" ;; esac

# OpenCode CLI (experimental).
# PINNED to work around the same Bun regression as Claude Code above.
# opencode ships as a Bun-compiled single-file binary. 1.14.20 is the last release
# built with Bun 1.3.11; starting at 1.14.21 it is built with Bun >= 1.3.13, which
# segfaults ("embedder failed to suspend thread ... for TLC") when launched via
# `docker exec` / `kubectl exec` (not PID 1) on Linux kernel >= 7.0 — the config
# Optio always runs agents in.
# Upstream regression: https://github.com/oven-sh/bun/issues/31832 (Bun 1.3.12-1.3.14).
# The install script pins via the VERSION env var; the OPENCODE_VERSION build-arg was
# previously declared but never passed through, so `latest` was always installed.
# TODO(#566): bump back to latest once upstream Bun ships a fix and opencode adopts it.
# Best-effort: opencode.ai is a single point of failure for the install
# script, so let the build succeed even when the upstream is briefly
# unavailable (matches the @github/copilot and openclaw fallbacks).
ARG OPENCODE_INSTALL_METHOD=script
ARG OPENCODE_VERSION=1.14.20
RUN case ",${AGENT_CLIS}," in *,all,*|*,opencode,*) if [ "$OPENCODE_INSTALL_METHOD" = npm ]; then npm install -g "opencode-ai@${OPENCODE_VERSION}"; else (curl -fsSL https://opencode.ai/install | VERSION="${OPENCODE_VERSION}" bash \
  && mv /root/.opencode/bin/opencode /usr/local/bin/ \
  && rm -rf /root/.opencode) \
  || echo "WARN: opencode install failed; opencode agent will not be available in this image"; fi ;; esac

# Google Gemini CLI
RUN case ",${AGENT_CLIS}," in *,all,*|*,gemini,*) npm install -g @google/gemini-cli ;; esac

# OpenClaw CLI (experimental)
RUN case ",${AGENT_CLIS}," in *,all,*|*,openclaw,*) npm install -g openclaw || echo "WARN: openclaw install failed; openclaw agent will not be available in this image" ;; esac

# Cursor CLI (cursor-agent). The install script drops a versioned payload under
# ~/.local/share/cursor-agent with a ~/.local/bin/cursor-agent symlink; relocate
# it to /opt so the non-root agent user can run it. Best-effort like the other
# non-npm installs — cursor.com is a single point of failure for the script.
RUN case ",${AGENT_CLIS}," in *,all,*|*,cursor,*) (curl -fsS https://cursor.com/install | bash \
  && CURSOR_BIN="$(readlink -f /root/.local/bin/cursor-agent)" \
  && mkdir -p /opt/cursor-agent \
  && cp -a "$(dirname "$CURSOR_BIN")/." /opt/cursor-agent/ \
  && ln -sf /opt/cursor-agent/cursor-agent /usr/local/bin/cursor-agent \
  && rm -rf /root/.local/share/cursor-agent /root/.local/bin/cursor-agent) \
  || echo "WARN: cursor-agent install failed; cursor agent will not be available in this image" ;; esac

# Optional MCP binaries for connections that must start without downloads.
ARG PREINSTALL_MCP_SERVERS=0
RUN if [ "$PREINSTALL_MCP_SERVERS" = 1 ]; then \
    npm install -g @modelcontextprotocol/server-postgres@0.6.2 @modelcontextprotocol/server-filesystem@2026.8.31; fi
ENV OPTIO_MCP_PREINSTALLED=${PREINSTALL_MCP_SERVERS}

# Python 3 (minimal — needed for setup file injection)
RUN apt-get update && apt-get install -y python3 \
    && rm -rf /var/lib/apt/lists/*

# Non-root user (UID 1001 to match k8s securityContext). In the toolchain so
# that a preset's toolchain (images/<preset>.Dockerfile on this stage, some
# steps run as `agent`) builds on it.
RUN groupadd -g 1001 agent \
    && useradd -m -s /bin/bash -u 1001 -g 1001 agent

# ---- The agent image: Optio's own layers on the toolchain ----
FROM ${AGENT_TOOLCHAIN_IMAGE:-agent-toolchain}
# A preset's toolchain ends as `agent`.
USER root

# Workspace + Optio scripts
RUN mkdir -p /workspace /opt/optio
COPY scripts/agent-entrypoint.sh /opt/optio/entrypoint.sh
COPY scripts/repo-init.sh /opt/optio/repo-init.sh
RUN chmod +x /opt/optio/entrypoint.sh /opt/optio/repo-init.sh

# MCP bridge (built in the `bridge` stage above); world-readable for the agent user
COPY --from=bridge --chmod=0755 /app/packages/mcp-bridge/dist/mcp-bridge.js /opt/optio/mcp-bridge.js
COPY --from=bridge --chmod=0755 /app/packages/mcp-bridge/dist/controller-mcp.js /opt/optio/controller-mcp.js

# Optio credential helpers for dynamic token refresh (GitHub + GitLab)
COPY scripts/optio-git-credential /usr/local/bin/optio-git-credential
COPY scripts/optio-gh-wrapper /usr/local/bin/optio-gh-wrapper
COPY scripts/optio-glab-wrapper /usr/local/bin/optio-glab-wrapper
RUN chmod +x /usr/local/bin/optio-git-credential /usr/local/bin/optio-gh-wrapper /usr/local/bin/optio-glab-wrapper

# The agent user comes with the toolchain (UID 1001, k8s securityContext).
RUN chown -R agent:agent /workspace
# Claude Code's managed settings (docs/agent-policy.md). Optio writes
# each run's deny rules into /etc/claude-code/managed-settings.json as the
# agent user before the agent starts; the tier a repo's own settings can't
# override.
RUN mkdir -p /etc/claude-code && chown agent:agent /etc/claude-code
USER agent
WORKDIR /workspace

ENTRYPOINT ["/opt/optio/repo-init.sh"]
