# Optional offline inputs; defaults retain the upstream base images.
ARG NODE_SLIM_IMAGE=node:26.12.1-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac

ARG AGENT_TOOLCHAIN_IMAGE=

# Replaced with a directory or image containing store/ and pnpm.tgz.
FROM scratch AS pnpm-offline

# ---- MCP bridge build stage ----
# @optio/mcp-bridge is a stdio MCP server that proxies one token-authenticated
# REST API for the agent. It is bundled to one file and baked in at
# /opt/optio/mcp-bridge.js (launched as `node /opt/optio/mcp-bridge.js`).
FROM ${NODE_SLIM_IMAGE} AS node-runtime

FROM node-runtime AS bridge
ARG PNPM_OFFLINE=0
RUN --mount=type=bind,from=pnpm-offline,target=/pnpm-offline \
    if [ "$PNPM_OFFLINE" = "1" ]; then \
      mkdir -p /opt/pnpm \
      && tar -xzf /pnpm-offline/pnpm.tgz -C /opt/pnpm --strip-components=2 \
      && ln -s /opt/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm \
      && ln -s /opt/pnpm/bin/pnpx.cjs /usr/local/bin/pnpx; \
    else npm install -g pnpm@10.34.8; fi
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches/ patches/
COPY packages/mcp-bridge/ packages/mcp-bridge/
RUN --mount=type=bind,from=pnpm-offline,target=/pnpm-offline,rw \
    if [ "$PNPM_OFFLINE" = "1" ]; then \
      pnpm install --frozen-lockfile --ignore-scripts --filter @optio/mcp-bridge \
        --offline --store-dir /pnpm-offline/store; \
    else pnpm install --frozen-lockfile --ignore-scripts --filter @optio/mcp-bridge; fi \
    && pnpm --filter @optio/mcp-bridge build

FROM ${UBUNTU_IMAGE} AS agent-toolchain
ENV DEBIAN_FRONTEND=noninteractive

ARG AGENT_CLIS=all
ARG CLAUDE_CODE_VERSION=2.1.310

# System essentials
# tini: the pods' pid 1 (`exec tini -- sleep infinity` ends every init
# script), so the run supervisors reparented to it are reaped (run protocol).
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
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

# Node.js 26.12.1, including the October 2026 security fixes.
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN apt-get update && apt-get install -y --no-install-recommends libatomic1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

ARG NPM_VERSION=12.2.1
RUN npm install -g npm@"${NPM_VERSION}"

# Verify Node ships OpenSSL >= 3.5 for post-quantum TLS (X25519MLKEM768)
RUN node -e 'const [maj,min] = process.versions.openssl.split(".").map(Number); if (maj < 3 || (maj === 3 && min < 5)) { console.error("OpenSSL " + process.versions.openssl + " too old; need >= 3.5"); process.exit(1); }'

# Corepack is no longer bundled with Node. Keep project-aware pnpm/Yarn
# selection for repositories that declare their own packageManager.
RUN npm install -g corepack@0.36.0 \
    && corepack enable \
    && corepack prepare pnpm@10.34.8 --activate

# Claude Code security fixes, validated with the native exec smoke.
RUN case ",${AGENT_CLIS}," in *,all,*|*,claude-code,*) npm install -g --allow-scripts=@anthropic-ai/claude-code "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" ;; esac

# OpenAI Codex CLI. The entrypoint runs `codex exec
# --dangerously-bypass-approvals-and-sandbox` (the pod is the sandbox; the
# older `--full-auto` is gone from 0.162+): fail the build, not every run, if
# the Codex this image gets no longer takes it.
RUN case ",${AGENT_CLIS}," in *,all,*|*,codex,*) npm install -g @openai/codex \
    && codex exec --help | grep -q -- --dangerously-bypass-approvals-and-sandbox ;; esac

