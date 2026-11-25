/**
 * An in-process fake of the part of boxd's TypeScript SDK (@boxd-sh/sdk) the
 * boxd remote-workspace client uses (services/remote-workspaces/boxd.ts),
 * shaped as the SDK's types describe it: machines by id and region, their
 * statuses, `exec` and `fs.write`, snapshots, and the errors it throws by
 * name. `setBoxdSdkForTests(fake.factory)` hands it to the client.
 */
import type { BoxdOptions } from "@boxd-sh/sdk";
import type { BoxdSdk } from "../services/remote-workspaces/boxd.js";

type Status =
  | "pending"
  | "starting"
  | "running"
  | "suspended"
  | "hibernated"
  | "stopped"
  | "failed"
  | "destroyed";

interface FakeBoxdMachine {
  id: string;
  name: string;
  status: Status;
  region: string;
  org: string | undefined;
  isolated: boolean;
  labels: Record<string, string>;
  fromSnapshot: string | null;
  config: Record<string, unknown> | null;
  autoHibernateTimeout: number | null;
  files: Map<string, { data: string; mode: number | undefined }>;
}

interface FakeBoxdExec {
  machineId: string;
  command: string;
  /** The variables the command sourced from a file it read (`. <file>`), as the file held them. */
  sourced: Record<string, string>;
  /** Files the command left behind in the machine after it ran. */
  leftFiles: string[];
}

