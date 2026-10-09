"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Eye, EyeOff, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import type { ConnectionProvider } from "@optio/shared";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/hooks/use-current-user";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { OwnerPicker } from "@/components/ui/owner-picker";
import { ConnectionMark } from "@/components/connection-mark";
import {
  ALL_REPOS,
  DefaultAssignmentsField,
  ProviderFields,
  assignmentRows,
  requiredMissing,
  schemaDefaults,
  type ConfigSchema,
  type ConfigValue,
  type DefaultAssignments,
} from "./provider-fields";

/**
 * The **Connect** modal: pick a logo (a service, a secret, an MCP server, an
 * HTTP API), name the account, fill in its fields, say where it is connected
 * by default, save. Users pick logos, never raw keys.
 */

export type OwnerScope = "organization" | "private";

export interface ConnectCreated {
  kind: "connection" | "secret" | "mcpServer";
  id: string;
  name: string;
}

export interface ConnectGalleryProps {
  open: boolean;
  onClose: () => void;
  onCreated: (entry: ConnectCreated) => void;
  /** Open straight on this provider's form (a slug, or `secret`). */
  initialProvider?: string;
  defaultOwner?: OwnerScope;
}

/** The order the Services tiles come in; anything else follows alphabetically. */
const SERVICE_ORDER = [
  "github-enhanced",
  "linear",
  "slack",
  "notion",
  "sentry",
  "postgres",
  "aws",
  "pylon",
  "pagerduty",
  "filesystem",
];

/** The providers the "Something else" tiles stand for. */
const CUSTOM_HTTP = "custom-http";
const CUSTOM_MCP = "custom-mcp";

/** The tile label of a provider ("GitHub" for the enhanced GitHub provider). */
export function providerLabel(p: Pick<ConnectionProvider, "slug" | "name">): string {
  return p.slug === "github-enhanced" ? "GitHub" : p.name;
}

/** The service tiles: built-in providers minus the custom ones, in the catalog order. */
export function serviceProviders(providers: readonly ConnectionProvider[]): ConnectionProvider[] {
  const rank = (p: ConnectionProvider) => {
    const i = SERVICE_ORDER.indexOf(p.slug);
    return i === -1 ? SERVICE_ORDER.length : i;
  };
  return providers
    .filter((p) => p.slug !== CUSTOM_HTTP && p.slug !== CUSTOM_MCP)
    .sort((a, b) => rank(a) - rank(b) || providerLabel(a).localeCompare(providerLabel(b)));
}

function matches(q: string, ...texts: Array<string | null | undefined>): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return texts.some((t) => (t ?? "").toLowerCase().includes(needle));
}

/** "Jon's AWS" for a private connection, "AWS" for the organization's. */
export function defaultConnectionName(
  provider: Pick<ConnectionProvider, "slug" | "name">,
  owner: OwnerScope,
  displayName: string | null | undefined,
): string {
  const label = providerLabel(provider);
  if (owner === "organization") return label;
  const first = (displayName ?? "").trim().split(/\s+/)[0];
  return first ? `${first}'s ${label}` : `My ${label}`;
}

type Step =
  | { kind: "pick" }
  | { kind: "provider"; provider: ConnectionProvider }
  | { kind: "secret" };

