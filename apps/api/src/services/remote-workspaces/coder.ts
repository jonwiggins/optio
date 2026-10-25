/**
 * Coder (https://coder.com/docs/reference/api): a workspace made from a
 * template. The pairing bundle travels as the template's rich parameters
 * (`optio_server`, `optio_token`, `optio_host_id`, and `optio_checkout_dir`
 * when it declares it), and the template's startup script starts Optio's
 * daemon (docs/remote-workspaces.md, "Coder"; examples/coder/optio-workspace).
 */
import { parseIntEnv } from "@optio/shared";
import { guardedFetch } from "../../utils/outbound-url.js";
import {
  RemoteWorkspaceError,
  type CreateWorkspaceInput,
  type PairingBundle,
  type PairingDelivery,
  type ProviderIdentity,
  type ProviderTarget,
  type RemoteWorkspace,
  type RemoteWorkspaceClient,
  type RemoteWorkspaceProvider,
  type WorkspaceParameter,
  type WorkspaceTemplate,
} from "./types.js";

// ── The Coder REST API ──────────────────────────────────────────────────────

export type CoderTarget = ProviderTarget;

export interface CoderUser {
  id: string;
  username: string;
  email?: string;
  name?: string;
}

export interface CoderOrganization {
  id: string;
  name: string;
  display_name?: string;
  is_default?: boolean;
}

export interface CoderTemplate {
  id: string;
  name: string;
  display_name?: string;
  description?: string;
  organization_id?: string;
  active_version_id: string;
}

export interface CoderRichParameter {
  name: string;
  display_name?: string;
  description?: string;
  type: string;
  mutable: boolean;
  default_value?: string;
  required?: boolean;
  ephemeral?: boolean;
  options?: Array<{ name: string; value: string; description?: string }>;
}

export interface CoderAgent {
  id?: string;
  name?: string;
  status: string;
  lifecycle_state?: string;
}

export interface CoderBuild {
  id: string;
  status: string;
  transition: string;
  template_version_id: string;
  job?: { status?: string; error?: string };
  resources?: Array<{ agents?: CoderAgent[] }>;
}

export interface CoderWorkspace {
  id: string;
  name: string;
  owner_id?: string;
  owner_name?: string;
  template_id?: string;
  template_name?: string;
  template_display_name?: string;
  latest_build: CoderBuild;
}

export interface RichParameterValue {
  name: string;
  value: string;
}

export type CoderTransition = "start" | "stop" | "delete";

const REQUEST_TIMEOUT_MS = 15_000;
/** Build states a start never comes back from on its own. */
const DEAD_BUILD = new Set(["failed", "canceled", "deleted", "deleting"]);

/** How long a start may take before the watcher gives up (every provider's). */
export function remoteWorkspaceStartTimeoutMs(): number {
  return Math.max(
    60_000,
    parseIntEnv(
      "OPTIO_REMOTE_WORKSPACE_START_TIMEOUT_MS",
      parseIntEnv("OPTIO_CODER_START_TIMEOUT_MS", 15 * 60_000),
    ),
  );
}

/**
 * One Coder deployment as one user (the session token). Every request goes
 * through the outbound guard (`OPTIO_OUTBOUND_ALLOWED_HOSTS` must let the
 * Coder host through) with the connection's CA, and never follows a
 * redirect — the token travels in a header the guard doesn't strip.
 */
export class CoderClient {
  constructor(private readonly target: CoderTarget) {}