function named(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** `export K='v'` lines back to a map (the inverse of start-script.ts's shellExports). */
function parseShellExports(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^export ([A-Za-z_][A-Za-z0-9_]*)='((?:[^']|'\\'')*)'$/gm;
  for (const m of text.matchAll(re)) out[m[1]] = m[2].replace(/'\\''/g, "'");
  return out;
}

export interface FakeBoxd {
  factory: (opts: BoxdOptions) => Promise<BoxdSdk>;
  machines: Map<string, FakeBoxdMachine>;
  execs: FakeBoxdExec[];
  /** Every client the factory made, and whether it was closed. */
  clients: Array<{ opts: BoxdOptions; closed: boolean }>;
  snapshots: Array<{
    name: string;
    region: string | null;
    version: number | null;
    archived: boolean;
    os: "linux" | "windows";
    vcpu: number;
  }>;
  /** The next exec's exit code and output (then back to 0). */
  failNextExec(exitCode: number, stderr: string): void;
  /** The next setAutoHibernateTimeout throws. */
  failNextTimeout(): void;
  /** The next exec throws (the call never reached the machine). */
  throwNextExec(): void;
  /** What regions.list answers (the endpoints the SDK would connect to). */
  regions: Array<{ id: string; apiEndpoint: string }>;
  /** machines.list refuses (a key of another organization). */
  listDenied: boolean;
  /** account.get refuses (an organization's own key has no user). */
  orgKey: boolean;
}

export function startFakeBoxd(opts: { apiKey: string; region?: string }): FakeBoxd {
  const home = opts.region ?? "fra";
  const machines = new Map<string, FakeBoxdMachine>();
  const execs: FakeBoxdExec[] = [];
  const clients: FakeBoxd["clients"] = [];
  let nextExec: { exitCode: number; stderr: string } | null = null;
  let timeoutFails = false;
  let execThrows = false;
  let seq = 0;

  const fake: FakeBoxd = {
    machines,
    execs,
    clients,
    snapshots: [],
    orgKey: false,
    listDenied: false,
    regions: [...new Set([home, "fra", "nyc"])].map((id) => ({ id, apiEndpoint: "" })),
    throwNextExec() {
      execThrows = true;
    },
    failNextExec(exitCode, stderr) {
      nextExec = { exitCode, stderr };
    },
    failNextTimeout() {
      timeoutFails = true;
    },
    factory: async (o) => {
      const client = { opts: o, closed: false };
      clients.push(client);
      const authed = () => {
        if (o.apiKey !== opts.apiKey) {
          throw named("AuthenticationError", "API key not recognized");
        }
      };
      const find = (id: string, where?: { region?: string }) => {
        authed();
        const m = machines.get(id);
        if (!m || m.status === "destroyed" || m.region !== (where?.region ?? home)) {
          throw named("NotFoundError", `VM not found (region ${where?.region ?? home})`);
        }
        return m;
      };
      const view = (m: FakeBoxdMachine) => ({
        id: m.id,
        name: m.name,
        status: m.status,
        region: m.region,
        labels: { ...m.labels },
      });
      const sdk = {
        account: {
          get: async () => {
            authed();
            if (fake.orgKey) throw named("PermissionDeniedError", "not a user's credential");
            return { userId: "user-1", displayName: "dev", sshKeyFingerprints: [], billing: {} };
          },
        },
        regions: {
          list: async () => {
            authed();
            return fake.regions.map((r) => ({ ...r }));
          },
        },
        snapshots: {
          list: async () => {
            authed();
            return fake.snapshots.map((s) => ({ ...s, id: `snap-${s.name}` }));
          },
        },
        machines: {
          list: async (p?: { region?: string }) => {
            authed();
            if (fake.listDenied) throw named("PermissionDeniedError", "not a member of that org");
            return [...machines.values()]
              .filter((m) => p?.region === "all" || m.region === (p?.region ?? home))
              .map(view);
          },
          get: async (id: string, w?: { region?: string }) => view(find(id, w)),
          create: async (p: Record<string, unknown>) => {
            authed();
            const id = `m-${++seq}`;
            const m: FakeBoxdMachine = {
              id,
              name: String(p.name),
              status: "running",
              region: (p.region as string | undefined) ?? home,
              org: p.org as string | undefined,
              isolated: p.isolated === true,
              labels: { ...((p.labels as Record<string, string>) ?? {}) },
              fromSnapshot: (p.fromSnapshot as string | undefined) ?? null,
              config: (p.config as Record<string, unknown> | undefined) ?? null,
              autoHibernateTimeout: null,
              files: new Map(),
            };
            machines.set(id, m);
            return view(m);
          },
          setAutoHibernateTimeout: async (id: string, s: number, w?: { region?: string }) => {
            const m = find(id, w);
            if (timeoutFails) {
              timeoutFails = false;
              throw named("APIStatusError", "unavailable");
            }
            m.autoHibernateTimeout = s;
          },
          start: async (id: string, w?: { region?: string }) => {
            const m = find(id, w);
            if (m.status !== "stopped") throw named("ConflictError", `VM is ${m.status}`);
            m.status = "running";
          },
          wake: async (id: string, w?: { region?: string }) => {
            find(id, w).status = "running";
          },
          resume: async (id: string, w?: { region?: string }) => {
            find(id, w).status = "running";
          },
          hibernate: async (id: string, w?: { region?: string }) => {
            const m = find(id, w);
            if (m.status === "hibernated") throw named("ConflictError", "VM is hibernated");
            m.status = "hibernated";
          },
          delete: async (id: string, w?: { region?: string }) => {
            find(id, w).status = "destroyed";
          },
          fs: {
            remove: async (id: string, path: string, w?: { region?: string }) => {
              find(id, w).files.delete(path);
            },
            write: async (
              id: string,
              path: string,
              data: string,
              w?: { mode?: number; region?: string },
            ) => {
              find(id, w).files.set(path, { data, mode: w?.mode });
            },
          },
          exec: async (id: string, p: { command: string; region?: string }) => {
            const m = find(id, p);
            if (execThrows) {
              execThrows = false;
              throw named("APIConnectionError", "connection reset");
            }
            if (m.status === "stopped") throw named("ConflictError", "VM is stopped");
            m.status = "running";
            let sourced: Record<string, string> = {};
            const src = /\. (\S+) \|\|/.exec(p.command)?.[1];
            if (src && m.files.has(src)) sourced = parseShellExports(m.files.get(src)!.data);
            for (const rm of p.command.matchAll(/rm -f (\S+);/g)) m.files.delete(rm[1]);
            execs.push({
              machineId: id,
              command: p.command,
              sourced,
              leftFiles: [...m.files.keys()],
            });
            const out = nextExec ?? { exitCode: 0, stderr: "" };
            nextExec = null;
            return { stdout: "", stderr: out.stderr, exitCode: out.exitCode };
          },
        },
        close: async () => {
          client.closed = true;
        },
      };
      return sdk as unknown as BoxdSdk;
    },
  };
  return fake;
}
