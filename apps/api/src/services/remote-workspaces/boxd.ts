/**
 * boxd (https://docs.boxd.sh): a machine (a cloud VM) made from boxd's
 * standard image or from one of the organization's snapshots. Optio talks to
 * boxd through its TypeScript SDK (@boxd-sh/sdk) and starts its daemon with
 * the start script (start-script.ts), run with `exec` once the machine is up:
 * the bundle goes in a 0600 file the command reads and removes, never in the
 * machine's own environment, its labels or a command line. Stopping
 * stops the daemon and hibernates the machine (its memory and disk are
 * kept); a re-run wakes it and runs the start script again with a fresh
 * bundle.
 *
 *   account.get                       the Test (whom the API key signs in as)
 *   snapshots.list                    "templates", after the standard image
 *   machines.list, machines.get       existing machines; status
 *   machines.create                   create (isolated, labelled, in a region)
 *   machines.start | wake             start a stopped or hibernated machine
 *   exec, machines.hibernate          stop (Optio's daemon first, then the machine)
 *   machines.delete                   delete
 *   fs.write, exec                    run the start script
 *
 * The SDK speaks gRPC, so its calls can't go through `guardedFetch`: before
 * every call the connection's URL and every region endpoint the SDK may
 * reach are vetted with the same outbound policy (without DNS pinning), and
 * remote workspaces must be switched on (as in http.ts). A machine is
 * reached in its region, so a workspace's id is `<region>:<machine id>`, and
 * a snapshot's template id `<region>:<snapshot name>`.
 */
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { Boxd, BoxdOptions, Machine, Snapshot } from "@boxd-sh/sdk";
import { vetOutboundUrl } from "@optio/shared/ssrf";
import { remoteWorkspacesEnabled } from "../remote-workspace-policy.js";
import { hostOf } from "./coder.js";
import { START_COMMAND, shellExports, startCommandEnv } from "./start-script.js";
import {
  RemoteWorkspaceError,
  type CreateWorkspaceInput,
  type PairingDelivery,
  type ProviderIdentity,
  type ProviderTarget,
  type RemoteWorkspace,
  type RemoteWorkspaceClient,
  type RemoteWorkspaceProvider,
  type WorkspaceParameter,
  type WorkspaceTemplate,
} from "./types.js";

/** boxd's API when the connection leaves the URL blank. */
export const BOXD_DEFAULT_URL = "https://boxd.sh:9443";
/** The template that is boxd's standard image (Ubuntu with Node.js, git, Claude Code and Codex). */
const BOXD_STANDARD_IMAGE = "standard";
/** boxd's machine sizes, `<vCPU>x<GiB>`. */
const BOXD_SIZES = ["1x4", "2x8", "4x16", "8x32"] as const;
/** How long the start script's `exec` may take. */
const START_SCRIPT_TIMEOUT_MS = 60_000;
/**
 * Stops Optio's daemon and waits up to 5 s for it to exit (the brackets keep
 * the pattern from matching this command line, as in the start script).
 */
export const STOP_DAEMON =
  "pkill -f 'optio[.]js local up' 2>/dev/null; " +
  "for i in 1 2 3 4 5 6 7 8 9 10; do " +
  "pgrep -f 'optio[.]js local up' >/dev/null || exit 0; sleep 0.5; done; exit 0";
const STOP_DAEMON_TIMEOUT_MS = 15_000;

/** The part of the SDK's client Optio uses (tests hand in a fake). */
export type BoxdSdk = Pick<Boxd, "account" | "machines" | "regions" | "snapshots" | "close">;
export type BoxdSdkFactory = (opts: BoxdOptions) => Promise<BoxdSdk>;

const loadSdk: BoxdSdkFactory = async (opts) => {
  const { Boxd } = await import("@boxd-sh/sdk");
  return new Boxd(opts);
};
let makeSdk: BoxdSdkFactory = loadSdk;

