"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Star, Trash2, KeyRound } from "lucide-react";
import { api, type WorkspaceGitLabServer, type WorkspaceGitLabSettings } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import {
  BTN_PRIMARY,
  BTN_ROW,
  BTN_ROW_DANGER,
  BTN_SECONDARY,
  CardFooter,
  Field,
  INPUT,
  InsetForm,
  SkeletonCard,
  Tag,
} from "./settings-ui";

/**
 * Workspace Settings → GitLab: the GitLab servers this workspace signs in to
 * with its own tokens. A token is used for this workspace's work only — no
 * other workspace can use it — and it comes before the deployment's. Admins
 * add, replace, re-default and remove servers; everyone else sees the list.
 * A host must be one the operator allows (gitlab.com or GITLAB_HOSTS).
 */
export function WorkspaceGitLabSettingsCard({ isAdmin }: { isAdmin: boolean }) {
  const [settings, setSettings] = useState<WorkspaceGitLabSettings | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api
      .getWorkspaceGitLab()
      .then((s) => {
        setSettings(s);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  const label = "GitLab";
  const hint = "The GitLab servers this workspace signs in to, with its own tokens";
  if (failed && !settings) return null;
  if (!settings) return <SkeletonCard label={label} hint={hint} rows={2} />;

  const { servers, allowedHosts, deploymentFallback } = settings;
  const unusedHosts = allowedHosts.filter((h) => !servers.some((s) => s.host === h));

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={
        servers.length
          ? servers.length === 1
            ? servers[0].host
            : `${servers.length} servers`
          : deploymentFallback
            ? "the deployment's"
            : "not set up"
      }
      bodyClassName="p-4 space-y-4"
    >
      <p className="text-xs text-text-muted">
        Tokens saved here are used for this workspace&apos;s work only — cloning, merge requests, CI
        status, issues — and no other workspace can use them.{" "}
        {deploymentFallback
          ? "Where this workspace has no token of its own, it uses the deployment's GitLab credentials."
          : "This workspace doesn't use the deployment's GitLab credentials (a deployment admin can share them with every workspace under Settings → Deployment secrets)."}
      </p>

      {servers.length > 0 ? (
        <ul
          className="divide-y divide-border rounded-md border border-border"
          aria-label="GitLab servers"
        >
          {servers.map((s) => (
            <ServerRow key={s.id} server={s} isAdmin={isAdmin} onChanged={load} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-text-muted" data-testid="gitlab-empty">
          No GitLab server yet.
          {isAdmin ? " Add one to let this workspace's work use GitLab with its own token." : ""}
        </p>
      )}

      {isAdmin &&
        (adding ? (
          <AddServerForm
            hosts={unusedHosts.length ? unusedHosts : allowedHosts}
            makeDefault={servers.length === 0}
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false);
              load();
            }}
          />
        ) : (
          <button type="button" onClick={() => setAdding(true)} className={BTN_SECONDARY}>
            <Plus className="w-3.5 h-3.5" />
            Add GitLab server
          </button>
        ))}

      {!isAdmin && (
        <CardFooter note="Only workspace admins can change the workspace's GitLab servers.">
          {null}
        </CardFooter>
      )}
    </SectionCard>
  );
}

function ServerRow({
  server,
  isAdmin,
  onChanged,
}: {
  server: WorkspaceGitLabServer;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (what: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await what();
      toast.success(done);
      setReplacing(false);
      setToken("");
      onChanged();
    } catch (err) {
      toast.error("Couldn't save", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="p-3 space-y-2" data-testid={`gitlab-server-${server.host}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-sm">{server.host}</span>
        {server.isDefault && <Tag>Default</Tag>}
        {!server.hasToken && <Tag tone="warning">No token</Tag>}
        <span className="text-xs text-text-muted">
          {server.accountUsername ? `signs in as @${server.accountUsername}` : ""}
        </span>
        {isAdmin && (
          <div className="ml-auto flex items-center gap-1">
            {!server.isDefault && (
              <button
                type="button"
                className={BTN_ROW}
                disabled={busy}
                onClick={() =>
                  run(
                    () => api.updateWorkspaceGitLabServer(server.id, { isDefault: true }),
                    `${server.host} is the default`,
                  )
                }
              >
                <Star className="w-3.5 h-3.5" />
                Make default
              </button>
            )}
            <button
              type="button"
              className={BTN_ROW}
              disabled={busy}
              onClick={() => setReplacing((r) => !r)}
            >
              <KeyRound className="w-3.5 h-3.5" />
              Replace token
            </button>
            <button
              type="button"
              className={BTN_ROW_DANGER}
              disabled={busy}
              aria-label={`Remove ${server.host}`}
              onClick={() => {
                if (
                  !confirm(
                    `Remove ${server.host}? This workspace's work on it will have no GitLab token.`,
                  )
                )
                  return;
                void run(
                  () => api.removeWorkspaceGitLabServer(server.id),
                  `${server.host} removed`,
                );
              }}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>
      {replacing && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!token.trim()) return;
            void run(
              () => api.updateWorkspaceGitLabServer(server.id, { token: token.trim() }),
              "Token replaced",
            );
          }}
        >
          <input
            type="password"
            autoComplete="off"
            placeholder="glpat-..."
            aria-label={`New token for ${server.host}`}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className={`${INPUT} font-mono`}
          />
          <button type="submit" className={BTN_PRIMARY} disabled={busy || !token.trim()}>
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Save
          </button>
        </form>
      )}
    </li>
  );
}

function AddServerForm({
  hosts,
  makeDefault,
  onCancel,
  onSaved,
}: {
  hosts: string[];
  makeDefault: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [host, setHost] = useState(hosts.find((h) => h !== "gitlab.com") ?? hosts[0] ?? "");
  const [token, setToken] = useState("");
  const [isDefault, setIsDefault] = useState(makeDefault);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const { server } = await api.addWorkspaceGitLabServer({
        host,
        token: token.trim(),
        isDefault,
      });
      toast.success(
        server.accountUsername
          ? `${server.host} saved — signs in as @${server.accountUsername}`
          : `${server.host} saved`,
      );
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <InsetForm>
      <form
        className="space-y-3"
        aria-label="Add GitLab server"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field
            label="Server"
            help="gitlab.com, or a server the deployment operator listed in GITLAB_HOSTS."
          >
            <select
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className={INPUT}
              aria-label="GitLab server"
            >
              {hosts.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Access token"
            help={
              <>
                A personal, project or group token with <code>api</code>,{" "}
                <code>read_repository</code> and <code>write_repository</code>. It is checked
                against the server before it is saved.
              </>
            }
          >
            <input
              type="password"
              autoComplete="off"
              placeholder="glpat-..."
              aria-label="Access token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className={`${INPUT} font-mono`}
            />
          </Field>
        </div>
        {!makeDefault && (
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
            />
            Make this the default server (listed first when adding a repository)
          </label>
        )}
        {error && (
          <p className="text-xs text-error" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <button type="submit" className={BTN_PRIMARY} disabled={saving || !host || !token.trim()}>
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {saving ? "Checking..." : "Save"}
          </button>
          <button type="button" className={BTN_SECONDARY} onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        </div>
      </form>
    </InsetForm>
  );
}
