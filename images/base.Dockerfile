FROM ubuntu:24.04@sha256:186072bba1b2f436cbb91ef2567abca677337cfc786c86e107d25b7072feef0c

ENV DEBIAN_FRONTEND=noninteractive

# System essentials
RUN apt-get update && apt-get install -y \
    git curl wget jq unzip \
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
RUN corepack enable && corepack prepare pnpm@10 --activate

# Claude Code
RUN npm install -g @anthropic-ai/claude-code

# GitHub Copilot CLI (pinned + best-effort — package may be temporarily unavailable)
RUN npm install -g @github/copilot@1.0.20 || echo "WARN: @github/copilot install failed; copilot agent will not be available in this image"

# OpenCode CLI (experimental — pinned version for stable JSON output).
# Best-effort: opencode.ai is a single point of failure for the install
# script, so let the build succeed even when the upstream is briefly
# unavailable (matches the @github/copilot and openclaw fallbacks).
ARG OPENCODE_VERSION=latest
RUN (curl -fsSL https://opencode.ai/install | bash \
  && mv /root/.opencode/bin/opencode /usr/local/bin/ \
  && rm -rf /root/.opencode) \
  || echo "WARN: opencode install failed; opencode agent will not be available in this image"

# Google Gemini CLI
RUN npm install -g @google/gemini-cli

# OpenClaw CLI (experimental)
RUN npm install -g openclaw || echo "WARN: openclaw install failed; openclaw agent will not be available in this image"

# Python 3 (minimal — needed for setup file injection)
RUN apt-get update && apt-get install -y python3 \
    && rm -rf /var/lib/apt/lists/*

# Workspace + Optio scripts
RUN mkdir -p /workspace /opt/optio
COPY scripts/agent-entrypoint.sh /opt/optio/entrypoint.sh
COPY scripts/repo-init.sh /opt/optio/repo-init.sh
RUN chmod +x /opt/optio/entrypoint.sh /opt/optio/repo-init.sh

# Optio credential helpers for dynamic token refresh (GitHub + GitLab)
COPY scripts/optio-git-credential /usr/local/bin/optio-git-credential
COPY scripts/optio-gh-wrapper /usr/local/bin/optio-gh-wrapper
COPY scripts/optio-glab-wrapper /usr/local/bin/optio-glab-wrapper
RUN chmod +x /usr/local/bin/optio-git-credential /usr/local/bin/optio-gh-wrapper /usr/local/bin/optio-glab-wrapper

# Non-root user (UID 1001 to match k8s securityContext)
RUN groupadd -g 1001 agent \
    && useradd -m -s /bin/bash -u 1001 -g 1001 agent \
    && chown -R agent:agent /workspace
USER agent
WORKDIR /workspace

ENTRYPOINT ["/opt/optio/repo-init.sh"]
