ARG BASE_IMAGE=optio-base:latest
FROM ${BASE_IMAGE}

USER root

# Build essentials
RUN apt-get update && apt-get install -y \
    build-essential pkg-config libssl-dev unzip \
    python3-full python3-pip python3-venv python3-dev \
    protobuf-compiler \
    postgresql-client redis-tools \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

# Node.js package managers (pnpm and yarn are provided by Corepack in the base image)
RUN curl -fsSL https://bun.sh/install | bash \
    && mv /root/.bun/bin/bun /usr/local/bin/ \
    && rm -rf /root/.bun

# Python tools
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && mv /root/.local/bin/uv /usr/local/bin/ \
    && mv /root/.local/bin/uvx /usr/local/bin/ \
    && rm -rf /root/.local \
    && pip3 install --no-cache-dir --break-system-packages poetry

# Go
ENV GOVERSION=1.27.3
# Release archives and checksums: https://go.dev/dl/
RUN go_arch="$(dpkg --print-architecture)" \
    && case "$go_arch" in \
        amd64) go_sha256=65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40 ;; \
        arm64) go_sha256=a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49 ;; \
        *) echo "Unsupported Go architecture: $go_arch" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://go.dev/dl/go${GOVERSION}.linux-${go_arch}.tar.gz" -o /tmp/optio-go.tar.gz \
    && echo "$go_sha256  /tmp/optio-go.tar.gz" | sha256sum -c - \
    && tar -C /usr/local -xzf /tmp/optio-go.tar.gz \
    && rm /tmp/optio-go.tar.gz
ENV PATH="/usr/local/go/bin:/home/agent/go/bin:${PATH}"
ENV GOPATH="/home/agent/go"

USER agent

# Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/home/agent/.cargo/bin:${PATH}"
