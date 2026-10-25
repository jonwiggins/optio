"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { REMOTE_WORKSPACE_PROVIDER_INFO } from "@optio/shared";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/segmented";
import { inputClass } from "@/components/ui/input";
import {
  api,
  type RemoteWorkspace,
  type RemoteWorkspaceConnection,
  type RemoteWorkspaceParameter,
  type RemoteWorkspaceTemplate,
} from "@/lib/api-client";
import { WorkspaceParameterFields } from "./parameter-fields";
import {
  REPO_PARAMETER,
  checkoutDirFor,
  fillableParameters,
  formatTtl,
  providerLabel,
  sortConnections,
  workspaceNameError,
  type RunLocationRemoteWorkspace,
} from "./location";

/**
 * The visible remote-workspace connections
 * (`GET /api/remote-workspaces/connections`), enabled ones only, in the
 * order they apply. `null` while loading; a client without the route (an
 * older server, a test's partial mock) is "none".
 */
export function useRemoteWorkspaceConnections(enabled = true): RemoteWorkspaceConnection[] | null {
  const [rows, setRows] = useState<RemoteWorkspaceConnection[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    Promise.resolve()
      .then(() => api.listRemoteWorkspaceConnections())
      .then((res) => live && setRows(sortConnections(res.connections.filter((c) => c.enabled))))
      .catch(() => live && setRows([]));
    return () => {
      live = false;
    };
  }, [enabled]);
  return rows;
}

/** A workspace "Existing" can start: one that is up, or one that can be started. */
const PICKABLE = new Set(["running", "stopped"]);

const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The panel under "A remote workspace": which connection (and so which
 * provider), an existing workspace of yours or a new one from a template
 * (its parameters as a form), and the checkout the agent works in. Optio
 * starts the workspace when the work is created; the run waits for it to
 * pair.
 */
