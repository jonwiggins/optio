/**
 * E2B (https://e2b.dev/docs; the REST API is spec/openapi.yml and the
 * in-sandbox daemon, envd, spec/envd/process/process.proto in
 * github.com/e2b-dev/E2B): a sandbox made from a template. Optio starts its
 * daemon with the start script (start-script.ts), run through envd's
 * `process.Process/Start` with the bundle in the process's environment.
 * Stopping a sandbox pauses it (its memory and disk are kept); a re-run
 * resumes it and runs the start script again with a fresh bundle.
 *
 *   GET    /v2/templates                    "templates" (the Test, too: E2B has no "who am I")
 *   GET    /v2/sandboxes?state=…            existing sandboxes
 *   GET    /sandboxes/{id}                  state, envd's address and access token
 *   POST   /v2/sandboxes                    create (templateID, timeout, autoPause, metadata)
 *   POST   /v2/sandboxes/{id}/connect       resume a paused sandbox
 *   POST   /sandboxes/{id}/pause            stop
 *   DELETE /sandboxes/{id}                  delete (kill)
 *   POST   https://49983-{id}.{domain}/process.Process/Start   run the start script
 *
 * The API takes `X-API-Key`; envd `X-Access-Token` (the sandbox's
 * envdAccessToken), as the SDK sends them. Process.Start is a Connect
 * server-streaming call: JSON messages in 5-byte envelopes (a flags byte, a
 * big-endian length), the last one flagged 0x02 with the call's outcome.
 */
import { providerHttp, type ProviderHttp } from "./http.js";
import { START_COMMAND, startCommandEnv } from "./start-script.js";
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
} from "./types.js";

export const ENVD_PORT = 49983;
/** The envd version from which the template's own default user applies (the SDK's ENVD_DEFAULT_USER). */
const ENVD_DEFAULT_USER = "0.4.0";
/** How long a sandbox lives when the connection sets no TTL. */
const DEFAULT_TIMEOUT_S = 60 * 60;

export interface E2bSandbox {
  sandboxID: string;
  templateID?: string;
  alias?: string;
  clientID?: string;
  state?: "running" | "paused" | string;
  envdVersion?: string;
  envdAccessToken?: string;
  domain?: string | null;
  metadata?: Record<string, string>;
}

interface E2bTemplate {
  templateID: string;
  aliases?: string[];
  names?: string[];
  description?: string;
  buildStatus?: string;
}

/** Where envd answers for a sandbox (tests point it at a fake). */
export type EnvdUrl = (sandboxId: string, domain: string) => string;
let envdUrl: EnvdUrl = (id, domain) => `https://${ENVD_PORT}-${id}.${domain}`;

/** Tests: reach envd somewhere else; returns the restore. */
export function setEnvdUrlForTests(next: EnvdUrl): () => void {
  const previous = envdUrl;
  envdUrl = next;
  return () => {
    envdUrl = previous;
  };
}

function toWorkspace(s: E2bSandbox): RemoteWorkspace {
  const running = s.state === undefined || s.state === "running";
  return {
    id: s.sandboxID,
    name: s.metadata?.optio_name || s.sandboxID,
    ownerId: null,
    ownerName: null,
    templateId: s.templateID ?? null,
    templateName: s.alias ?? s.templateID ?? null,
    templateVersionId: s.templateID ?? null,
    status: running ? "running" : s.state === "paused" ? "stopped" : String(s.state),
    transition: running ? "start" : "stop",
    ready: running,
    problem: null,
  };
}

const PARAMETERS: WorkspaceParameter[] = [
  {
    name: "repo_url",
    displayName: "Repository",
    description:
      "Cloned into the checkout when it is empty (the template's git credentials apply).",
    type: "string",
    mutable: true,
    required: false,
    defaultValue: null,
    ephemeral: false,
    options: [],
    setByOptio: false,
  },
];