/** Tests: make the SDK client another way; returns the restore. */
export function setBoxdSdkForTests(next: BoxdSdkFactory): () => void {
  const previous = makeSdk;
  makeSdk = next;
  return () => {
    makeSdk = previous;
  };
}

/** How long the API's list of regions (and their endpoints) is kept. */
const REGION_CACHE_MS = 5 * 60_000;
const regionCache = new Map<
  string,
  { at: number; list: Array<{ id: string; apiEndpoint: string }> }
>();

/** Tests: forget the regions the API named. */
export function clearBoxdRegionsForTests(): void {
  regionCache.clear();
}

/** An endpoint the SDK will connect to, vetted with the outbound policy (OPTIO_OUTBOUND_ALLOWED_HOSTS). */
async function vetEndpoint(url: string): Promise<void> {
  try {
    await vetOutboundUrl(url);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new RemoteWorkspaceError(`Couldn't reach boxd at ${hostOf(url)}: ${why}`, 502);
  }
}

/** A workspace id (or a snapshot's template id): `<region>:<rest>`, the region optional. */
export function splitRegion(id: string): { region: string | undefined; rest: string } {
  const at = id.indexOf(":");
  return at > 0
    ? { region: id.slice(0, at), rest: id.slice(at + 1) }
    : { region: undefined, rest: id };
}

function joinRegion(region: string | null | undefined, rest: string): string {
  return region ? `${region}:${rest}` : rest;
}

/** boxd's machine statuses, onto the words the rest of Optio uses. */
const STATUS: Record<string, string> = {
  running: "running",
  // Standby: the machine wakes on the first packet, so it counts as running.
  suspended: "running",
  pending: "starting",
  starting: "starting",
  migrating: "starting",
  hibernated: "stopped",
  stopped: "stopped",
  failed: "failed",
  destroyed: "deleted",
};

export function boxdStatus(status: string | undefined): string {
  return STATUS[status ?? ""] ?? "starting";
}

export function toWorkspace(m: Machine): RemoteWorkspace {
  const status = boxdStatus(m.status);
  return {
    id: joinRegion(m.region, m.id),
    name: m.name,
    ownerId: null,
    ownerName: null,
    templateId: null,
    templateName: null,
    templateVersionId: null,
    status,
    transition: status === "stopped" ? "stop" : status === "deleted" ? "delete" : "start",
    ready: status === "running",
    problem:
      status === "failed"
        ? `The boxd machine ${m.name} failed`
        : status === "deleted"
          ? `The boxd machine ${m.name} was deleted`
          : null,
  };
}

/** The SDK's error, as a RemoteWorkspaceError that never repeats the credential. */
function boxdError(err: unknown, what: string): RemoteWorkspaceError {
  if (err instanceof RemoteWorkspaceError) return err;
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  const status =
    name === "AuthenticationError" ||
    name === "PermissionDeniedError" ||
    name === "RegionNotEnabledError"
      ? 403
      : name === "NotFoundError"
        ? 404
        : name === "ConflictError"
          ? 409
          : 502;
  return new RemoteWorkspaceError(`boxd refused to ${what}: ${message}`, status);
}

const REPO_PARAMETER: WorkspaceParameter = {
  name: "repo_url",
  displayName: "Repository",
  description:
    "Cloned into the checkout when it is empty: a public repository, or one the machine has credentials for (from a snapshot).",
  type: "string",
  mutable: true,
  required: false,
  defaultValue: null,
  ephemeral: false,
  options: [],
  setByOptio: false,
};

