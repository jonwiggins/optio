"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  REMOTE_WORKSPACE_CHECKOUT_PARAMETER,
  REMOTE_WORKSPACE_PROVIDERS,
  REMOTE_WORKSPACE_PROVIDER_INFO,
  type RemoteWorkspaceProviderId,
} from "@optio/shared";
import {
  api,
  type RemoteWorkspaceConnection,
  type RemoteWorkspaceParameter,
  type RemoteWorkspaceTemplate,
  type RemoteWorkspaceTestResult,
  type UpdateRemoteWorkspaceConnectionInput,
} from "@/lib/api-client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useMyTeams } from "@/hooks/use-my-teams";
import { ownerOf, type PickedOwner } from "@/lib/owner";
import { SectionCard } from "@/components/ui/section-card";
import { OwnerPicker } from "@/components/ui/owner-picker";
import { OwnerChip } from "@/components/ui/owner-chip";
import { EmptyState } from "@/components/empty-state";
import { WorkspaceParameterFields } from "@/components/remote-workspaces/parameter-fields";
import {
  fillableParameters,
  formatTtl,
  sortConnections,
} from "@/components/remote-workspaces/location";
import {
  BTN_HEADER,
  BTN_PRIMARY,
  BTN_ROW_DANGER,
  BTN_TEXT,
  Field,
  INPUT,
  InsetForm,
  MONO_AREA,
  SkeletonCard,
  Tag,
} from "./settings-ui";

/**
 * Settings → Integrations → Remote workspaces (docs/remote-workspaces.md):
 * the provider accounts Optio starts workspaces with for "Where → A remote
 * workspace" — Coder, GitHub Codespaces, Daytona and E2B. One per provider
 * per scope — the organization's (a workspace admin adds it), a team's (its
 * team admins) or a person's own, with their own token. The token is
 * write-only: a row shows its last four characters. After a successful Test
 * the form offers the provider's templates, and the default template's
 * parameters as a form. Nothing here until someone adds a connection: the
 * feature is off by default.
 */

const HOUR = 60 * 60_000;
const CHECKOUT = REMOTE_WORKSPACE_CHECKOUT_PARAMETER;
const info = (p: RemoteWorkspaceProviderId) => REMOTE_WORKSPACE_PROVIDER_INFO[p];
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface Draft {
  provider: RemoteWorkspaceProviderId;
  name: string;
  url: string;
  token: string;
  caPem: string;
  insecureSkipVerify: boolean;
  organizationId: string;
  templateId: string;
  templateName: string;
  defaultParameters: Record<string, string>;
  /** Hours, as typed; "" = no TTL. */
  ttlHours: string;
  deleteWhenDone: boolean;
}

function emptyDraft(provider: RemoteWorkspaceProviderId): Draft {
  return {
    provider,
    name: info(provider).label,
    url: "",
    token: "",
    caPem: "",
    insecureSkipVerify: false,
    organizationId: "",
    templateId: "",
    templateName: "",
    defaultParameters: {},
    ttlHours: "8",
    deleteWhenDone: false,
  };
}

function draftOf(c: RemoteWorkspaceConnection): Draft {
  return {
    provider: c.provider,
    name: c.name,
    url: c.url,
    token: "",
    caPem: c.caPem ?? "",
    insecureSkipVerify: c.insecureSkipVerify,
    organizationId: c.organizationId ?? "",
    templateId: c.templateId ?? "",
    templateName: c.templateName ?? "",
    defaultParameters: c.defaultParameters ?? {},
    ttlHours: c.ttlMs ? String(Math.round((c.ttlMs / HOUR) * 100) / 100) : "",
    deleteWhenDone: c.deleteWhenDone,
  };
}

/** The TTL field in ms, or an error to show. */
function ttlOf(hours: string): { ttlMs: number | null } | { error: string } {
  const h = hours.trim();
  if (!h) return { ttlMs: null };
  const n = Number(h);
  if (!Number.isFinite(n) || n * HOUR < 60_000 || n > 720) {
    return { error: "Between a minute (0.02) and 720 hours" };
  }
  return { ttlMs: Math.round(n * HOUR) };
}