export function RemoteWorkspaceLocationPanel({
  value,
  onChange,
  connections,
  kind,
  inset = false,
}: {
  value: RunLocationRemoteWorkspace;
  onChange: (next: RunLocationRemoteWorkspace) => void;
  connections: RemoteWorkspaceConnection[] | null;
  kind: "task" | "job";
  inset?: boolean;
}) {
  const conn = connections?.find((c) => c.id === value.connectionId) ?? null;
  const info = conn ? REMOTE_WORKSPACE_PROVIDER_INFO[conn.provider] : null;
  const templateNoun = info?.templateNoun ?? "template";
  const workspaceNoun = info?.workspaceNoun ?? "workspace";
  // A codespace is made for the Task's repository.
  const templateFromRepo = conn?.provider === "codespaces" && kind === "task";

  // Start on the connection that applies (yours, a team's, the organization's).
  useEffect(() => {
    if (!connections || connections.length === 0 || conn) return;
    onChange({
      ...value,
      connectionId: connections[0].id,
      provider: connections[0].provider,
      templateId: "",
      workspaceId: "",
    });
  }, [connections, conn]);

  const [templates, setTemplates] = useState<RemoteWorkspaceTemplate[] | null>(null);
  const [workspaces, setWorkspaces] = useState<RemoteWorkspace[] | null>(null);
  const [parameters, setParameters] = useState<RemoteWorkspaceParameter[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTemplates(null);
    setWorkspaces(null);
    setError(null);
    if (!conn) return;
    let live = true;
    const fail = (err: unknown) =>
      live && setError(err instanceof Error ? err.message : String(err));
    if (value.source === "new") {
      api
        .listRemoteWorkspaceTemplates(conn.id, conn.organizationId ?? undefined)
        .then((res) => live && setTemplates(res.templates))
        .catch(fail);
    } else {
      api
        .listRemoteWorkspaces(conn.id)
        .then((res) => live && setWorkspaces(res.workspaces))
        .catch(fail);
    }
    return () => {
      live = false;
    };
  }, [conn?.id, value.source]);

  // The template a new workspace is made from: the one picked, else the connection's.
  const templateId = value.templateId || conn?.templateId || "";
  const template = templates?.find((t) => t.id === templateId);
  const versionId = template?.activeVersionId ?? (value.templateId ? "" : conn?.templateVersionId);
  useEffect(() => {
    setParameters(null);
    if (!conn || value.source !== "new" || !versionId) return;
    let live = true;
    api
      .getRemoteWorkspaceTemplateParameters(conn.id, versionId)
      .then((res) => live && setParameters(res.parameters))
      .catch(() => live && setParameters([]));
    return () => {
      live = false;
    };
  }, [conn?.id, value.source, versionId]);

  const fillable = useMemo(
    () => fillableParameters(parameters ?? [], { skipRepo: kind === "task" }),
    [parameters, kind],
  );
  // A Coder template pairs only when it declares the pairing parameters.
  const pairs =
    conn?.provider !== "coder" || !parameters || parameters.some((p) => p.name === "optio_token");
  const nameError = workspaceNameError(value.name, conn?.provider);
  const ttl = formatTtl(conn?.ttlMs);
  const box = cn(
    "p-4 rounded-lg border border-border space-y-3",
    inset ? "bg-bg" : "bg-bg-card/60",
  );

  if (connections === null) {
    return (
      <div className={box}>
        <p className="inline-flex items-center gap-1.5 text-xs text-text-muted">
          <Loader2 className="w-3 h-3 animate-spin" /> Looking for remote-workspace connections…
        </p>
      </div>
    );
  }
  if (connections.length === 0) {
    return (
      <div className={box}>
        <p className="text-sm text-text">No remote-workspace connection yet.</p>
        <p className="text-xs text-text-muted">
          Add a provider (Coder, GitHub Codespaces, Daytona or E2B) and its token under{" "}
          <Link
            href="/settings#remote-workspaces"
            className="text-primary hover:underline"
            target="_blank"
          >
            Settings → Integrations → Remote workspaces ↗
          </Link>
          , then pick a workspace or a template here.
        </p>
      </div>
    );
  }

  return (
    <div className={box}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label htmlFor="workspace-connection" className="block text-sm text-text-muted mb-1.5">
            Connection
          </label>
          <select
            id="workspace-connection"
            value={value.connectionId}
            onChange={(e) => {
              const next = connections.find((c) => c.id === e.target.value);
              onChange({
                ...value,
                connectionId: e.target.value,
                provider: next?.provider ?? null,
                templateId: "",
                workspaceId: "",
                parameters: {},
              });
            }}
            className={inputClass()}
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.name === providerLabel(c.provider) ? "" : ` · ${providerLabel(c.provider)}`}
                {c.ownerTeamId
                  ? ` (${c.ownerTeamName ?? "team"})`
                  : c.ownerUserId
                    ? " (yours)"
                    : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className="block text-sm text-text-muted mb-1.5">Workspace</span>
          <Segmented<RunLocationRemoteWorkspace["source"]>
            aria-label="Workspace"
            value={value.source}
            onChange={(source) => onChange({ ...value, source })}
            options={[
              { value: "new", label: `New ${workspaceNoun}` },
              { value: "existing", label: `Existing ${workspaceNoun}` },
            ]}
          />
        </div>
      </div>

      {error && <p className="text-xs text-error">{error}</p>}

      {value.source === "existing" ? (
        <div>
          <label htmlFor="workspace-existing" className="block text-sm text-text-muted mb-1.5">
            Your {workspaceNoun}
          </label>
          <select
            id="workspace-existing"
            value={value.workspaceId}
            onChange={(e) => onChange({ ...value, workspaceId: e.target.value })}
            className={inputClass()}
            disabled={!workspaces}
          >
            <option value="">
              {!workspaces
                ? "Loading…"
                : workspaces.some((w) => PICKABLE.has(w.status))
                  ? `Pick a ${workspaceNoun}…`
                  : `No running or stopped ${workspaceNoun}`}
            </option>
            {(workspaces ?? [])
              .filter((w) => PICKABLE.has(w.status))
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} — {w.status}
                  {w.templateName ? ` · ${w.templateName}` : ""}
                </option>
              ))}
          </select>
          <p className="text-[11px] text-text-muted/80 mt-1">
            A stopped one is started with a new pairing token; one that is running and paired is
            used as it is, and keeps running afterwards.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {!templateFromRepo && (
              <div>
                <label
                  htmlFor="workspace-template"
                  className="block text-sm text-text-muted mb-1.5"
                >
                  {capitalized(templateNoun)}
                </label>
                <select
                  id="workspace-template"
                  value={value.templateId}
                  onChange={(e) =>
                    onChange({ ...value, templateId: e.target.value, parameters: {} })
                  }
                  className={inputClass()}
                >
                  <option value="">
                    {conn?.templateId
                      ? `Default — ${conn.templateName ?? template?.displayName ?? "the connection's"}`
                      : templates
                        ? `Pick a ${templateNoun}…`
                        : "Loading…"}
                  </option>
                  {(templates ?? [])
                    .filter((t) => t.id !== conn?.templateId)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.displayName || t.name}
                      </option>
                    ))}
                </select>
              </div>
            )}
            {info?.name && (
              <div>
                <label htmlFor="workspace-name" className="block text-sm text-text-muted mb-1.5">
                  {capitalized(workspaceNoun)} name{" "}
                  <span className="text-text-muted/70">(optional)</span>
                </label>
                <input
                  id="workspace-name"
                  value={value.name}
                  onChange={(e) => onChange({ ...value, name: e.target.value })}
                  placeholder="optio-<work>-a1b2c3"
                  spellCheck={false}
                  className={inputClass({ className: "font-mono" })}
                />
                {nameError && <p className="text-[11px] text-error mt-1">{nameError}</p>}
              </div>
            )}
          </div>
          {!pairs && (
            <p className="text-xs text-error">
              This template has no <code className="font-mono">optio_token</code> parameter, so its
              workspaces can&apos;t pair with Optio — see docs/remote-workspaces.md, “Coder”.
            </p>
          )}
          {parameters === null && versionId ? (
            <p className="inline-flex items-center gap-1.5 text-xs text-text-muted">
              <Loader2 className="w-3 h-3 animate-spin" /> Reading the {templateNoun}&apos;s
              parameters…
            </p>
          ) : (
            <WorkspaceParameterFields
              parameters={fillable}
              values={value.parameters}
              fallback={conn?.defaultParameters}
              onChange={(next) => onChange({ ...value, parameters: next })}
            />
          )}
        </>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {kind === "task" && (
          <div>
            <label htmlFor="workspace-repo" className="block text-sm text-text-muted mb-1.5">
              Repository
            </label>
            <input
              id="workspace-repo"
              value={value.repoUrl}
              onChange={(e) => onChange({ ...value, repoUrl: e.target.value })}
              placeholder="https://git.example.com/team/app"
              spellCheck={false}
              className={inputClass({ className: "font-mono" })}
            />
            <p className="text-[11px] text-text-muted/80 mt-1">
              {templateFromRepo ? (
                "The repo the codespace is made for — the PR goes there."
              ) : (
                <>
                  The repo the checkout is — the PR goes there. It is cloned into the checkout (
                  <code className="font-mono">{REPO_PARAMETER}</code>).
                </>
              )}
            </p>
          </div>
        )}
        <div>
          <label htmlFor="workspace-checkout" className="block text-sm text-text-muted mb-1.5">
            Checkout
          </label>
          <input
            id="workspace-checkout"
            value={value.checkoutDir}
            onChange={(e) => onChange({ ...value, checkoutDir: e.target.value })}
            placeholder={checkoutDirFor({ ...value, checkoutDir: "" }, conn)}
            spellCheck={false}
            className={inputClass({ className: "font-mono" })}
          />
          <p className="text-[11px] text-text-muted/80 mt-1">
            Where the repo is checked out in the {workspaceNoun}; the agent works there.
          </p>
        </div>
      </div>

      <p className="text-[11px] text-text-muted/80">
        Optio starts the {workspaceNoun} when you create the work; the run waits until it pairs as a
        machine.{" "}
        {conn?.deleteWhenDone
          ? `The ${workspaceNoun} is deleted when the run ends`
          : info?.stopVerb === "pause"
            ? `The ${workspaceNoun} is paused when the run ends`
            : `The ${workspaceNoun} stops when the run ends`}
        {ttl ? `, or after ${ttl} at the latest.` : "."}
      </p>
    </div>
  );
}