/** A machine made from the standard image also takes a region and a size (a snapshot has its own). */
const STANDARD_PARAMETERS: WorkspaceParameter[] = [
  REPO_PARAMETER,
  {
    name: "region",
    displayName: "Region",
    description: "Where the machine runs (fra, nyc); blank = the API's own region.",
    type: "string",
    mutable: false,
    required: false,
    defaultValue: null,
    ephemeral: false,
    options: [],
    setByOptio: false,
  },
  {
    name: "size",
    displayName: "Size",
    description: "vCPUs x GiB of memory; blank = the organization's default.",
    type: "string",
    mutable: false,
    required: false,
    defaultValue: null,
    ephemeral: false,
    options: BOXD_SIZES.map((s) => {
      const [vcpu, gib] = s.split("x");
      return { name: `${vcpu} vCPU, ${gib} GiB`, value: s, description: null };
    }),
    setByOptio: false,
  },
];

function sizeConfig(size: string | undefined): { vcpu: number; memory: string } | undefined {
  const s = size?.trim();
  if (!s) return undefined;
  if (!(BOXD_SIZES as readonly string[]).includes(s)) {
    throw new RemoteWorkspaceError(
      `"${s}" isn't a boxd size: pick one of ${BOXD_SIZES.join(", ")}`,
    );
  }
  const [vcpu, gib] = s.split("x");
  return { vcpu: Number(vcpu), memory: `${gib}G` };
}

export class BoxdClient implements RemoteWorkspaceClient {
  private readonly org: string | undefined;
  /** The regions the API named (and that were vetted), for this client's calls. */
  private regions = new Set<string>();

  constructor(private readonly target: ProviderTarget) {
    this.org = target.organizationId?.trim() || undefined;
  }

  /** One SDK client for one operation, closed after it; every call vetted first. */
  private async call<T>(what: string, fn: (sdk: BoxdSdk) => Promise<T>): Promise<T> {
    if (!(await remoteWorkspacesEnabled())) {
      throw new RemoteWorkspaceError(
        "Remote workspaces are disabled by the deployment administrator",
        403,
      );
    }
    if (this.target.caPem?.trim() || this.target.insecureSkipVerify) {
      throw new RemoteWorkspaceError(
        "A boxd connection takes no CA bundle and always verifies TLS: clear both",
      );
    }
    if (!this.target.token) throw new RemoteWorkspaceError("The boxd connection has no API key");
    const url = this.target.url.replace(/\/+$/, "") || BOXD_DEFAULT_URL;
    await vetEndpoint(url);
    let sdk: BoxdSdk;
    try {
      // Only what the connection says: an explicit key, URL and region (none:
      // the URL's own), so the API server's BOXD_* environment never applies.
      sdk = await makeSdk({ apiKey: this.target.token, baseURL: url, region: "" });
    } catch (err) {
      throw boxdError(err, what);
    }
    try {
      await this.vetRegions(sdk, url);
      return await fn(sdk);
    } catch (err) {
      throw boxdError(err, what);
    } finally {
      await sdk.close().catch(() => {});
    }
  }

  /**
   * A call on a machine, a snapshot or an "all" list goes to a region's own
   * endpoint: the one the API names for it, or `<region>.<the API's host>`.
   * Each is vetted like the API's own URL (the API's answer kept a while).
   */
  private async vetRegions(sdk: BoxdSdk, url: string): Promise<void> {
    const key = `${url}|${this.org ?? ""}`;
    let regions = regionCache.get(key);
    if (!regions || regions.at < Date.now() - REGION_CACHE_MS) {
      regions = { at: Date.now(), list: await sdk.regions.list({ org: this.org }) };
      regionCache.set(key, regions);
    }
    const home = new URL(url);
    // The SDK derives `<region>.<host>` only for a host name with a dot that isn't an IP address.
    const derives = home.hostname.includes(".") && !isIP(home.hostname.replace(/^\[|\]$/g, ""));
    for (const r of regions.list) {
      if (derives) {
        const derived = new URL(url);
        derived.hostname = `${r.id}.${home.hostname}`;
        await vetEndpoint(derived.toString());
      }
      if (r.apiEndpoint) await vetEndpoint(r.apiEndpoint);
    }
    this.regions = new Set(regions.list.map((r) => r.id));
  }

