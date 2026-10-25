/**
 * GitHub Codespaces (https://docs.github.com/en/rest/codespaces, API version
 * 2022-11-28): a codespace of a repository. GitHub runs nothing in a
 * codespace on another's behalf, so the bundle travels as a Codespaces user
 * secret named for the codespace, `OPTIO_PAIRING_<NAME>` (the codespace's
 * name in capitals, `-` as `_`), restricted to its repository; the
 * repository's devcontainer reads it in its postStartCommand and runs the
 * start script (examples/remote-workspaces/codespaces). The secret is
 * deleted once the daemon said hello, and when the pairing ends.
 *
 *   GET    /user                                          the Test; the token's owner
 *   GET    /user/repos, /orgs/{org}/repos                 "templates" (repositories)
 *   GET    /repos/{o}/{r}/codespaces/machines             the machine types (a parameter)
 *   GET    /repos/{o}/{r}/codespaces/devcontainers        the dev container configurations
 *   GET    /user/codespaces, /user/codespaces/{name}      existing codespaces; state
 *   POST   /repos/{o}/{r}/codespaces                      create
 *   POST   /user/codespaces/{name}/start | /stop          start / stop
 *   DELETE /user/codespaces/{name}                        delete
 *   GET    /user/codespaces/secrets/public-key            the key secrets are sealed with
 *   PUT    /user/codespaces/secrets/{secret}              the pairing secret (sealed box, sealed-box.ts)
 *   DELETE /user/codespaces/secrets/{secret}              … gone
 *
 * Secrets reach a codespace when it starts (GitHub: "available when you
 * create a new codespace or restart the codespace"). For an existing
 * codespace Optio writes the secret before starting it; a new one's name is
 * known only once GitHub accepted it, so Optio writes it right after the
 * create, while GitHub still provisions the codespace. A codespace that came
 * up before its secret doesn't pair: the start timeout fails the run with
 * the reason, and a re-run (a restart) picks the secret up.
 */
import { providerHttp, type ProviderHttp } from "./http.js";
import { sealedBox } from "./sealed-box.js";
import { shellExports } from "./start-script.js";
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

/** How long a restart waits for the codespace to stop. */
const STOP_WAIT_MS = 2 * 60_000;
let pollMs = 3_000;

/** Tests: poll faster; returns the restore. */
export function setCodespacesPollMsForTests(ms: number): () => void {
  const previous = pollMs;
  pollMs = ms;
  return () => {
    pollMs = previous;
  };
}

export interface GitHubCodespace {
  id: number;
  name: string;
  display_name?: string | null;
  owner: { id: number; login: string };
  repository: { id: number; full_name: string; name?: string };
  machine?: { name?: string; display_name?: string } | null;
  state: string;
  devcontainer_path?: string | null;
  idle_timeout_minutes?: number | null;
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description?: string | null;
  owner?: { login: string };
  default_branch?: string;
}

/** GitHub's codespace states, onto the words the rest of Optio uses. */
const STATUS: Record<string, string> = {
  Available: "running",
  Shutdown: "stopped",
  ShuttingDown: "stopping",
  Failed: "failed",
  Unavailable: "failed",
  Deleted: "deleted",
  Archived: "deleted",
};

export function codespaceStatus(state: string): string {
  return STATUS[state] ?? "starting";
}

