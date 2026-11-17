ARG BASE_IMAGE=optio-base:latest
FROM ${BASE_IMAGE}

USER root

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

# protobuf compiler
RUN apt-get update && apt-get install -y protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

USER agent

# Go tools (deliberately @latest: the preset tracks current tools)
# hadolint ignore=DL3062
RUN go install google.golang.org/protobuf/cmd/protoc-gen-go@latest \
    && go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest \
    && go install golang.org/x/tools/gopls@latest