function versionBelow(version: string | undefined, than: string): boolean {
  if (!version) return false;
  const a = version.split(".").map((n) => parseInt(n, 10) || 0);
  const b = than.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/** One Connect envelope around a JSON message. */
export function connectEnvelope(message: unknown, flags = 0): Uint8Array {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const out = Buffer.alloc(5 + body.length);
  out.writeUInt8(flags, 0);
  out.writeUInt32BE(body.length, 1);
  body.copy(out, 5);
  return out;
}

/** The envelopes in a Connect stream body. */
export function readEnvelopes(buf: Uint8Array): Array<{ flags: number; message: unknown }> {
  const b = Buffer.from(buf);
  const out: Array<{ flags: number; message: unknown }> = [];
  let off = 0;
  while (off + 5 <= b.length) {
    const flags = b.readUInt8(off);
    const len = b.readUInt32BE(off + 1);
    const raw = b.subarray(off + 5, off + 5 + len).toString("utf8");
    off += 5 + len;
    let message: unknown = null;
    try {
      message = raw ? JSON.parse(raw) : null;
    } catch {
      message = raw;
    }
    out.push({ flags, message });
  }
  return out;
}

export class E2bClient implements RemoteWorkspaceClient {
  private readonly http: ProviderHttp;

  constructor(private readonly target: ProviderTarget) {
    this.http = providerHttp("E2B", target, { "X-API-Key": target.token });
  }

  private templateList(limit = 100): Promise<E2bTemplate[]> {
    return this.http.json("GET", `/v2/templates?limit=${limit}`);
  }

  async whoami(): Promise<ProviderIdentity> {
    // An API key is a team's; E2B answers no "who am I" for one. A list it
    // may read is the proof it works.
    await this.templateList(1);
    return { id: null, username: "" };
  }

  async tokenExpiry(): Promise<Date | null> {
    return null;
  }

  async templates(organizationId?: string | null) {
    const list = (await this.templateList()) ?? [];
    return {
      organizationId: organizationId ?? "",
      templates: list
        .filter((t) => !t.buildStatus || t.buildStatus === "ready")
        .map((t) => ({
          id: t.templateID,
          name: t.aliases?.[0] ?? t.names?.[0] ?? t.templateID,
          displayName: t.names?.[0] ?? t.aliases?.[0] ?? null,
          description: t.description ?? null,
          organizationId: null,
          activeVersionId: t.templateID,
        })),
    };
  }

  async activeVersion(templateId: string): Promise<string> {
    return templateId;
  }

  async parameters(): Promise<WorkspaceParameter[]> {
    return PARAMETERS;
  }

  async workspaces(): Promise<RemoteWorkspace[]> {
    const list = await this.http.json<E2bSandbox[]>(
      "GET",
      `/v2/sandboxes?state=${encodeURIComponent("running,paused")}&limit=100`,
    );
    return (list ?? []).map(toWorkspace);
  }

  private sandbox(id: string): Promise<E2bSandbox> {
    return this.http.json("GET", `/sandboxes/${encodeURIComponent(id)}`);
  }

  async workspace(id: string): Promise<RemoteWorkspace> {
    return toWorkspace(await this.sandbox(id));
  }

  private timeoutS(ttlMs: number | null): number {
    return ttlMs ? Math.max(60, Math.round(ttlMs / 1000)) : DEFAULT_TIMEOUT_S;
  }

  async create(input: CreateWorkspaceInput): Promise<RemoteWorkspace> {
    const created = await this.http.json<E2bSandbox>("POST", "/v2/sandboxes", {
      templateID: input.templateVersionId,
      timeout: this.timeoutS(input.ttlMs),
      // At the end of its time a sandbox is paused, not killed, so a re-run can resume it.
      autoPause: true,
      metadata: { optio_name: input.name, optio_host_id: input.bundle.OPTIO_LOCAL_HOST_ID },
    });
    return toWorkspace({
      ...created,
      state: "running",
      metadata: { ...(created.metadata ?? {}), optio_name: input.name },
    });
  }

  async start(ws: RemoteWorkspace, input: PairingDelivery): Promise<void> {
    // Resumes a paused sandbox (and extends a running one's time); the
    // bundle goes in when the start script runs.
    await this.http.json("POST", `/v2/sandboxes/${encodeURIComponent(ws.id)}/connect`, {
      timeout: this.timeoutS(input.ttlMs),
    });
  }

  async stop(id: string): Promise<string> {
    try {
      await this.http.json("POST", `/sandboxes/${encodeURIComponent(id)}/pause`, {});
    } catch (err) {
      // Already paused.
      if (!(err instanceof RemoteWorkspaceError && err.status === 409)) throw err;
    }
    return "stopped";
  }

  async remove(id: string): Promise<string> {
    await this.http.json("DELETE", `/sandboxes/${encodeURIComponent(id)}`);
    return "deleted";
  }

  async runStartScript(ws: RemoteWorkspace, env: Record<string, string>): Promise<void> {
    const s = await this.sandbox(ws.id);
    const domain = s.domain || this.defaultDomain();
    const headers: Record<string, string> = {
      "Content-Type": "application/connect+json",
      "Connect-Protocol-Version": "1",
      "E2b-Sandbox-Id": s.sandboxID,
      "E2b-Sandbox-Port": String(ENVD_PORT),
      ...(s.envdAccessToken ? { "X-Access-Token": s.envdAccessToken } : {}),
      // Older envd needs the user named; newer ones use the template's.
      ...(versionBelow(s.envdVersion, ENVD_DEFAULT_USER)
        ? { Authorization: `Basic ${Buffer.from("user:").toString("base64")}` }
        : {}),
    };
    const res = await this.http.raw(
      `${envdUrl(s.sandboxID, domain).replace(/\/+$/, "")}/process.Process/Start`,
      {
        method: "POST",
        headers,
        body: connectEnvelope({
          process: {
            cmd: "/bin/bash",
            args: ["-l", "-c", START_COMMAND],
            envs: startCommandEnv(env),
          },
          stdin: false,
        }),
      },
      { timeoutMs: 60_000 },
    );
    if (!res.ok) {
      throw new RemoteWorkspaceError(
        `E2B's envd answered ${res.status} to the start script in ${ws.name}`,
        502,
      );
    }
    const frames = readEnvelopes(new Uint8Array(await res.arrayBuffer()));
    const trailer = frames.find((f) => f.flags & 0x02)?.message as
      | { error?: { code?: string; message?: string } }
      | undefined;
    if (trailer?.error) {
      throw new RemoteWorkspaceError(
        `envd refused the start script in ${ws.name}: ${trailer.error.message ?? trailer.error.code}`,
        502,
      );
    }
    const end = frames
      .map((f) => (f.message as { event?: { end?: { exitCode?: number; error?: string } } })?.event)
      .find((e) => e?.end)?.end;
    if (end && ((end.exitCode ?? 0) !== 0 || end.error)) {
      throw new RemoteWorkspaceError(
        `The start script failed in ${ws.name} (exit ${end.exitCode ?? "?"})${end.error ? `: ${end.error}` : ""}`,
        502,
      );
    }
  }

  /** The sandboxes' domain when the API doesn't say: the API's own, without `api.` (api.e2b.app → e2b.app). */
  private defaultDomain(): string {
    try {
      return new URL(this.target.url).host.replace(/^api\./, "");
    } catch {
      return "e2b.app";
    }
  }
}

export const e2bProvider: RemoteWorkspaceProvider = {
  id: "e2b",
  client: (target) => new E2bClient(target),
  checksOwner: false,
  defaultCheckoutDir: () => "/home/user/repo",
};
