ARG BASE_IMAGE=optio-base:latest
# Offline (docs/air-gapped.md): an image that already has the
# packages of the dind-toolchain stage below and Optio's agent layers, i.e.
# images/base.Dockerfile built on toolchain/dind (the stage below on
# toolchain/agent); scripts/offline/build-images.sh --offline builds it as
# optio-agent-dind-base first. Empty = install them here, from apt, as before.
ARG DIND_TOOLCHAIN_IMAGE=

FROM ${BASE_IMAGE} AS dind-toolchain

USER root

# Docker daemon + CLI + dependencies for rootless DinD
RUN apt-get update && apt-get install -y \
    docker.io \
    iptables \
    fuse-overlayfs \
    && rm -rf /var/lib/apt/lists/*

# Configure Docker for rootless storage with fuse-overlayfs
RUN mkdir -p /etc/docker \
    && echo '{"storage-driver": "fuse-overlayfs"}' > /etc/docker/daemon.json

# Create Docker daemon directories
RUN mkdir -p /var/lib/docker /var/run

FROM ${DIND_TOOLCHAIN_IMAGE:-dind-toolchain}

USER root

# DinD entrypoint wrapper — starts dockerd then hands off to repo-init.sh
COPY images/dind-entrypoint.sh /opt/optio/dind-entrypoint.sh
RUN chmod +x /opt/optio/dind-entrypoint.sh

USER agent
ENV DOCKER_HOST=unix:///var/run/docker.sock

ENTRYPOINT ["/opt/optio/dind-entrypoint.sh"]
