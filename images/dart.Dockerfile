ARG BASE_IMAGE=optio-base:latest
FROM ${BASE_IMAGE}

USER root

# Dart SDK
RUN apt-get update && apt-get install -y apt-transport-https \
    && curl -fsSL https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/dart.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/dart.gpg] https://storage.googleapis.com/download.dartlang.org/linux/debian stable main" \
    > /etc/apt/sources.list.d/dart_stable.list \
    && apt-get update && apt-get install -y dart \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/lib/dart/bin:${PATH}"

USER agent

# Dart pub cache in user home
ENV PUB_CACHE="/home/agent/.pub-cache"
ENV PATH="${PUB_CACHE}/bin:${PATH}"

# Common tools
RUN dart pub global activate dart_style