export function ConnectGallery({
  open,
  onClose,
  onCreated,
  initialProvider,
  defaultOwner,
}: ConnectGalleryProps) {
  const { user, isAdmin } = useCurrentUser();
  const [providers, setProviders] = useState<ConnectionProvider[] | null>(null);
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<Step>({ kind: "pick" });

  // Load the catalog each time the modal opens; reset the step to the start.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setQuery("");
    setStep({ kind: "pick" });
    api
      .listConnectionProviders()
      .then((res) => {
        if (!live) return;
        setProviders(res.providers);
        if (initialProvider === "secret") setStep({ kind: "secret" });
        else if (initialProvider) {
          const p = res.providers.find((x) => x.slug === initialProvider);
          if (p) setStep({ kind: "provider", provider: p });
        }
      })
      .catch((err) => {
        if (!live) return;
        setProviders([]);
        toast.error("Couldn't load the catalog", {
          description: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      live = false;
    };
  }, [open, initialProvider]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const services = useMemo(() => serviceProviders(providers ?? []), [providers]);
  const customHttp = providers?.find((p) => p.slug === CUSTOM_HTTP) ?? null;
  const customMcp = providers?.find((p) => p.slug === CUSTOM_MCP) ?? null;

  const owner0: OwnerScope = defaultOwner ?? (isAdmin ? "organization" : "private");

  if (!open) return null;

  const title =
    step.kind === "pick"
      ? "Connect"
      : step.kind === "secret"
        ? "Connect · Secret"
        : `Connect · ${providerLabel(step.provider)}`;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="connect-gallery"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-bg border border-border rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
      >
        <div className="sticky top-0 z-10 bg-bg-subtle flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold tracking-tight text-text-heading">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {step.kind === "pick" && (
          <div className="p-4 space-y-5">
            <div>
              <p className="text-sm font-medium text-text-heading mb-2">What are you connecting?</p>
              <SearchField
                value={query}
                onChange={setQuery}
                label="Search services"
                size="sm"
                autoFocus
              />
            </div>

            <section>
              <h3 className="text-[11px] uppercase tracking-wide text-text-muted mb-2">Services</h3>
              {providers === null ? (
                <p className="text-xs text-text-muted flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
                </p>
              ) : (
                <div className="grid sm:grid-cols-3 gap-2">
                  {services
                    .filter((p) => matches(query, providerLabel(p), p.name, p.description))
                    .map((p) => (
                      <Tile
                        key={p.slug}
                        testId={`connect-tile-${p.slug}`}
                        mark={<ConnectionMark icon={p.icon} kind="connection" size="lg" />}
                        name={providerLabel(p)}
                        description={p.description ?? ""}
                        onClick={() => setStep({ kind: "provider", provider: p })}
                      />
                    ))}
                  {services.length > 0 &&
                    services.filter((p) => matches(query, providerLabel(p), p.name, p.description))
                      .length === 0 && (
                      <p className="text-xs text-text-muted sm:col-span-3">
                        No service matches “{query}”.
                      </p>
                    )}
                </div>
              )}
            </section>

            <section>
              <h3 className="text-[11px] uppercase tracking-wide text-text-muted mb-2">
                Something else
              </h3>
              <div className="grid sm:grid-cols-3 gap-2">
                {matches(query, "Secret", "A single value as an env var") && (
                  <Tile
                    testId="connect-tile-secret"
                    mark={<ConnectionMark kind="secret" size="lg" />}
                    name="Secret"
                    description="A single value as an env var"
                    onClick={() => setStep({ kind: "secret" })}
                  />
                )}
                {matches(query, "MCP server", "A command that serves tools") && (
                  <Tile
                    testId="connect-tile-mcp"
                    mark={<ConnectionMark icon="terminal" kind="mcpServer" size="lg" />}
                    name="MCP server"
                    description="A command that serves tools"
                    disabled={providers !== null && !customMcp}
                    onClick={() => customMcp && setStep({ kind: "provider", provider: customMcp })}
                  />
                )}
                {matches(query, "HTTP API", "Any REST API with a token") && (
                  <Tile
                    testId="connect-tile-http"
                    mark={<ConnectionMark icon="globe" kind="connection" size="lg" />}
                    name="HTTP API"
                    description="Any REST API with a token"
                    disabled={providers !== null && !customHttp}
                    onClick={() =>
                      customHttp && setStep({ kind: "provider", provider: customHttp })
                    }
                  />
                )}
              </div>
            </section>
          </div>
        )}

        {step.kind === "provider" && (
          <ProviderForm
            key={step.provider.slug}
            provider={step.provider}
            isAdmin={isAdmin}
            displayName={user?.displayName}
            defaultOwner={owner0}
            onBack={() => setStep({ kind: "pick" })}
            onCancel={onClose}
            onCreated={(entry) => {
              onCreated(entry);
              onClose();
            }}
          />
        )}

        {step.kind === "secret" && (
          <SecretForm
            isAdmin={isAdmin}
            defaultOwner={owner0}
            onBack={() => setStep({ kind: "pick" })}
            onCancel={onClose}
            onCreated={(entry) => {
              onCreated(entry);
              onClose();
            }}
          />
        )}
      </div>
    </div>
  );
}

function Tile({
  testId,
  mark,
  name,
  description,
  onClick,
  disabled,
}: {
  testId: string;
  mark: React.ReactNode;
  name: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      title={disabled ? "Not available on this deployment" : undefined}
      className={cn(
        "flex items-center gap-3 text-left rounded-lg border border-border bg-bg-card px-3 py-2.5 transition-colors",
        "hover:border-primary/50 hover:bg-bg-hover disabled:opacity-50 disabled:pointer-events-none",
      )}
    >
      {mark}
      <span className="min-w-0">
        <span className="block text-sm font-medium text-text truncate">{name}</span>
        <span className="block text-[11px] text-text-muted truncate">{description}</span>
      </span>
    </button>
  );
}

function BackLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text"
    >
      <ArrowLeft className="w-3 h-3" /> Connect something else
    </button>
  );
}

