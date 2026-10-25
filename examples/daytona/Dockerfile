# An image for the Daytona snapshot work runs in (docs/remote-workspaces.md,
# "Daytona"): Node.js 20+, git, curl and the agent CLIs, and passwordless
# sudo for the start script's agent policy. Optio brings its own CLI.
FROM node:20-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git sudo \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code opencode-ai

RUN useradd --create-home --shell /bin/bash daytona \
  && echo "daytona ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/daytona \
  && chmod 0440 /etc/sudoers.d/daytona
USER daytona
WORKDIR /home/daytona
