#!/bin/bash
set -e

# Start the Docker daemon in the background.
# This runs inside a K8s user namespace (hostUsers: false) so SYS_ADMIN and
# NET_ADMIN capabilities are scoped to the user namespace — not the host.
echo "[optio-dind] Starting Docker daemon..."
# Its own session (setsid), with a known pidfile: the pod's preStop hook
# (apps/api/src/services/dind-pod.ts) removes the run's containers and sends
# dockerd SIGTERM before the kubelet stops the pod — the kubelet's own
# SIGTERM only reaches PID 1 (tini) and its child, never dockerd.
setsid dockerd \
  --host=unix:///var/run/docker.sock \
  --pidfile=/var/run/docker.pid \
  --storage-driver=fuse-overlayfs \
  --iptables=true \
  >/var/log/dockerd.log 2>&1 < /dev/null &

# Wait for the Docker daemon to be ready
for i in $(seq 1 30); do
  if docker info >/dev/null 2>&1; then
    echo "[optio-dind] Docker daemon ready"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[optio-dind] WARNING: Docker daemon failed to start within 30s"
    echo "[optio-dind] Continuing without Docker — check /var/log/dockerd.log for details"
  fi
  sleep 1
done

# Hand off to the standard repo-init entrypoint
exec /opt/optio/repo-init.sh "$@"