  async whoami(): Promise<ProviderIdentity> {
    return this.call("check the API key", async (sdk) => {
      // The key must read the organization's machines, whoever it signs in as.
      await sdk.machines.list({ org: this.org });
      try {
        const me = await sdk.account.get();
        return { id: me.userId, username: me.displayName ?? me.userId };
      } catch (err) {
        // An organization's own key has no user: the list it could read is the proof.
        if (err instanceof Error && err.name === "PermissionDeniedError") {
          return { id: null, username: "" };
        }
        throw err;
      }
    });
  }

  async tokenExpiry(): Promise<Date | null> {
    // Reading keys and their expiry takes a person's own sign-in, not an API key.
    return null;
  }

  async templates(organizationId?: string | null) {
    const org = organizationId?.trim() || this.org || null;
    const snapshots = await this.call("list snapshots", (sdk) =>
      sdk.snapshots.list({ org: org ?? undefined, region: "all" }),
    );
    const standard: WorkspaceTemplate = {
      id: BOXD_STANDARD_IMAGE,
      name: BOXD_STANDARD_IMAGE,
      displayName: "boxd's standard image",
      description: "Ubuntu 24.04 with Node.js, git, Docker, Claude Code and Codex",
      organizationId: org,
      activeVersionId: BOXD_STANDARD_IMAGE,
    };
    const usable = (s: Snapshot) => s.version !== null && !s.archived && s.os !== "windows";
    return {
      organizationId: org ?? "",
      templates: [
        standard,
        ...[...snapshots].filter(usable).map((s) => {
          const id = joinRegion(s.region, s.name);
          return {
            id,
            name: s.name,
            displayName: s.region ? `${s.name} (${s.region})` : null,
            description: `Snapshot, ${s.vcpu} vCPU`,
            organizationId: org,
            activeVersionId: id,
          };
        }),
      ],
    };
  }

  async activeVersion(templateId: string): Promise<string> {
    return templateId;
  }

  async parameters(templateVersionId: string): Promise<WorkspaceParameter[]> {
    return !templateVersionId || templateVersionId === BOXD_STANDARD_IMAGE
      ? STANDARD_PARAMETERS
      : [REPO_PARAMETER];
  }

  async workspaces(): Promise<RemoteWorkspace[]> {
    const list = await this.call("list machines", (sdk) =>
      sdk.machines.list({ org: this.org, region: "all" }),
    );
    return [...list].filter((m) => m.status !== "destroyed").map(toWorkspace);
  }

  private machine(sdk: BoxdSdk, id: string): Promise<Machine> {
    const { region, rest } = splitRegion(id);
    return sdk.machines.get(rest, { region });
  }

  async workspace(id: string): Promise<RemoteWorkspace> {
    return toWorkspace(await this.call("find the machine", (sdk) => this.machine(sdk, id)));
  }

  async create(input: CreateWorkspaceInput): Promise<RemoteWorkspace> {
    const standard = !input.templateVersionId || input.templateVersionId === BOXD_STANDARD_IMAGE;
    const snapshot = standard ? null : splitRegion(input.templateVersionId);
    const region = (snapshot ? snapshot.region : input.wanted.region?.trim()) || undefined;
    const size = standard ? sizeConfig(input.wanted.size) : undefined;
    const common = {
      name: input.name,
      org: this.org,
      region,
      // The agent runs code from the work: the machine gets no boxd
      // credentials and no way into the organization's other machines.
      isolated: true,
      labels: { "optio-host-id": input.bundle.OPTIO_LOCAL_HOST_ID },
    };
    return this.call("create the machine", async (sdk) => {
      if (region && !this.regions.has(region)) {
        throw new RemoteWorkspaceError(
          `boxd has no region "${region}": pick one of ${[...this.regions].join(", ")}`,
        );
      }
      // Outbound traffic (the daemon's, the agent's calls to its model)
      // counts as activity, whatever the organization's default says.
      const m = snapshot
        ? await sdk.machines.create({
            ...common,
            fromSnapshot: snapshot.rest,
            config: { idleIgnoreOutbound: false },
          })
        : await sdk.machines.create({ ...common, config: { ...size, idleIgnoreOutbound: false } });
      if (input.ttlMs) {
        try {
          // The TTL: boxd hibernates the machine after this long without network traffic.
          await sdk.machines.setAutoHibernateTimeout(
            m.id,
            Math.max(60, Math.round(input.ttlMs / 1000)),
            { region: m.region ?? region },
          );
        } catch (err) {
          // Don't leave a machine behind that the work never gets.
          await sdk.machines.delete(m.id, { region: m.region ?? region }).catch(() => {});
          throw err;
        }
      }
      return toWorkspace(m);
    });
  }

