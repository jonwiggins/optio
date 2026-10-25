import {
  REMOTE_WORKSPACE_CHECKOUT_PARAMETER,
  REMOTE_WORKSPACE_PROVIDER_INFO,
  REMOTE_WORKSPACE_REPO_PARAMETER,
  remoteWorkspaceNameError,
  type RemoteWorkspaceLaunch,
  type RemoteWorkspaceProviderId,
} from "@optio/shared";
import type { RemoteWorkspaceConnection, RemoteWorkspaceParameter } from "@/lib/api-client";

/**
 * "A remote workspace" as the New work form holds it
 * (docs/remote-workspaces.md). The run location stays `runTarget: "local"`
 * — the workspace pairs itself as a machine — and these fields travel as
 * `where.remoteWorkspace`; the API starts the workspace and fills in the
 * machine and the checkout.
 */
export interface RunLocationRemoteWorkspace {
  /** The connection (Settings → Integrations → Remote workspaces); its provider follows. */
  connectionId: string;
  /** The connection's provider, when known (a saved launch names it). */
  provider?: RemoteWorkspaceProviderId | null;
  /** Start an existing workspace of yours, or create one from a template. */
  source: "new" | "existing";
  /** `existing`: the workspace's id at its provider. */
  workspaceId: string;
  /** `new`: the template (snapshot, repository); "" = the connection's default. */
  templateId: string;
  /** `new`: a template version saved with the work (the API's `templateVersionId`); the form doesn't pick one. */
  templateVersionId?: string;
  /** `new`: parameter values typed here, over the connection's defaults. */
  parameters: Record<string, string>;
  /** `new`: the workspace's name; "" = one Optio makes up. */
  name: string;
  /** Where the agent works; "" = the connection's, else the provider's default. */
  checkoutDir: string;
  /** Tasks: the repo the checkout is — the PR's repo, and the `repo_url` parameter. */
  repoUrl: string;
}

export const EMPTY_REMOTE_WORKSPACE: RunLocationRemoteWorkspace = {
  connectionId: "",
  source: "new",
  workspaceId: "",
  templateId: "",
  parameters: {},
  name: "",
  checkoutDir: "",
  repoUrl: "",
};

/** The parameter a repo URL is handed to (every provider's convention). */
export const REPO_PARAMETER = REMOTE_WORKSPACE_REPO_PARAMETER;

/** The provider's name, for labels ("Coder", "GitHub Codespaces", …). */
export function providerLabel(provider: string | null | undefined): string {
  return provider && provider in REMOTE_WORKSPACE_PROVIDER_INFO
    ? REMOTE_WORKSPACE_PROVIDER_INFO[provider as RemoteWorkspaceProviderId].label
    : "Remote workspace";
}

/** The checkout the run will use: the one typed, the connection's, or the provider's default. */
export function checkoutDirFor(
  c: RunLocationRemoteWorkspace,
  conn?: RemoteWorkspaceConnection | null,
): string {
  return (
    c.checkoutDir.trim() ||
    conn?.defaultParameters?.[REMOTE_WORKSPACE_CHECKOUT_PARAMETER] ||
    (conn ? REMOTE_WORKSPACE_PROVIDER_INFO[conn.provider]?.defaultCheckoutDir : null) ||
    ""
  );
}

/** A name the provider takes for a new workspace, or why not. */
export function workspaceNameError(
  name: string,
  provider: RemoteWorkspaceProviderId | null | undefined,
): string | null {
  return provider ? remoteWorkspaceNameError(provider, name) : null;
}

/** `where.remoteWorkspace` for `POST /api/work`. */
export function remoteWorkspaceSpecOf(c: RunLocationRemoteWorkspace): RemoteWorkspaceLaunch {
  const fresh = c.source === "new";
  const parameters: Record<string, string> = fresh ? { ...c.parameters } : {};
  // A Task's repository goes to `repo_url`, which a template clones (the API
  // drops parameters a provider doesn't take).
  if (c.repoUrl.trim() && !parameters[REPO_PARAMETER]) {
    parameters[REPO_PARAMETER] = c.repoUrl.trim();
  }
  return {
    ...(c.provider ? { provider: c.provider } : {}),
    connectionId: c.connectionId || null,
    workspaceId: fresh ? null : c.workspaceId || null,
    templateId: fresh ? c.templateId || null : null,
    ...(fresh && c.templateVersionId ? { templateVersionId: c.templateVersionId } : {}),
    parameters: Object.keys(parameters).length ? parameters : null,
    name: fresh ? c.name.trim() || null : null,
    checkoutDir: c.checkoutDir.trim() || null,
  };
}

/**
 * The order connections apply in (docs/remote-workspaces.md): yours, then a
 * team's, then the organization's — the first is the one a new pick starts
 * on — and by provider and name within each.
 */
export function sortConnections(rows: RemoteWorkspaceConnection[]): RemoteWorkspaceConnection[] {
  const rank = (c: RemoteWorkspaceConnection) => (c.ownerTeamId ? 1 : c.ownerUserId ? 0 : 2);
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.provider ?? "").localeCompare(b.provider ?? "") ||
      a.name.localeCompare(b.name),
  );
}

/** The parameters a person fills in (Optio fills the pairing ones and the checkout). */
export function fillableParameters(
  params: RemoteWorkspaceParameter[],
  opts: { skipRepo?: boolean } = {},
): RemoteWorkspaceParameter[] {
  return params.filter((p) => !p.setByOptio && !(opts.skipRepo && p.name === REPO_PARAMETER));
}

/** "8 h", "90 min", "2 d" for a connection's TTL. */
export function formatTtl(ms: number | null | undefined): string | null {
  if (!ms) return null;
  const min = Math.round(ms / 60_000);
  if (min < 120) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/**
 * The form's fields for saved work's `where.remoteWorkspace` (its
 * `remote_workspace_launch`) — the inverse of `remoteWorkspaceSpecOf`, so
 * saving an edit keeps the workspace it names.
 */
export function remoteWorkspaceFromSpec(spec: RemoteWorkspaceLaunch): RunLocationRemoteWorkspace {
  const existing = !!spec.workspaceId;
  return {
    connectionId: spec.connectionId ?? "",
    ...(spec.provider ? { provider: spec.provider } : {}),
    source: existing ? "existing" : "new",
    workspaceId: spec.workspaceId ?? "",
    templateId: existing ? "" : (spec.templateId ?? ""),
    ...(!existing && spec.templateVersionId ? { templateVersionId: spec.templateVersionId } : {}),
    parameters: existing ? {} : { ...(spec.parameters ?? {}) },
    name: existing ? "" : (spec.name ?? ""),
    checkoutDir: spec.checkoutDir ?? "",
    repoUrl: "",
  };
}
