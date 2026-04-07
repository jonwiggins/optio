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

# GitHub Copilot CLI
RUN npm install -g @github/copilot

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

# Non-root user
RUN useradd -m -s /bin/bash agent \
    && chown -R agent:agent /workspace
USER agent
WORKDIR /workspace

ENTRYPOINT ["/opt/optio/repo-init.sh"]