/** The body fields both create and change send (a blank token is left out). */
function bodyOf(d: Draft, ttlMs: number | null): UpdateRemoteWorkspaceConnectionInput {
  return {
    name: d.name.trim(),
    url: d.url.trim(),
    ...(d.token.trim() ? { token: d.token.trim() } : {}),
    caPem: d.caPem.trim() ? d.caPem : null,
    insecureSkipVerify: d.insecureSkipVerify,
    organizationId: d.organizationId.trim() || null,
    templateId: d.templateId || null,
    // The active version applies: Coder moves it when the template is pushed.
    templateVersionId: null,
    templateName: d.templateId ? d.templateName || null : null,
    defaultParameters: Object.fromEntries(
      Object.entries(d.defaultParameters).filter(([, v]) => v !== ""),
    ),
    ttlMs,
    deleteWhenDone: d.deleteWhenDone,
  };
}

export function RemoteWorkspaceConnections() {
  const { userId, isAdmin, adminTeamIds } = useCurrentUser();
  const { myTeams } = useMyTeams();
  const [rows, setRows] = useState<RemoteWorkspaceConnection[] | null>(null);
  /** "new", a row's id, or null. */
  const [editing, setEditing] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, RemoteWorkspaceTestResult>>({});
  const [testingId, setTestingId] = useState<string | null>(null);

  const reload = () =>
    Promise.resolve()
      .then(() => api.listRemoteWorkspaceConnections())
      .then((res) => setRows(sortConnections(res.connections)))
      .catch(() => setRows((prev) => prev ?? []));
  useEffect(() => {
    void reload();
  }, []);

  const test = async (
    id: string,
    known?: RemoteWorkspaceProviderId,
  ): Promise<RemoteWorkspaceTestResult> => {
    const provider = known ?? rows?.find((r) => r.id === id)?.provider;
    const label = provider ? info(provider).label : "The provider";
    setTestingId(id);
    try {
      const result = await api.testRemoteWorkspaceConnection(id);
      setTests((prev) => ({ ...prev, [id]: result }));
      if (result.ok) toast.success(`${label} reached`, { description: describeTest(result) });
      else toast.error(`${label} test failed`, { description: result.error });
      void reload();
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : "Unknown error";
      const result = { ok: false, error };
      setTests((prev) => ({ ...prev, [id]: result }));
      toast.error(`${label} test failed`, { description: error });
      return result;
    } finally {
      setTestingId(null);
    }
  };

  const remove = async (c: RemoteWorkspaceConnection) => {
    if (
      !confirm(
        `Remove the ${info(c.provider).label} connection “${c.name}”? Workspaces it started keep running until their TTL stops them.`,
      )
    ) {
      return;
    }
    try {
      await api.deleteRemoteWorkspaceConnection(c.id);
      setRows((prev) => (prev ?? []).filter((r) => r.id !== c.id));
      if (editing === c.id) setEditing(null);
      toast.success("Connection removed");
    } catch (err) {
      toast.error("Failed to remove the connection", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const label = "Remote workspaces";
  const hint = "Run work in workspaces from Coder, GitHub Codespaces, Daytona or E2B";
  if (rows === null) {
    return <SkeletonCard id="remote-workspaces" label={label} hint={hint} rows={1} />;
  }

  return (
    <SectionCard
      id="remote-workspaces"
      label={label}
      hint={hint}
      summary={rows.length ? `${rows.length} connection${rows.length === 1 ? "" : "s"}` : undefined}
      actions={
        editing !== "new" && (
          <button onClick={() => setEditing("new")} className={BTN_HEADER}>
            <Plus className="w-3.5 h-3.5" />
            Add connection
          </button>
        )
      }
      bodyClassName="p-4 space-y-3"
    >
      {rows.length === 0 && editing !== "new" && (
        <EmptyState
          size="panel"
          icon={Boxes}
          title="No remote-workspace connection"
          description="Connect a workspace provider so work can run in a workspace made from your templates, snapshots or repositories — in your image, with your tools and network."
          action={
            <button onClick={() => setEditing("new")} className={BTN_PRIMARY}>
              <Plus className="w-3.5 h-3.5" />
              Add connection
            </button>
          }
        />
      )}

      {rows.length > 0 && (
        <div className="rounded-xl border border-border/70 divide-y divide-border/60">
          {rows.map((c) => (
            <div key={c.id} className="px-3 py-2.5 space-y-2" data-testid={`connection-${c.id}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="grid place-items-center w-7 h-7 rounded-md border border-border bg-bg-card text-text-muted shrink-0">
                    <Boxes className="w-3.5 h-3.5" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{c.name}</span>
                      <Tag>{info(c.provider).label}</Tag>
                      {c.ownerUserId || c.ownerTeamId ? (
                        <OwnerChip row={c} viewerId={userId} />
                      ) : (
                        <Tag>Organization</Tag>
                      )}
                      {!c.enabled && <Tag tone="error">Disabled</Tag>}
                      {c.insecureSkipVerify && <Tag tone="warning">TLS not verified</Tag>}
                    </div>
                    <p className="text-xs text-text-muted truncate">
                      {c.url || info(c.provider).defaultUrl}
                      {c.templateName
                        ? ` · ${c.templateName}`
                        : ` · no default ${info(c.provider).templateNoun}`}
                      {c.ttlMs ? ` · stops after ${formatTtl(c.ttlMs)}` : ""}
                      {c.deleteWhenDone ? " · deleted when done" : ""}
                      {c.tokenHint ? ` · token …${c.tokenHint}` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {c.canEdit && (
                    <button
                      onClick={() => test(c.id)}
                      disabled={testingId === c.id}
                      className={BTN_HEADER}
                      title={`Sign in to ${info(c.provider).label} with the stored token`}
                    >
                      {testingId === c.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-3 h-3" />
                      )}
                      Test
                    </button>
                  )}
                  {c.canEdit && editing !== c.id && (
                    <button
                      onClick={() => setEditing(c.id)}
                      className={BTN_HEADER}
                      aria-label={`Edit ${c.name}`}
                    >
                      <Pencil className="w-3 h-3" />
                      Edit
                    </button>
                  )}
                  {c.canEdit && (
                    <button
                      onClick={() => remove(c)}
                      className={BTN_ROW_DANGER}
                      title="Remove connection"
                      aria-label={`Remove ${c.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <TestLine result={tests[c.id]} lastError={c.lastError} />
              {editing === c.id && (
                <ConnectionForm
                  row={c}
                  test={test}
                  onDone={(saved) => {
                    setEditing(null);
                    if (saved) void reload();
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {editing === "new" && (
        <ConnectionForm
          test={test}
          ownerPicker={(owner, setOwner, provider) =>
            info(provider).personalOnly ? (
              <p className="text-xs text-text-muted">
                A {info(provider).label} connection is your own: the pairing secrets it writes reach
                every {info(provider).workspaceNoun} of the token&apos;s account.
              </p>
            ) : (
              <OwnerPicker
                what="connection"
                value={owner}
                onChange={setOwner}
                canOrg={isAdmin}
                // A team's connection is its team admins' to add.
                teams={myTeams.filter((team) => adminTeamIds.includes(team.id))}
                orgHint="Everyone's work can start workspaces with it, under its token's account."
                privateHint="Only your work uses it — with your own token, so workspaces are yours at the provider."
                teamHint="The team's work uses it before the organization's; its team admins change it."
              />
            )
          }
          defaultOwner={isAdmin ? "organization" : "private"}
          onDone={(saved, id) => {
            setEditing(saved && id ? id : null);
            if (saved) void reload();
          }}
        />
      )}
    </SectionCard>
  );
}

function describeTest(r: RemoteWorkspaceTestResult): string {
  return r.user?.username
    ? `Signed in as ${r.user.username}${r.user.email ? ` (${r.user.email})` : ""}`
    : "The token works";
}

function TestLine({
  result,
  lastError,
}: {
  result?: RemoteWorkspaceTestResult;
  lastError: string | null;
}) {
  if (result?.ok) {
    return (
      <p className="ml-10 flex items-center gap-1.5 text-xs text-success">
        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
        Connected. {describeTest(result)}
      </p>
    );
  }
  const error = result ? (result.error ?? "The test failed") : lastError;
  if (!error) return null;
  return (
    <div className="ml-10 p-2 rounded-md bg-error/5 border border-error/20">
      <p className="flex items-center gap-1.5 text-xs text-error">
        <XCircle className="w-3.5 h-3.5 shrink-0" />
        {error}
      </p>
    </div>
  );
}

/**
 * Add or change a connection. Adding picks the provider, saves the URL and
 * token, then tests them and stays open on the saved row for its template;
 * changing offers the templates once a test reached the provider.
 */
function ConnectionForm({
  row,
  test,
  onDone,
  ownerPicker,
  defaultOwner = "organization",
}: {
  row?: RemoteWorkspaceConnection;
  test: (id: string, provider?: RemoteWorkspaceProviderId) => Promise<RemoteWorkspaceTestResult>;
  /** `saved` and the row's id when something was stored. */
  onDone: (saved: boolean, id?: string) => void;
  ownerPicker?: (
    owner: PickedOwner,
    set: (o: PickedOwner) => void,
    provider: RemoteWorkspaceProviderId,
  ) => React.ReactNode;
  defaultOwner?: PickedOwner;
}) {
  const [draft, setDraftRaw] = useState<Draft>(() =>
    row ? draftOf(row) : emptyDraft(REMOTE_WORKSPACE_PROVIDERS[0]),
  );
  const setDraft = (patch: Partial<Draft>) => setDraftRaw((d) => ({ ...d, ...patch }));
  const [owner, setOwner] = useState<PickedOwner>(defaultOwner);
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState<RemoteWorkspaceTemplate[] | null>(null);
  const [resolvedOrg, setResolvedOrg] = useState<string>("");
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [parameters, setParameters] = useState<RemoteWorkspaceParameter[] | null>(null);
  const ttl = ttlOf(draft.ttlHours);
  const p = info(draft.provider);
  // A provider whose connections are a person's own takes no other owner.
  const effectiveOwner: PickedOwner = p.personalOnly ? "private" : owner;

  const loadTemplates = async (id: string, organizationId?: string) => {
    setTemplateError(null);
    try {
      const res = await api.listRemoteWorkspaceTemplates(id, organizationId || undefined);
      setTemplates(res.templates);
      setResolvedOrg(res.organizationId);
    } catch (err) {
      setTemplates(null);
      setTemplateError(err instanceof Error ? err.message : "Couldn't list the templates");
    }
  };

  // A row whose last test reached the provider offers its templates (at
  // once, or when the test after adding it comes back).
  useEffect(() => {
    if (row && row.lastTestedAt && !row.lastError) {
      void loadTemplates(row.id, draft.organizationId || undefined);
    }
  }, [row?.id, row?.lastTestedAt, row?.lastError]);

  const template = templates?.find((t) => t.id === draft.templateId);
  useEffect(() => {
    setParameters(null);
    if (!row || !template) return;
    let live = true;
    api
      .getRemoteWorkspaceTemplateParameters(row.id, template.activeVersionId)
      .then((res) => live && setParameters(res.parameters))
      .catch(() => live && setParameters([]));
    return () => {
      live = false;
    };
  }, [row?.id, template?.activeVersionId]);

  const runTest = async () => {
    if (!row) return;
    const result = await test(row.id, row.provider);
    if (result.ok) await loadTemplates(row.id, draft.organizationId);
  };

  const save = async () => {
    if ("error" in ttl) return;
    setSaving(true);
    try {
      const body = bodyOf(draft, ttl.ttlMs);
      if (row) {
        await api.updateRemoteWorkspaceConnection(row.id, body);
        toast.success("Connection saved");
        onDone(true, row.id);
        return;
      }
      const { connection } = await api.createRemoteWorkspaceConnection({
        ...body,
        provider: draft.provider,
        name: body.name ?? "",
        token: draft.token.trim(),
        owner: ownerOf(effectiveOwner),
      });
      // The token is the server's now: nothing here holds it any more.
      setDraftRaw((d) => ({ ...d, token: "" }));
      toast.success("Connection added");
      onDone(true, connection.id);
      await test(connection.id, connection.provider);
    } catch (err) {
      toast.error(row ? "Failed to save the connection" : "Failed to add the connection", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const fillable = fillableParameters(parameters ?? []);
  const canSave =
    !!draft.name.trim() &&
    (!!draft.url.trim() || !!p.defaultUrl) &&
    (!!row || !!draft.token.trim()) &&
    !("error" in ttl);

  return (
    <InsetForm className={row ? "ml-10" : undefined}>
      {!row && (
        <Field label="Provider">
          <select
            aria-label="Provider"
            value={draft.provider}
            onChange={(e) => {
              const provider = e.target.value as RemoteWorkspaceProviderId;
              // Another provider's URL, name and parameters don't carry over.
              setDraftRaw((d) => ({
                ...emptyDraft(provider),
                token: d.token,
                ttlHours: d.ttlHours,
                name: d.name === info(d.provider).label ? info(provider).label : d.name,
              }));
            }}
            className={INPUT}
          >
            {REMOTE_WORKSPACE_PROVIDERS.map((id) => (
              <option key={id} value={id}>
                {info(id).label}
              </option>
            ))}
          </select>
        </Field>
      )}
      {ownerPicker?.(owner, setOwner, draft.provider)}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name">
          <input
            aria-label="Name"
            value={draft.name}
            onChange={(e) => setDraft({ name: e.target.value })}
            className={INPUT}
          />
        </Field>
        <Field label="URL" help={p.urlHelp}>
          <input
            aria-label="URL"
            value={draft.url}
            onChange={(e) => setDraft({ url: e.target.value })}
            placeholder={p.urlPlaceholder}
            spellCheck={false}
            className={INPUT}
          />
        </Field>
      </div>
      <Field
        label={p.tokenLabel}
        help={
          row?.tokenHint
            ? `Stored, ending in …${row.tokenHint}. Leave empty to keep it.`
            : `${p.tokenHelp} Optio seals it and never shows it again.`
        }
      >
        <input
          aria-label={p.tokenLabel}
          type="password"
          autoComplete="off"
          value={draft.token}
          onChange={(e) => setDraft({ token: e.target.value })}
          placeholder={row?.tokenHint ? `…${row.tokenHint}` : ""}
          className={INPUT}
        />
      </Field>
      <Field
        label="CA certificate"
        help={`PEM bundle of the private CA ${p.label}'s certificate is from.`}
      >
        <textarea
          aria-label="CA certificate"
          rows={3}
          value={draft.caPem}
          onChange={(e) => setDraft({ caPem: e.target.value })}
          placeholder="-----BEGIN CERTIFICATE-----"
          className={MONO_AREA}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.insecureSkipVerify}
          onChange={(e) => setDraft({ insecureSkipVerify: e.target.checked })}
        />
        Skip TLS verification
      </label>
      {draft.insecureSkipVerify && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          Anyone between Optio and {p.label} could read the token. For testing only — give the CA
          above instead.
        </p>
      )}

      {row && (
        <div className="space-y-3 pt-3 border-t border-border">
          {templates === null ? (
            <p className="text-xs text-text-muted">
              {templateError ?? `Test the connection to pick its default ${p.templateNoun}.`}
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {p.organizationLabel && (
                  <Field label={p.organizationLabel} help={p.organizationHelp ?? undefined}>
                    <input
                      aria-label={p.organizationLabel}
                      value={draft.organizationId}
                      onChange={(e) => setDraft({ organizationId: e.target.value })}
                      onBlur={() => void loadTemplates(row.id, draft.organizationId)}
                      placeholder={resolvedOrg}
                      spellCheck={false}
                      className={INPUT}
                    />
                  </Field>
                )}
                <Field label={`Default ${p.templateNoun}`}>
                  <select
                    aria-label={`Default ${p.templateNoun}`}
                    value={draft.templateId}
                    onChange={(e) => {
                      const t = templates.find((x) => x.id === e.target.value);
                      // Another template's parameters don't carry over; the checkout does.
                      const checkout = draft.defaultParameters[CHECKOUT];
                      setDraft({
                        templateId: e.target.value,
                        templateName: t ? t.displayName || t.name : "",
                        defaultParameters: checkout ? { [CHECKOUT]: checkout } : {},
                      });
                    }}
                    className={INPUT}
                  >
                    <option value="">None — work picks one</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.displayName || t.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {draft.provider === "coder" &&
                parameters &&
                !parameters.some((x) => x.name === "optio_token") && (
                  <p className="text-xs text-error">
                    This template has no <code className="font-mono">optio_token</code> parameter,
                    so its workspaces can&apos;t pair with Optio (docs/remote-workspaces.md,
                    “Coder”).
                  </p>
                )}
              {fillable.length > 0 && (
                <Field
                  label="Default parameters"
                  help={`Every new ${p.workspaceNoun} gets these; work can change them.`}
                >
                  <WorkspaceParameterFields
                    idPrefix={`workspace-default-${row.id}`}
                    parameters={fillable}
                    values={draft.defaultParameters}
                    onChange={(defaultParameters) => setDraft({ defaultParameters })}
                  />
                </Field>
              )}
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Checkout" help={`Where the repo is checked out; the agent works there.`}>
          <input
            aria-label="Checkout"
            value={draft.defaultParameters[CHECKOUT] ?? ""}
            onChange={(e) =>
              setDraft({
                defaultParameters: { ...draft.defaultParameters, [CHECKOUT]: e.target.value },
              })
            }
            placeholder={p.defaultCheckoutDir}
            spellCheck={false}
            className={INPUT}
          />
        </Field>
        <Field label="Stop after (hours)" help={"error" in ttl ? undefined : p.ttlHelp}>
          <input
            aria-label="Stop after (hours)"
            inputMode="decimal"
            value={draft.ttlHours}
            onChange={(e) => setDraft({ ttlHours: e.target.value })}
            className={INPUT}
          />
          {"error" in ttl && <p className="text-[11px] text-error mt-1">{ttl.error}</p>}
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.deleteWhenDone}
          onChange={(e) => setDraft({ deleteWhenDone: e.target.checked })}
        />
        Delete the {p.workspaceNoun} when the work ends
        <span className="text-xs text-text-muted">
          (otherwise it is {p.stopVerb === "pause" ? "paused" : "stopped"})
        </span>
      </label>

      <div className="flex flex-wrap justify-end items-center gap-3">
        <button onClick={() => onDone(false)} className={BTN_TEXT}>
          Cancel
        </button>
        {row && (
          <button onClick={runTest} className={BTN_HEADER}>
            <CheckCircle2 className="w-3 h-3" />
            Test
          </button>
        )}
        <button onClick={save} disabled={!canSave || saving} className={BTN_PRIMARY}>
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {row ? "Save" : "Add and test"}
        </button>
      </div>
      {!row && (
        <p className="text-[11px] text-text-muted">
          {capitalized(p.workspaceNoun)}s pair themselves with Optio — see
          docs/remote-workspaces.md, “{p.label}”, for what the {p.templateNoun} needs.
        </p>
      )}
    </InsetForm>
  );
}