function OwnerField({
  value,
  onChange,
  what,
  isAdmin,
}: {
  value: OwnerScope;
  onChange: (v: OwnerScope) => void;
  what: string;
  isAdmin: boolean;
}) {
  return <OwnerPicker value={value} onChange={onChange} what={what} canOrg={isAdmin} />;
}

// ── Step 2: a provider's form ───────────────────────────────────────────────

function ProviderForm({
  provider,
  isAdmin,
  displayName,
  defaultOwner,
  onBack,
  onCancel,
  onCreated,
}: {
  provider: ConnectionProvider;
  isAdmin: boolean;
  displayName: string | null | undefined;
  defaultOwner: OwnerScope;
  onBack: () => void;
  onCancel: () => void;
  onCreated: (entry: ConnectCreated) => void;
}) {
  const schema = (provider.configSchema ?? null) as ConfigSchema | null;
  const [owner, setOwner] = useState<OwnerScope>(isAdmin ? defaultOwner : "private");
  const [name, setName] = useState(() => defaultConnectionName(provider, owner, displayName));
  const [nameTouched, setNameTouched] = useState(false);
  const [config, setConfig] = useState<ConfigValue>(() => schemaDefaults(schema));
  const [assignments, setAssignments] = useState<DefaultAssignments>(ALL_REPOS);
  const [saving, setSaving] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const changeOwner = useCallback(
    (next: OwnerScope) => {
      setOwner(next);
      if (!nameTouched) setName(defaultConnectionName(provider, next, displayName));
    },
    [nameTouched, provider, displayName],
  );

  const missing = requiredMissing(schema, config);
  const canSave = name.trim().length > 0 && missing.length === 0 && !saving;
  const hasHealthCheck = !!provider.healthCheck;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setTestError(null);
    try {
      const { connection } = await api.createConnection({
        providerSlug: provider.slug,
        name: name.trim(),
        owner: owner === "private" ? "me" : "workspace",
        config: stripBlank(config),
        assignments: assignmentRows(assignments),
      });
      if (hasHealthCheck) {
        try {
          const tested = await api.testConnection(connection.id);
          if (tested.connection.status === "error") {
            setTestError(tested.connection.statusMessage ?? "The test failed.");
            setSaving(false);
            onCreated({ kind: "connection", id: connection.id, name: connection.name });
            return;
          }
        } catch (err) {
          setTestError(err instanceof Error ? err.message : String(err));
          setSaving(false);
          onCreated({ kind: "connection", id: connection.id, name: connection.name });
          return;
        }
      }
      toast.success(`Connected ${connection.name}`);
      onCreated({ kind: "connection", id: connection.id, name: connection.name });
    } catch (err) {
      setSaving(false);
      toast.error("Couldn't save the connection", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <form
      className="p-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <BackLink onClick={onBack} />
      <div className="flex items-center gap-3">
        <ConnectionMark icon={provider.icon} kind="connection" size="lg" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-heading">{providerLabel(provider)}</p>
          {provider.description && (
            <p className="text-xs text-text-muted truncate">{provider.description}</p>
          )}
        </div>
      </div>

      <OwnerField value={owner} onChange={changeOwner} what="connection" isAdmin={isAdmin} />

      <div>
        <label htmlFor="connect-name" className="block text-xs text-text-muted mb-1">
          Name
        </label>
        <input
          id="connect-name"
          type="text"
          aria-label="Connection name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameTouched(true);
          }}
          required
          className={inputClass()}
        />
      </div>

      <ProviderFields
        schema={schema}
        value={config}
        onChange={setConfig}
        mode="create"
        idPrefix={`connect-${provider.slug}`}
      />

      {provider.note && <AgentNote note={provider.note} />}

      <DefaultAssignmentsField value={assignments} onChange={setAssignments} />

      {testError && (
        <div className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs">
          <p className="text-error font-medium">Test failed: {testError}</p>
          <p className="text-text-muted mt-0.5">
            Saved anyway — fix the fields under Library → Connections and test again.
          </p>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave}>
          {saving && <Loader2 className="animate-spin" />}
          {hasHealthCheck ? "Test & save" : "Save"}
        </Button>
      </div>
    </form>
  );
}

