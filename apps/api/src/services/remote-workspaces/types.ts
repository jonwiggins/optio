/**
 * What Optio needs from a remote-workspace provider (docs/remote-workspaces.md):
 * the operations services/remote-workspace-service.ts runs work with, each
 * provider's REST API behind them (coder.ts, codespaces.ts, daytona.ts,
 * e2b.ts). The service owns everything else — connections, the pairing
 * token and the machine row, re-runs, the end of a run, the watcher — so a
 * provider is only its API and how the pairing bundle reaches its workspace.
 */
import type { RemoteWorkspaceProviderId } from "@optio/shared";

export class RemoteWorkspaceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 502 = 400,
  ) {
    super(message);
    this.name = "RemoteWorkspaceError";
  }
}

/** One provider account: its API, the token, and how to trust its TLS. */
export interface ProviderTarget {
  url: string;
  token: string;
  caPem?: string | null;
  insecureSkipVerify?: boolean;
  /** The organization (Coder, Daytona, Codespaces) the connection is scoped to; null = the default. */
  organizationId?: string | null;
}

/** Whom the token signs in as (the Test button). `id` null: the API doesn't say. */
export interface ProviderIdentity {
  id: string | null;
  username: string;
  email?: string;
}

/** Something a workspace is made from: a template, a snapshot, a repository. */
export interface WorkspaceTemplate {
  id: string;
  name: string;
  displayName: string | null;
  description: string | null;
  organizationId: string | null;
  /** What a new workspace is made from now (a template version; the id itself for most). */
  activeVersionId: string;
}

/** A parameter a new workspace takes, to render a form. */
export interface WorkspaceParameter {
  name: string;
  displayName: string | null;
  description: string | null;
  type: string;
  mutable: boolean;
  required: boolean;
  defaultValue: string | null;
  ephemeral: boolean;
  options: Array<{ name: string; value: string; description: string | null }>;
  /** Optio fills it (the pairing bundle, the checkout, the agent policy). */
  setByOptio: boolean;
}

/**
 * A workspace at its provider. `status` is the provider's word for where it
 * is, mapped onto running / stopped / starting / stopping / failed /
 * deleted (Coder's build statuses are these already).
 */
export interface RemoteWorkspace {
  id: string;
  name: string;
  ownerId: string | null;
  ownerName: string | null;
  templateId: string | null;
  templateName: string | null;
  /** What it was built from (Coder's template version; the template for the others). */
  templateVersionId: string | null;
  status: string;
  /** What was last asked of it (start, stop, delete), when the provider says. */
  transition: string;
  /** Running and reachable: an exec-started daemon can be started now. */
  ready: boolean;
  /** Why it will never come up (a failed build, an error state), or null. */
  problem: string | null;
}

/** What Optio's daemon in the workspace needs to pair as the pre-registered machine. */
export interface PairingBundle {
  OPTIO_SERVER: string;
  OPTIO_TOKEN: string;
  OPTIO_LOCAL_HOST_ID: string;
}

/** How a start reaches the workspace (create and start both get it). */
export interface PairingDelivery {
  /** The parameters the provider declares (`parameters()`), for those that take them. */
  declared: WorkspaceParameter[];
  /** Parameter values: the connection's defaults, the work's, the agent policy's. */
  wanted: Record<string, string>;
  bundle: PairingBundle;
  checkoutDir: string;
  /**
   * The start script's environment (start-script.ts): the bundle, the
   * checkout, the repository and the agent policy as OPTIO_* variables, for
   * providers that run the script themselves or hand it to the workspace.
   */
  env: Record<string, string>;
  /** For error messages: the template's name. */
  templateName?: string;
  /** The connection's TTL: how long the workspace may run (each provider's own meaning). */
  ttlMs: number | null;
}

export interface CreateWorkspaceInput extends PairingDelivery {
  templateVersionId: string;
  name: string;
}

/** A provider's API as one account. Every call goes through the outbound guard. */
export interface RemoteWorkspaceClient {
  whoami(): Promise<ProviderIdentity>;
  /** When the token stops working (credential health); null = never, or the API doesn't say. */
  tokenExpiry(): Promise<Date | null>;
  templates(
    organizationId?: string | null,
  ): Promise<{ organizationId: string; templates: WorkspaceTemplate[] }>;
  /** The version a new workspace from `templateId` is made from. */
  activeVersion(templateId: string): Promise<string>;
  parameters(templateVersionId: string): Promise<WorkspaceParameter[]>;
  /** The token's workspaces, for "an existing workspace". */
  workspaces(): Promise<RemoteWorkspace[]>;
  /** One workspace; a RemoteWorkspaceError with status 404 when it is gone. */
  workspace(id: string): Promise<RemoteWorkspace>;
  /** Make a workspace that pairs itself with the bundle; returns once the provider accepted it. */
  create(input: CreateWorkspaceInput): Promise<RemoteWorkspace>;
  /** Start (or resume) an existing workspace with a fresh bundle. */
  start(ws: RemoteWorkspace, input: PairingDelivery): Promise<void>;
  /** Stop (or pause) it; answers its status. */
  stop(id: string): Promise<string>;
  /** Delete it; answers its status. */
  remove(id: string): Promise<string>;
  /**
   * Providers whose workspace doesn't start Optio's daemon by itself: run
   * the start script in it once it is `ready` (the service waits for that).
   */
  runStartScript?(ws: RemoteWorkspace, env: Record<string, string>): Promise<void>;
  /** Drop what carried the pairing bundle (Codespaces' secret) once it is no longer needed. */
  releasePairing?(ws: { id: string; name: string }): Promise<void>;
}

/** A provider: its client, and what the service asks of it besides. */
export interface RemoteWorkspaceProvider {
  id: RemoteWorkspaceProviderId;
  client(target: ProviderTarget): RemoteWorkspaceClient;
  /** An existing workspace must be the token user's (the provider has owners). */
  checksOwner: boolean;
  /** The checkout when neither the work nor the connection names one. */
  defaultCheckoutDir(input: {
    templateId: string | null;
    parameters: Record<string, string>;
  }): string;
  /** The template a new workspace is made from when none is picked (Codespaces: the work's repository). */
  templateFromParameters?(parameters: Record<string, string>): string | null;
  /**
   * The client's `releasePairing` drops something that outlives the start
   * (Codespaces' secret): the service calls it after the daemon's first
   * hello and when the pairing ends.
   */
  releasesPairing?: boolean;
}