# Pi: native JSONL + MCP protocol used by the Pi adapter.
ARG PI_VERSION=1.4.0
COPY images/pi/package.json images/pi/package-lock.json /opt/optio/pi/
RUN case ",${AGENT_CLIS}," in *,all,*|*,pi,*) \
    if [ "$PI_VERSION" = "1.4.0" ]; then \
      npm ci --prefix /opt/optio/pi --omit=dev --ignore-scripts --no-audit --no-fund; \
    else \
      npm install --prefix /opt/optio/pi --omit=dev --ignore-scripts --no-audit --no-fund "@earendil-works/pi-coding-agent@${PI_VERSION}"; \
    fi \
    && ln -s /opt/optio/pi/node_modules/.bin/pi /usr/local/bin/pi \
    && pi --version ;; esac

# GitHub Copilot CLI (pinned + best-effort — package may be temporarily unavailable)
RUN case ",${AGENT_CLIS}," in *,all,*|*,copilot,*) npm install -g @github/copilot@1.0.103 || echo "WARN: @github/copilot install failed; copilot agent will not be available in this image" ;; esac

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
RUN case ",${AGENT_CLIS}," in *,all,*|*,gemini,*) npm install -g --allow-scripts=@github/keytar,node-pty @google/gemini-cli ;; esac

# OpenClaw CLI with an audited, reproducible dependency tree.
COPY images/openclaw/package.json images/openclaw/package-lock.json /opt/optio/openclaw/
RUN case ",${AGENT_CLIS}," in *,all,*|*,openclaw,*) npm ci --prefix /opt/optio/openclaw --omit=dev --no-audit --no-fund --strict-allow-scripts \
    && ln -s /opt/optio/openclaw/node_modules/.bin/openclaw /usr/local/bin/openclaw ;; esac

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
COPY scripts/check-preinstalled-mcp.mjs /opt/optio/check-preinstalled-mcp.mjs
RUN if [ "$PREINSTALL_MCP_SERVERS" = 1 ]; then \
    npm install -g @modelcontextprotocol/server-filesystem@2.0.1 \
    && node /opt/optio/check-preinstalled-mcp.mjs; fi
ENV OPTIO_MCP_PREINSTALLED=${PREINSTALL_MCP_SERVERS}

# Python 3 (minimal — needed for setup file injection)
RUN apt-get update && apt-get install -y python3 \
    && rm -rf /var/lib/apt/lists/*

# npm's bundled dependencies need fixes newer than its release lock.
RUN npm install --prefix /tmp/optio-npm-fixes --ignore-scripts --no-package-lock --no-audit --no-fund undici@6.29.1 ip-address@10.7.5 \
    && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici /usr/local/lib/node_modules/npm/node_modules/ip-address \
    && cp -a /tmp/optio-npm-fixes/node_modules/undici /tmp/optio-npm-fixes/node_modules/ip-address /usr/local/lib/node_modules/npm/node_modules/ \
    && rm -rf /tmp/optio-npm-fixes /root/.npm

# Non-root user (UID 1001 to match k8s securityContext)
RUN groupadd -g 1001 agent \
    && useradd -m -s /bin/bash -u 1001 -g 1001 agent

# ---- Agent layers on the selected toolchain ----
FROM ${AGENT_TOOLCHAIN_IMAGE:-agent-toolchain}
USER root

# Workspace + Optio scripts
RUN mkdir -p /workspace /opt/optio
COPY scripts/repo-init.sh /opt/optio/repo-init.sh
RUN chmod +x /opt/optio/repo-init.sh

# MCP bridge (built in the `bridge` stage above); world-readable for the agent user
COPY --from=bridge --chmod=0755 /app/packages/mcp-bridge/dist/mcp-bridge.js /opt/optio/mcp-bridge.js
COPY --from=bridge --chmod=0755 /app/packages/mcp-bridge/dist/controller-mcp.js /opt/optio/controller-mcp.js

# Optio credential helpers for dynamic token refresh (GitHub + GitLab)
COPY scripts/optio-git-credential /usr/local/bin/optio-git-credential
COPY scripts/optio-gh-wrapper /usr/local/bin/optio-gh-wrapper
COPY scripts/optio-glab-wrapper /usr/local/bin/optio-glab-wrapper
RUN chmod +x /usr/local/bin/optio-git-credential /usr/local/bin/optio-gh-wrapper /usr/local/bin/optio-glab-wrapper

RUN chown -R agent:agent /workspace

USER agent
WORKDIR /workspace

ENTRYPOINT ["/opt/optio/repo-init.sh"]
