/**
 * Daytona (https://www.daytona.io/docs/en/tools/api/; the OpenAPI documents
 * at /docs/openapi.json and /docs/toolbox-openapi.json): a sandbox made from
 * a snapshot. Optio starts its daemon with the start script (start-script.ts)
 * through the sandbox's toolbox once the sandbox has started: the bundle is
 * in the command's environment, never in the sandbox's own `env` (which the
 * API returns to anyone holding the key).
 *
 *   GET    /api-keys/current                        the Test; the key's expiry
 *   GET    /snapshots                               "templates"
 *   GET    /sandbox, GET /sandbox/{id}              existing sandboxes; state
 *   POST   /sandbox                                 create (snapshot, name, labels, autoStopInterval)
 *   POST   /sandbox/{id}/start | /stop              start / stop
 *   DELETE /sandbox/{id}                            delete
 *   POST   {toolboxProxyUrl}/{id}/process/execute   run the start script
 *
 * `Authorization: Bearer <API key>`, and `X-Daytona-Organization-ID` when
 * the connection names an organization.
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

export interface DaytonaSandbox {
  id: string;
  name?: string;
  organizationId?: string;
  snapshot?: string;
  user?: string;
  state?: string;
  desiredState?: string;
  errorReason?: string;
  labels?: Record<string, string>;
  toolboxProxyUrl?: string;
}

interface DaytonaSnapshot {
  id: string;
  name: string;
  state?: string;
  imageName?: string;
  general?: boolean;
}

interface DaytonaApiKey {
  name: string;
  userId?: string;
  organizationId?: string;
  expiresAt?: string | null;
}

/** Daytona's sandbox states, onto the words the rest of Optio uses. */
const STATUS: Record<string, string> = {
  started: "running",
  stopped: "stopped",
  archived: "stopped",
  paused: "stopped",
  stopping: "stopping",
  archiving: "stopping",
  pausing: "stopping",
  error: "failed",
  build_failed: "failed",
  destroyed: "deleted",
  destroying: "deleted",
};

export function daytonaStatus(state: string | undefined): string {
  return STATUS[state ?? ""] ?? "starting";
}

function toWorkspace(s: DaytonaSandbox): RemoteWorkspace {
  const status = daytonaStatus(s.state);
  const name = s.name || s.id;
  const reason = s.errorReason ? `: ${s.errorReason}` : "";
  return {
    id: s.id,
    name,
    ownerId: null,
    ownerName: null,
    templateId: s.snapshot ?? null,
    templateName: s.snapshot ?? null,
    templateVersionId: s.snapshot ?? null,
    status,
    transition: s.desiredState === "stopped" ? "stop" : "start",
    ready: s.state === "started",
    problem:
      status === "failed"
        ? `The Daytona sandbox ${name} is in ${s.state}${reason}`
        : status === "deleted"
          ? `The Daytona sandbox ${name} was deleted`
          : null,
  };
}

/** The parameters a new sandbox takes (Daytona snapshots declare none of their own). */
const PARAMETERS: WorkspaceParameter[] = [
  {
    name: "repo_url",
    displayName: "Repository",
    description: "Cloned into the checkout when it is empty (the image's git credentials apply).",
    type: "string",
    mutable: true,
    required: false,
    defaultValue: null,
    ephemeral: false,
    options: [],
    setByOptio: false,
  },
  {
    name: "target",
    displayName: "Region",
    description: "Where the sandbox runs (e.g. us, eu); blank = the organization's default.",
    type: "string",
    mutable: false,
    required: false,
    defaultValue: null,
    ephemeral: false,
    options: [],
    setByOptio: false,
  },
];

export class DaytonaClient implements RemoteWorkspaceClient {
  private readonly http: ProviderHttp;

  constructor(private readonly target: ProviderTarget) {
    this.http = providerHttp("Daytona", target, {
      Authorization: `Bearer ${target.token}`,
      ...(target.organizationId ? { "X-Daytona-Organization-ID": target.organizationId } : {}),
    });
  }

  private key(): Promise<DaytonaApiKey> {
    return this.http.json("GET", "/api-keys/current");
  }

  async whoami(): Promise<ProviderIdentity> {
    const key = await this.key();
    return { id: key.userId ?? null, username: `API key ${key.name}` };
  }

  async tokenExpiry(): Promise<Date | null> {
    const at = (await this.key()).expiresAt;
    const date = at ? new Date(at) : null;
    return date && !Number.isNaN(date.getTime()) ? date : null;
  }