/** The provider's note, read-only: what the agent is told about the service. */
function AgentNote({ note }: { note: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-subtle/60 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-text-muted mb-1">
        What the agent is told
      </p>
      <p className="text-xs text-text-muted whitespace-pre-wrap">{note}</p>
    </div>
  );
}

/** Drop blank strings so an untouched optional field isn't stored as "". */
function stripBlank(config: ConfigValue): ConfigValue {
  const out: ConfigValue = {};
  for (const [k, v] of Object.entries(config)) {
    if (typeof v === "string" && v.trim() === "") continue;
    out[k] = v;
  }
  return out;
}

// ── Step 2: a bare secret ───────────────────────────────────────────────────

function SecretForm({
  isAdmin,
  defaultOwner,
  onBack,
  onCancel,
  onCreated,
}: {
  isAdmin: boolean;
  defaultOwner: OwnerScope;
  onBack: () => void;
  onCancel: () => void;
  onCreated: (entry: ConnectCreated) => void;
}) {
  const [owner, setOwner] = useState<OwnerScope>(isAdmin ? defaultOwner : "private");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const canSave = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && value.length > 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await api.createSecret({ name, value, scope: owner === "private" ? "user" : "global" });
      toast.success(`Saved ${name}`);
      onCreated({ kind: "secret", id: name, name });
    } catch (err) {
      setSaving(false);
      toast.error("Couldn't save the secret", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <form
      className="p-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <BackLink onClick={onBack} />
      <div className="flex items-center gap-3">
        <ConnectionMark kind="secret" size="lg" />
        <div>
          <p className="text-sm font-medium text-text-heading">Secret</p>
          <p className="text-xs text-text-muted">
            A single value, given to the agent as an env var.
          </p>
        </div>
      </div>

      <OwnerField value={owner} onChange={setOwner} what="secret" isAdmin={isAdmin} />

      <div>
        <label htmlFor="connect-secret-name" className="block text-xs text-text-muted mb-1">
          Name <span className="text-text-muted/50">(UPPER_SNAKE_CASE, the env var's name)</span>
        </label>
        <input
          id="connect-secret-name"
          type="text"
          aria-label="Secret name"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
          placeholder="MY_API_TOKEN"
          autoComplete="off"
          spellCheck={false}
          className={cn(inputClass(), "font-mono")}
        />
      </div>
      <div>
        <label htmlFor="connect-secret-value" className="block text-xs text-text-muted mb-1">
          Value
        </label>
        <div className="relative">
          <input
            id="connect-secret-value"
            type={show ? "text" : "password"}
            aria-label="Secret value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className={cn(inputClass(), "pr-9 font-mono")}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? "Hide value" : "Show value"}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-text-muted hover:text-text"
          >
            {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave}>
          {saving && <Loader2 className="animate-spin" />}
          Save
        </Button>
      </div>
    </form>
  );
}