/** The secret a codespace's pairing bundle travels in. */
export function pairingSecretName(codespaceName: string): string {
  return `OPTIO_PAIRING_${codespaceName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** "owner/repo" from a repository URL on any GitHub host (null: not one). */
export function repositoryOf(url: string | null | undefined): string | null {
  if (!url?.trim()) return null;
  const ssh = url.trim().match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  try {
    const parts = new URL(url.trim()).pathname
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean);
    return parts.length === 2 ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return /^[\w.-]+\/[\w.-]+$/.test(url.trim()) ? url.trim() : null;
  }
}

function toWorkspace(c: GitHubCodespace): RemoteWorkspace {
  const status = codespaceStatus(c.state);
  return {
    id: c.name,
    name: c.name,
    ownerId: String(c.owner.id),
    ownerName: c.owner.login,
    templateId: c.repository.full_name,
    templateName: c.repository.full_name,
    templateVersionId: c.repository.full_name,
    status,
    transition: status === "stopped" || status === "stopping" ? "stop" : "start",
    ready: c.state === "Available",
    problem:
      status === "failed"
        ? `The codespace ${c.display_name || c.name} is ${c.state}`
        : status === "deleted"
          ? `The codespace ${c.display_name || c.name} was ${c.state.toLowerCase()}`
          : null,
  };
}

const repoPath = (fullName: string) =>
  fullName
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");

export class CodespacesClient implements RemoteWorkspaceClient {
  private readonly http: ProviderHttp;

  constructor(private readonly target: ProviderTarget) {
    this.http = providerHttp("GitHub", target, {
      Authorization: `Bearer ${target.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  }

  async whoami(): Promise<ProviderIdentity> {
    const me = await this.http.json<{ id: number; login: string; email?: string | null }>(
      "GET",
      "/user",
    );
    return { id: String(me.id), username: me.login, ...(me.email ? { email: me.email } : {}) };
  }

  /** GitHub names a token's expiry in a header of every answer (`github-authentication-token-expiration`). */
  async tokenExpiry(): Promise<Date | null> {
    const res = await this.http.raw(`${this.target.url.replace(/\/+$/, "")}/user`, {
      method: "GET",
    });
    if (!res.ok) {
      throw new RemoteWorkspaceError(
        `GitHub answered ${res.status} to GET /user`,
        res.status === 401 || res.status === 403 ? 403 : 502,
      );
    }
    const header = res.headers.get("github-authentication-token-expiration");
    await res.arrayBuffer().catch(() => undefined);
    if (!header) return null;
    const at = new Date(header.replace(" UTC", "Z").replace(" ", "T"));
    return Number.isNaN(at.getTime()) ? null : at;
  }

  async templates(organizationId?: string | null) {
    const org = organizationId || this.target.organizationId || null;
    const repos = await this.http.json<GitHubRepo[]>(
      "GET",
      org
        ? `/orgs/${encodeURIComponent(org)}/repos?per_page=100&sort=pushed`
        : "/user/repos?per_page=100&sort=pushed",
    );
    return {
      organizationId: org ?? "",
      templates: (repos ?? []).map(
        (r): WorkspaceTemplate => ({
          id: r.full_name,
          name: r.full_name,
          displayName: null,
          description: r.description ?? null,
          organizationId: r.owner?.login ?? null,
          activeVersionId: r.full_name,
        }),
      ),
    };
  }

  async activeVersion(templateId: string): Promise<string> {
    return templateId;
  }

  /** A repository's machine types and dev container configurations, and the branch. */
  async parameters(repository: string): Promise<WorkspaceParameter[]> {
    const ref: WorkspaceParameter = {
      name: "ref",
      displayName: "Branch",
      description: "The branch the codespace checks out; blank = the default branch.",
      type: "string",
      mutable: false,
      required: false,
      defaultValue: null,
      ephemeral: false,
      options: [],
      setByOptio: false,
    };
    if (!repositoryOf(repository)) return [ref];
    const path = repoPath(repository);
    const [machines, devcontainers] = await Promise.all([
      this.http.json<{
        machines?: Array<{ name: string; display_name?: string }>;
      }>("GET", `/repos/${path}/codespaces/machines`),
      this.http
        .json<{
          devcontainers?: Array<{ path: string; name?: string; display_name?: string }>;
        }>("GET", `/repos/${path}/codespaces/devcontainers?per_page=100`)
        .catch(() => ({ devcontainers: [] })),
    ]);
    const params: WorkspaceParameter[] = [ref];
    if (machines?.machines?.length) {
      params.push({
        name: "machine",
        displayName: "Machine type",
        description: null,
        type: "string",
        mutable: false,
        required: false,
        defaultValue: null,
        ephemeral: false,
        options: machines.machines.map((m) => ({
          name: m.display_name || m.name,
          value: m.name,
          description: null,
        })),
        setByOptio: false,
      });
    }
    if (devcontainers?.devcontainers?.length) {
      params.push({
        name: "devcontainer_path",
        displayName: "Dev container",
        description: "The configuration whose postStartCommand pairs the codespace.",
        type: "string",
        mutable: false,
        required: false,
        defaultValue: null,
        ephemeral: false,
        options: devcontainers.devcontainers.map((d) => ({
          name: d.display_name || d.name || d.path,
          value: d.path,
          description: null,
        })),
        setByOptio: false,
      });
    }
    return params;
  }

  async workspaces(): Promise<RemoteWorkspace[]> {
    const page = await this.http.json<{ codespaces?: GitHubCodespace[] }>(
      "GET",
      "/user/codespaces?per_page=100",
    );
    return (page?.codespaces ?? []).map(toWorkspace);
  }

  private codespace(name: string): Promise<GitHubCodespace> {
    return this.http.json("GET", `/user/codespaces/${encodeURIComponent(name)}`);
  }

  async workspace(name: string): Promise<RemoteWorkspace> {
    return toWorkspace(await this.codespace(name));
  }

  /** Seal the start script's environment into the codespace's own secret. */
  private async writeSecret(
    codespace: GitHubCodespace,
    env: Record<string, string>,
  ): Promise<void> {
    const key = await this.http.json<{ key_id: string; key: string }>(
      "GET",
      "/user/codespaces/secrets/public-key",
    );
    const value = Buffer.from(shellExports(env), "utf8").toString("base64");
    const sealed = sealedBox(
      new TextEncoder().encode(value),
      new Uint8Array(Buffer.from(key.key, "base64")),
    );
    await this.http.json("PUT", `/user/codespaces/secrets/${pairingSecretName(codespace.name)}`, {
      encrypted_value: Buffer.from(sealed).toString("base64"),
      key_id: key.key_id,
      selected_repository_ids: [codespace.repository.id],
    });
  }

  async create(input: CreateWorkspaceInput): Promise<RemoteWorkspace> {
    const repository = repositoryOf(input.templateVersionId);
    if (!repository) {
      throw new RemoteWorkspaceError(
        `"${input.templateVersionId}" isn't a repository (owner/name)`,
      );
    }
    const w = input.wanted;
    const idle = input.ttlMs ? Math.round(input.ttlMs / 60_000) : 240;
    const codespace = await this.http.json<GitHubCodespace>(
      "POST",
      `/repos/${repoPath(repository)}/codespaces`,
      {
        ...(w.ref?.trim() ? { ref: w.ref.trim() } : {}),
        ...(w.machine?.trim() ? { machine: w.machine.trim() } : {}),
        ...(w.devcontainer_path?.trim() ? { devcontainer_path: w.devcontainer_path.trim() } : {}),
        display_name: input.name,
        idle_timeout_minutes: Math.min(240, Math.max(5, idle)),
      },
    );
    try {
      await this.writeSecret(codespace, { ...input.env, OPTIO_LOCAL_HOSTNAME: codespace.name });
    } catch (err) {
      // A codespace that can't pair is no use: it goes, and the start fails.
      await this.remove(codespace.name).catch(() => undefined);
      throw err;
    }
    return toWorkspace(codespace);
  }

  async start(ws: RemoteWorkspace, input: PairingDelivery): Promise<void> {
    const codespace = await this.codespace(ws.id);
    await this.writeSecret(codespace, { ...input.env, OPTIO_LOCAL_HOSTNAME: codespace.name });
    if (codespace.state !== "Shutdown") {
      // Running (or on its way up or down): secrets reach it on a restart
      // only, so it stops first.
      if (codespace.state !== "ShuttingDown") {
        await this.http.json("POST", `/user/codespaces/${encodeURIComponent(ws.id)}/stop`);
      }
      await this.waitFor(ws.id, "Shutdown");
    }
    await this.http.json("POST", `/user/codespaces/${encodeURIComponent(ws.id)}/start`);
  }

  /** Poll until the codespace is in `state` (a stop takes GitHub a few seconds). */
  private async waitFor(name: string, state: string): Promise<void> {
    const deadline = Date.now() + STOP_WAIT_MS;
    for (;;) {
      const c = await this.codespace(name);
      if (c.state === state) return;
      if (Date.now() >= deadline) {
        throw new RemoteWorkspaceError(
          `The codespace ${c.display_name || name} is still ${c.state}; start it again in a moment`,
          409,
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async stop(name: string): Promise<string> {
    const c = await this.http.json<GitHubCodespace | null>(
      "POST",
      `/user/codespaces/${encodeURIComponent(name)}/stop`,
    );
    return codespaceStatus(c?.state ?? "ShuttingDown");
  }

  async remove(name: string): Promise<string> {
    await this.http.json("DELETE", `/user/codespaces/${encodeURIComponent(name)}`);
    return "deleted";
  }

  async releasePairing(ws: { id: string; name: string }): Promise<void> {
    try {
      await this.http.json("DELETE", `/user/codespaces/secrets/${pairingSecretName(ws.id)}`);
    } catch (err) {
      if (!(err instanceof RemoteWorkspaceError && err.status === 404)) throw err;
    }
  }
}

export const codespacesProvider: RemoteWorkspaceProvider = {
  id: "codespaces",
  client: (target) => new CodespacesClient(target),
  checksOwner: true,
  releasesPairing: true,
  templateFromParameters: (parameters) => repositoryOf(parameters.repo_url),
  defaultCheckoutDir: ({ templateId, parameters }) => {
    const repository = repositoryOf(parameters.repo_url) ?? repositoryOf(templateId);
    return repository ? `/workspaces/${repository.split("/")[1]}` : "/workspaces";
  },
};