  async templates(organizationId?: string | null) {
    const page = await this.http.json<{ items?: DaytonaSnapshot[] } | DaytonaSnapshot[]>(
      "GET",
      "/snapshots?limit=200&sort=name&order=asc",
    );
    const items = Array.isArray(page) ? page : (page?.items ?? []);
    return {
      organizationId: organizationId ?? this.target.organizationId ?? "",
      templates: items
        .filter((s) => !s.state || s.state === "active")
        .map((s) => ({
          id: s.name,
          name: s.name,
          displayName: null,
          description: s.imageName ?? null,
          organizationId: organizationId ?? this.target.organizationId ?? null,
          activeVersionId: s.name,
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
    const page = await this.http.json<{ items?: DaytonaSandbox[] } | DaytonaSandbox[]>(
      "GET",
      "/sandbox?limit=100",
    );
    return (Array.isArray(page) ? page : (page?.items ?? [])).map(toWorkspace);
  }

  private sandbox(id: string): Promise<DaytonaSandbox> {
    return this.http.json("GET", `/sandbox/${encodeURIComponent(id)}`);
  }

  async workspace(id: string): Promise<RemoteWorkspace> {
    return toWorkspace(await this.sandbox(id));
  }

  async create(input: CreateWorkspaceInput): Promise<RemoteWorkspace> {
    const target = input.wanted.target?.trim();
    const sandbox = await this.http.json<DaytonaSandbox>("POST", "/sandbox", {
      name: input.name,
      snapshot: input.templateVersionId,
      labels: { "optio-host-id": input.bundle.OPTIO_LOCAL_HOST_ID },
      // Minutes without activity; 0 = never (Optio stops it when the work ends).
      autoStopInterval: input.ttlMs ? Math.max(1, Math.round(input.ttlMs / 60_000)) : 0,
      ...(target ? { target } : {}),
    });
    return toWorkspace(sandbox);
  }

  async start(ws: RemoteWorkspace, _input: PairingDelivery): Promise<void> {
    // The bundle goes in when it runs the start script (once it has started).
    if (ws.status === "running") return;
    await this.http.json("POST", `/sandbox/${encodeURIComponent(ws.id)}/start`);
  }

  async stop(id: string): Promise<string> {
    const s = await this.http.json<DaytonaSandbox | null>(
      "POST",
      `/sandbox/${encodeURIComponent(id)}/stop`,
    );
    return daytonaStatus(s?.state ?? "stopping");
  }

  async remove(id: string): Promise<string> {
    const s = await this.http.json<DaytonaSandbox | null>(
      "DELETE",
      `/sandbox/${encodeURIComponent(id)}`,
    );
    return daytonaStatus(s?.state ?? "destroying");
  }

  /** The toolbox's execute endpoint: through the sandbox's toolbox proxy, else the API's own route. */
  private async executeUrl(id: string): Promise<string> {
    const s = await this.sandbox(id);
    const proxy = s.toolboxProxyUrl?.replace(/\/+$/, "");
    const enc = encodeURIComponent(id);
    return proxy
      ? `${proxy}/${enc}/process/execute`
      : `${this.target.url.replace(/\/+$/, "")}/toolbox/${enc}/toolbox/process/execute`;
  }

  async runStartScript(ws: RemoteWorkspace, env: Record<string, string>): Promise<void> {
    const url = await this.executeUrl(ws.id);
    const res = await this.http.raw(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        command: `sh -c '${START_COMMAND}'`,
        envs: startCommandEnv(env),
        timeout: 60,
      }),
    });
    if (!res.ok) {
      throw new RemoteWorkspaceError(
        `Daytona answered ${res.status} to the start script in ${ws.name}`,
        res.status === 404 ? 404 : 502,
      );
    }
    const out = (await res.json().catch(() => ({}))) as { exitCode?: number; result?: string };
    if (out.exitCode && out.exitCode !== 0) {
      throw new RemoteWorkspaceError(
        `The start script failed in ${ws.name} (exit ${out.exitCode}): ${(out.result ?? "").slice(0, 300)}`,
        502,
      );
    }
  }
}

export const daytonaProvider: RemoteWorkspaceProvider = {
  id: "daytona",
  client: (target) => new DaytonaClient(target),
  checksOwner: false,
  defaultCheckoutDir: () => "/home/daytona/repo",
};
