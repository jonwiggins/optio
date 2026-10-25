import os from "node:os";

/**
 * Who this machine says it is when the daemon registers: the host id, the
 * hostname and the name shown in Optio. A remote workspace Optio started is
 * pre-registered, so its daemon is told the row by the environment
 * (docs/remote-workspaces.md): `OPTIO_LOCAL_HOST_ID` (matched by id, not by
 * hostname — a workspace's hostname is whatever its pod or VM is called) and
 * `OPTIO_LOCAL_HOSTNAME` (the workspace's name, shown as its name).
 */
export interface HostIdentity {
  /** The row to keep: the environment's, else the one this server gave us last time. */
  hostId?: string;
  hostname: string;
  /** Only when chosen here (`--name`, `OPTIO_LOCAL_HOSTNAME`): a name set in Optio stays otherwise. */
  name?: string;
}

// The register route's limits (apps/api/src/routes/local.ts).
const HOSTNAME_MAX = 255;
const NAME_MAX = 100;

export function hostIdentity(opts: {
  /** The id local.json holds for this server. */
  savedHostId?: string;
  /** `optio local up --name`. */
  name?: string;
  env?: NodeJS.ProcessEnv;
  osHostname?: () => string;
}): HostIdentity {
  const env = opts.env ?? process.env;
  const envHostId = env.OPTIO_LOCAL_HOST_ID?.trim();
  const envHostname = env.OPTIO_LOCAL_HOSTNAME?.trim();
  const hostname = (envHostname || (opts.osHostname ?? os.hostname)()).slice(0, HOSTNAME_MAX);
  const name = (opts.name?.trim() || envHostname)?.slice(0, NAME_MAX);
  const hostId = envHostId || opts.savedHostId;
  return {
    ...(hostId ? { hostId } : {}),
    hostname,
    ...(name ? { name } : {}),
  };
}
