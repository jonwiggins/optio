/**
 * What a Docker-in-Docker repo pod (`dockerInDocker`) adds to its spec, on
 * top of the user namespace, SYS_CHROOT and the tmpfs /var/lib/docker:
 *
 * - The start command goes through the dind image's entrypoint, which
 *   starts dockerd and then hands off to repo-init.sh. The pod spec's
 *   `command` replaces the image's ENTRYPOINT, so with repo-init.sh alone
 *   dockerd never ran. An image without that entrypoint (a custom one)
 *   starts repo-init.sh as before.
 * - A preStop hook removes the run's containers and stops dockerd before the
 *   kubelet's SIGTERM, which only reaches tini and its `sleep` — otherwise
 *   dockerd, its containers and their fuse-overlayfs mounts are killed at the
 *   grace deadline and can leave the pod stuck Terminating.
 */

export const DIND_ENTRYPOINT = "/opt/optio/dind-entrypoint.sh";

export const DIND_POD_COMMAND = [
  "/bin/sh",
  "-c",
  `if [ -x ${DIND_ENTRYPOINT} ]; then exec ${DIND_ENTRYPOINT}; fi; exec /opt/optio/repo-init.sh`,
];

export const DIND_PRE_STOP = [
  "/bin/sh",
  "-c",
  [
    "docker ps -q | xargs -r docker rm -f >/dev/null 2>&1",
    'pid="$(cat /var/run/docker.pid 2>/dev/null)"',
    'if [ -n "$pid" ]; then kill -TERM "$pid" 2>/dev/null; else pkill -TERM dockerd 2>/dev/null; fi',
    'i=0; while [ -n "$pid" ] && [ -e "/proc/$pid" ] && [ "$i" -lt 5 ]; do sleep 1; i=$((i+1)); done',
    "true",
  ].join("; "),
];

/** The spec fields a DinD repo pod adds (see above). */
export function dindPodFields(): { command: string[]; preStop: string[] } {
  return { command: [...DIND_POD_COMMAND], preStop: [...DIND_PRE_STOP] };
}