  private get base(): string {
    return this.target.url.replace(/\/+$/, "");
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await guardedFetch(`${this.base}${path}`, {
        method,
        headers: {
          "Coder-Session-Token": this.target.token,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        timeoutMs: REQUEST_TIMEOUT_MS,
        tls: {
          ca: this.target.caPem,
          ...(this.target.insecureSkipVerify ? { rejectUnauthorized: false } : {}),
        },
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new RemoteWorkspaceError(`Couldn't reach Coder at ${hostOf(this.base)}: ${why}`, 502);
    }
    if (!res.ok) {
      let detail = "";
      try {
        const json = (await res.json()) as { message?: string; detail?: string };
        detail = [json.message, json.detail].filter(Boolean).join(" — ");
      } catch {
        // not JSON
      }
      const status =
        res.status === 401 || res.status === 403 ? 403 : res.status === 404 ? 404 : 502;
      throw new RemoteWorkspaceError(
        `Coder answered ${res.status} to ${method} ${path.split("?")[0]}${detail ? `: ${detail}` : ""}`,
        status,
      );
    }
    return (await res.json()) as T;
  }

  me(): Promise<CoderUser> {
    return this.call("GET", "/api/v2/users/me");
  }

  /**
   * The session token's own API key (`GET /users/me/keys/<id>`; a token is
   * `<id>-<secret>`): when it expires. Null for a token of another shape.
   * Credential health reads it (services/credential-health/checks.ts).
   */
  async ownKey(): Promise<{ expires_at?: string | null; token_name?: string } | null> {
    const id = this.target.token.split("-")[0];
    if (!id || id === this.target.token) return null;
    return this.call("GET", `/api/v2/users/me/keys/${encodeURIComponent(id)}`);
  }

  organizations(): Promise<CoderOrganization[]> {
    return this.call("GET", "/api/v2/organizations");
  }

  templates(organizationId: string): Promise<CoderTemplate[]> {
    return this.call(
      "GET",
      `/api/v2/organizations/${encodeURIComponent(organizationId)}/templates`,
    );
  }

  template(id: string): Promise<CoderTemplate> {
    return this.call("GET", `/api/v2/templates/${encodeURIComponent(id)}`);
  }

  richParameters(templateVersionId: string): Promise<CoderRichParameter[]> {
    return this.call(
      "GET",
      `/api/v2/templateversions/${encodeURIComponent(templateVersionId)}/rich-parameters`,
    );
  }

  async workspaces(): Promise<CoderWorkspace[]> {
    const page = await this.call<{ workspaces?: CoderWorkspace[] }>(
      "GET",
      `/api/v2/workspaces?q=${encodeURIComponent("owner:me")}`,
    );
    return page.workspaces ?? [];
  }

  workspace(id: string): Promise<CoderWorkspace> {
    return this.call("GET", `/api/v2/workspaces/${encodeURIComponent(id)}`);
  }

  createWorkspace(input: {
    templateVersionId: string;
    name: string;
    ttlMs?: number | null;
    richParameterValues: RichParameterValue[];
  }): Promise<CoderWorkspace> {
    return this.call("POST", "/api/v2/users/me/workspaces", {
      template_version_id: input.templateVersionId,
      name: input.name,
      ...(input.ttlMs ? { ttl_ms: input.ttlMs } : {}),
      rich_parameter_values: input.richParameterValues,
    });
  }

  build(
    workspaceId: string,
    transition: CoderTransition,
    richParameterValues?: RichParameterValue[],
  ): Promise<CoderBuild> {
    return this.call("POST", `/api/v2/workspaces/${encodeURIComponent(workspaceId)}/builds`, {
      transition,
      ...(richParameterValues?.length ? { rich_parameter_values: richParameterValues } : {}),
    });
  }

  /**
   * Polls the workspace until its latest build is running and every agent is
   * connected; fails as soon as the build can't get there.
   */
  async waitForRunning(
    workspaceId: string,
    opts: {
      timeoutMs?: number;
      pollMs?: number;
      signal?: AbortSignal;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ): Promise<CoderWorkspace> {
    const deadline = Date.now() + (opts.timeoutMs ?? remoteWorkspaceStartTimeoutMs());
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (;;) {
      if (opts.signal?.aborted) {
        throw new RemoteWorkspaceError("Stopped waiting for the workspace", 409);
      }
      const ws = await this.workspace(workspaceId);
      const problem = buildProblem(ws);
      if (problem) throw new RemoteWorkspaceError(problem, 409);
      if (ws.latest_build.status === "running" && agentsConnected(ws)) return ws;
      if (Date.now() >= deadline) {
        throw new RemoteWorkspaceError(
          `The Coder workspace ${ws.name} is still ${ws.latest_build.status} after ${minutes(
            opts.timeoutMs ?? remoteWorkspaceStartTimeoutMs(),
          )}`,
          409,
        );
      }
      await sleep(opts.pollMs ?? 3_000);
    }
  }
}

/** Every agent of the latest build reports connected (a build with none counts as not yet). */
export function agentsConnected(ws: CoderWorkspace): boolean {
  const agents = (ws.latest_build.resources ?? []).flatMap((r) => r.agents ?? []);
  return agents.length > 0 && agents.every((a) => a.status === "connected");
}

/** Why a workspace that should be starting never will, or null. */
export function buildProblem(ws: CoderWorkspace): string | null {
  const b = ws.latest_build;
  const error = b.job?.error ? `: ${b.job.error}` : "";
  if (DEAD_BUILD.has(b.status)) return `The Coder workspace ${ws.name}'s build ${b.status}${error}`;
  if (b.transition === "start" && b.status === "stopped") {
    return `The Coder workspace ${ws.name} stopped instead of starting${error}`;
  }
  return null;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

// ── The bundle as the template's parameters ─────────────────────────────────

/** The template's parameters the bundle travels in (docs/remote-workspaces.md, "Coder"). */
export const PAIRING_PARAMETERS = {
  OPTIO_SERVER: "optio_server",
  OPTIO_TOKEN: "optio_token",
  OPTIO_LOCAL_HOST_ID: "optio_host_id",
} as const;
export const CHECKOUT_PARAMETER = "optio_checkout_dir";
export const DEFAULT_CHECKOUT_DIR = "/home/coder/repo";

/** The parameters Optio fills; the forms leave them out. */
export const OPTIO_FILLED = new Set([
  "optio_server",
  "optio_token",
  "optio_host_id",
  "optio_checkout_dir",
]);

/**
 * The rich parameter values for a build: the bundle in the template's
 * pairing parameters, the checkout, and the wanted values the template
 * declares (Coder refuses values it doesn't declare). On an existing
 * workspace only mutable parameters may change.
 */
export function parameterValues(
  declared: Array<CoderRichParameter | WorkspaceParameter>,
  wanted: Record<string, string>,
  bundle: PairingBundle,
  opts: { checkoutDir: string; existing?: boolean; templateName?: string },
): RichParameterValue[] {
  const byName = new Map(declared.map((p) => [p.name, p]));
  const template = opts.templateName ? `The template ${opts.templateName}` : "The template";
  const token = byName.get(PAIRING_PARAMETERS.OPTIO_TOKEN);
  if (!token) {
    throw new RemoteWorkspaceError(
      `${template} has no ${PAIRING_PARAMETERS.OPTIO_TOKEN} parameter, so its workspaces can't pair ` +
        "with Optio — add optio_server, optio_token and optio_host_id (docs/remote-workspaces.md, " +
        `"Coder")`,
    );
  }
  if (opts.existing && !token.mutable) {
    throw new RemoteWorkspaceError(
      `${template}'s ${PAIRING_PARAMETERS.OPTIO_TOKEN} parameter isn't mutable, so an existing ` +
        "workspace can't get a new pairing token — make it `mutable = true`",
    );
  }
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(wanted)) {
    if (byName.has(name)) values.set(name, value);
  }
  if (byName.has(CHECKOUT_PARAMETER)) values.set(CHECKOUT_PARAMETER, opts.checkoutDir);
  for (const [key, name] of Object.entries(PAIRING_PARAMETERS)) {
    if (byName.has(name)) values.set(name, bundle[key as keyof PairingBundle]);
  }
  return [...values]
    .filter(([name]) => !opts.existing || byName.get(name)!.mutable)
    .map(([name, value]) => ({ name, value }));
}

// ── As a provider ───────────────────────────────────────────────────────────

function toWorkspace(ws: CoderWorkspace): RemoteWorkspace {
  return {
    id: ws.id,
    name: ws.name,
    ownerId: ws.owner_id ?? null,
    ownerName: ws.owner_name ?? null,
    templateId: ws.template_id ?? null,
    templateName: ws.template_display_name || ws.template_name || null,
    templateVersionId: ws.latest_build.template_version_id,
    status: ws.latest_build.status,
    transition: ws.latest_build.transition,
    ready: ws.latest_build.status === "running" && agentsConnected(ws),
    problem: buildProblem(ws),
  };
}

function toParameter(p: CoderRichParameter): WorkspaceParameter {
  return {
    name: p.name,
    displayName: p.display_name || null,
    description: p.description || null,
    type: p.type,
    mutable: p.mutable,
    required: p.required ?? false,
    defaultValue: p.default_value ?? null,
    ephemeral: p.ephemeral ?? false,
    options: (p.options ?? []).map((o) => ({
      name: o.name,
      value: o.value,
      description: o.description || null,
    })),
    setByOptio: OPTIO_FILLED.has(p.name),
  };
}

/** The Coder REST client as a provider's client. */
export class CoderProviderClient implements RemoteWorkspaceClient {
  readonly api: CoderClient;

  constructor(target: CoderTarget) {
    this.api = new CoderClient(target);
  }

  async whoami(): Promise<ProviderIdentity> {
    const me = await this.api.me();
    return { id: me.id, username: me.username, email: me.email };
  }

  async tokenExpiry(): Promise<Date | null> {
    try {
      const key = await this.api.ownKey();
      const at = key?.expires_at ? new Date(key.expires_at) : null;
      // Coder writes a far-future date for a token that never expires.
      if (at && !Number.isNaN(at.getTime()) && at.getUTCFullYear() < 9000) return at;
    } catch {
      // An older Coder, or a token it doesn't list: no expiry to show.
    }
    return null;
  }

  async templates(organizationId?: string | null) {
    let org = organizationId || null;
    if (!org) {
      const orgs = await this.api.organizations();
      org = (orgs.find((o) => o.is_default) ?? orgs[0])?.id ?? null;
      if (!org) throw new RemoteWorkspaceError("No Coder organization", 404);
    }
    const templates = await this.api.templates(org);
    return {
      organizationId: org,
      templates: templates.map(
        (t): WorkspaceTemplate => ({
          id: t.id,
          name: t.name,
          displayName: t.display_name || null,
          description: t.description || null,
          organizationId: t.organization_id ?? org,
          activeVersionId: t.active_version_id,
        }),
      ),
    };
  }

  async activeVersion(templateId: string): Promise<string> {
    return (await this.api.template(templateId)).active_version_id;
  }

  async parameters(templateVersionId: string): Promise<WorkspaceParameter[]> {
    return (await this.api.richParameters(templateVersionId)).map(toParameter);
  }

  async workspaces(): Promise<RemoteWorkspace[]> {
    return (await this.api.workspaces()).map(toWorkspace);
  }

  async workspace(id: string): Promise<RemoteWorkspace> {
    return toWorkspace(await this.api.workspace(id));
  }

  async create(input: CreateWorkspaceInput): Promise<RemoteWorkspace> {
    const values = parameterValues(input.declared, input.wanted, input.bundle, {
      checkoutDir: input.checkoutDir,
      templateName: input.templateName,
    });
    const ws = await this.api.createWorkspace({
      templateVersionId: input.templateVersionId,
      name: input.name,
      ttlMs: input.ttlMs,
      richParameterValues: values,
    });
    return toWorkspace(ws);
  }

  async start(ws: RemoteWorkspace, input: PairingDelivery): Promise<void> {
    const values = parameterValues(input.declared, input.wanted, input.bundle, {
      checkoutDir: input.checkoutDir,
      existing: true,
      templateName: ws.templateName ?? undefined,
    });
    await this.api.build(ws.id, "start", values);
  }

  async stop(id: string): Promise<string> {
    return (await this.api.build(id, "stop")).status;
  }

  async remove(id: string): Promise<string> {
    return (await this.api.build(id, "delete")).status;
  }
}

export const coderProvider: RemoteWorkspaceProvider = {
  id: "coder",
  client: (target) => new CoderProviderClient(target),
  checksOwner: true,
  defaultCheckoutDir: () => DEFAULT_CHECKOUT_DIR,
};
