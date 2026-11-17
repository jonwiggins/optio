ARG BASE_IMAGE=optio-base:latest
FROM ${BASE_IMAGE}

USER root

# Full Python toolchain
RUN apt-get update && apt-get install -y \
    python3-full python3-pip python3-venv python3-dev \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# uv (fast Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && mv /root/.local/bin/uv /usr/local/bin/ \
    && mv /root/.local/bin/uvx /usr/local/bin/ \
    && rm -rf /root/.local

# poetry
RUN pip3 install --no-cache-dir --break-system-packages poetry

USER agent