  async start(ws: RemoteWorkspace, _input: PairingDelivery): Promise<void> {
    // The bundle goes in when it runs the start script (once it is running).
    const { region, rest } = splitRegion(ws.id);
    await this.call("start the machine", async (sdk) => {
      const m = await sdk.machines.get(rest, { region });
      if (m.status === "stopped") await sdk.machines.start(m.id, { region });
      else if (m.status === "hibernated") await sdk.machines.wake(m.id, { region });
      // Standby (suspended) wakes on its own with the start script's call.
    });
  }

  async stop(id: string): Promise<string> {
    const { region, rest } = splitRegion(id);
    return this.call("hibernate the machine", async (sdk) => {
      const m = await sdk.machines.get(rest, { region });
      if (m.status === "hibernated" || m.status === "stopped") return "stopped";
      if (m.status === "running" || m.status === "suspended") {
        // Stop Optio's daemon first, so its connection closes now: a
        // hibernated machine keeps its processes, and their sockets, as they
        // were, and Optio would wait on a daemon that can't answer. A re-run
        // starts it again with a fresh bundle.
        await sdk.machines
          .exec(m.id, { command: STOP_DAEMON, timeout: STOP_DAEMON_TIMEOUT_MS, region })
          .catch(() => {});
      }
      await sdk.machines.hibernate(m.id, { region });
      return "stopped";
    });
  }

  async remove(id: string): Promise<string> {
    const { region, rest } = splitRegion(id);
    try {
      await this.call("delete the machine", (sdk) => sdk.machines.delete(rest, { region }));
    } catch (err) {
      // Gone already.
      if (!(err instanceof RemoteWorkspaceError && err.status === 404)) throw err;
    }
    return "deleted";
  }

  async runStartScript(ws: RemoteWorkspace, env: Record<string, string>): Promise<void> {
    const { region, rest } = splitRegion(ws.id);
    const file = `/tmp/optio-pairing-${randomUUID()}.env`;
    const result = await this.call("run the start script", async (sdk) => {
      await sdk.machines.fs.write(rest, file, `${shellExports(startCommandEnv(env))}\n`, {
        mode: 0o600,
        region,
      });
      try {
        return await sdk.machines.exec(rest, {
          command: `trap 'rm -f ${file}' EXIT; . ${file} || exit $?; rm -f ${file}; ${START_COMMAND}`,
          timeout: START_SCRIPT_TIMEOUT_MS,
          region,
        });
      } catch (err) {
        // Don't leave the token behind when the command didn't get to run.
        await sdk.machines.fs.remove(rest, file, { region }).catch(() => {});
        throw err;
      }
    });
    if (result.exitCode !== 0) {
      const out = `${result.stderr || result.stdout}`.trim().slice(0, 300);
      throw new RemoteWorkspaceError(
        `The start script failed in ${ws.name} (exit ${result.exitCode})${out ? `: ${out}` : ""}`,
        502,
      );
    }
  }
}

export const boxdProvider: RemoteWorkspaceProvider = {
  id: "boxd",
  client: (target) => new BoxdClient(target),
  checksOwner: false,
  defaultCheckoutDir: () => "/home/boxd/repo",
};
