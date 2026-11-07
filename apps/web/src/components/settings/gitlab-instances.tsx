"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SectionCard } from "@/components/ui/section-card";
import { gitlabInstancesApi, type GitLabInstance } from "@/lib/gitlab-instances-api";
import { BTN_PRIMARY, BTN_TEXT, INPUT } from "./settings-ui";

export function GitLabInstancesSettings() {
  const [view, setView] = useState<{ instances: GitLabInstance[]; canEdit: boolean } | null>(null);
  const [editing, setEditing] = useState<GitLabInstance | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [displayName, setName] = useState("");
  const [baseUrl, setUrl] = useState("");
  const [caPem, setCa] = useState("");
  const [token, setToken] = useState("");
  const [removeToken, setRemoveToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const reload = () => gitlabInstancesApi.list().then(setView);
  useEffect(() => {
    void reload().catch(() => {});
  }, []);
  if (!view) return null;

  const open = (row: GitLabInstance | null) => {
    setEditing(row);
    setName(row?.displayName ?? "");
    setUrl(row?.baseUrl ?? "");
    setCa(row?.caPem ?? "");
    setToken("");
    setRemoveToken(false);
    setResult("");
    setFormOpen(true);
  };
  const body = () => ({
    displayName,
    baseUrl,
    caPem: caPem || null,
    ...(removeToken ? { token: null } : token ? { token } : {}),
  });
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard label="GitLab instances" hint="GitLab.com and self-managed servers">
      <div className="space-y-4">
        {view.instances.map((row) => (
          <div key={row.id} className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">{row.displayName}</div>
              <div className="text-xs text-text-muted">{row.baseUrl}</div>
              <div className="text-xs text-text-muted">
                {row.source === "environment"
                  ? "From the deployment · read only"
                  : row.hasToken
                    ? "Default token saved"
                    : "Uses existing GitLab tokens"}
              </div>
            </div>
            {view.canEdit && row.source === "app" && (
              <div className="flex gap-2">
                <button type="button" className={BTN_TEXT} onClick={() => open(row)}>
                  Edit
                </button>
                <button
                  type="button"
                  className={BTN_TEXT}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await gitlabInstancesApi.remove(row.id);
                      await reload();
                      if (editing?.id === row.id) setFormOpen(false);
                    })
                  }
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        ))}
        {view.canEdit && !formOpen && (
          <button type="button" className={BTN_PRIMARY} onClick={() => open(null)}>
            Add GitLab instance
          </button>
        )}
        {view.canEdit && formOpen && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await gitlabInstancesApi.save(body(), editing?.id);
                await reload();
                setFormOpen(false);
                toast.success("GitLab instance saved");
              });
            }}
          >
            <label className="block text-sm">
              Display name
              <input
                className={INPUT}
                value={displayName}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            <label className="block text-sm">
              Base URL
              <input
                className={INPUT}
                value={baseUrl}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://git.example.com/gitlab"
                required
              />
            </label>
            <p className="text-xs text-text-muted">
              Registering a host does not bypass outbound network restrictions. Private and loopback
              addresses may remain blocked; test the connection before saving.
            </p>
            <label className="block text-sm">
              CA certificate (PEM, optional)
              <textarea
                className={INPUT}
                value={caPem}
                onChange={(e) => setCa(e.target.value)}
                rows={4}
              />
            </label>
            <label className="block text-sm">
              Default token
              <input
                className={INPUT}
                type="password"
                autoComplete="new-password"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setRemoveToken(false);
                }}
                placeholder={editing?.hasToken ? "Leave blank to keep saved token" : "Optional"}
              />
            </label>
            {editing?.hasToken && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={removeToken}
                  onChange={(e) => setRemoveToken(e.target.checked)}
                />
                Remove saved token
              </label>
            )}
            <p className="text-xs text-text-muted">
              Personal tokens take precedence; this instance default precedes workspace and
              organization tokens. Use a project or group access token with the API and repository
              permissions your work needs.
            </p>
            <div className="flex gap-2">
              <button className={BTN_PRIMARY} disabled={busy} type="submit">
                Save
              </button>
              <button
                className={BTN_TEXT}
                disabled={busy || !baseUrl}
                type="button"
                onClick={() =>
                  void run(async () => {
                    const test = await gitlabInstancesApi.test({ ...body(), id: editing?.id });
                    setResult(
                      test.ok
                        ? `Connected to GitLab ${test.version} as @${test.username}`
                        : (test.error ?? "Connection failed"),
                    );
                  })
                }
              >
                Test connection
              </button>
              <button
                className={BTN_TEXT}
                disabled={busy}
                type="button"
                onClick={() => setFormOpen(false)}
              >
                Cancel
              </button>
            </div>
            {result && (
              <p role="status" className="text-sm">
                {result}
              </p>
            )}
          </form>
        )}
      </div>
    </SectionCard>
  );
}
