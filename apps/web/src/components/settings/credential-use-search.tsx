"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Download, Loader2, Search } from "lucide-react";
import { api, type CredentialUse, type CredentialUseQuery } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import { Button } from "@/components/ui/button";
import { INPUT } from "./settings-ui";

/**
 * Settings → Access → Credential use: after a token or key leaks, which runs
 * were given it. Search by the leaked value (sent once to be hashed, never
 * stored), by the credential's name, or by a fingerprint from an earlier
 * result, within a time range; export the result as CSV. Shown to
 * deployment admins only (routes/credential-use.ts).
 */

const RUN_LABEL: Record<string, string> = {
  task: "Task",
  "job-run": "Job run",
  review: "Review",
  "agent-turn": "Agent turn",
  session: "Session",
};

function runHref(row: CredentialUse): string | null {
  if (row.runKind === "task") return `/tasks/${row.runId}`;
  if (row.runKind === "session") return `/sessions/${row.runId}`;
  return null;
}

/** A datetime-local input's value as an ISO time, or undefined. */
function iso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function CredentialUseSearch() {
  const [canSee, setCanSee] = useState(false);
  const [value, setValue] = useState("");
  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<"search" | "export" | null>(null);
  const [result, setResult] = useState<{
    rows: CredentialUse[];
    truncated: boolean;
    fingerprint: string | null;
  } | null>(null);

  useEffect(() => {
    api
      .getDeploymentSettings()
      .then((s) => setCanSee(s.canEdit))
      .catch(() => {});
  }, []);

  if (!canSee) return null;

  const query = (): CredentialUseQuery => ({
    ...(value.trim() ? { value } : {}),
    ...(name.trim() ? { name: name.trim() } : {}),
    from: iso(from),
    to: iso(to),
  });

  const search = async () => {
    if (busy) return;
    setBusy("search");
    try {
      setResult(await api.searchCredentialUse(query()));
    } catch (err) {
      toast.error("Couldn't search", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const exportCsv = async () => {
    if (busy) return;
    setBusy("export");
    try {
      const csv = await api.exportCredentialUse(query());
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `credential-use-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error("Couldn't export", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SectionCard
      label="Credential use"
      hint="Which runs were given a token or key"
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        Every run records which credentials it was given: kind, scope, name and a fingerprint, never
        the value. Paste a leaked value to find the runs that used it; it is sent once to be hashed
        and is not stored or logged. Searches and exports are in the action log.
      </p>
      <form
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste a credential value"
          aria-label="Credential value"
          className={INPUT}
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="or its name, e.g. GITLAB_TOKEN"
          aria-label="Credential name"
          className={INPUT}
        />
        <label className="text-xs text-text-muted space-y-1">
          <span>Used from</span>
          <input
            type="datetime-local"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            aria-label="Used from"
            className={INPUT}
          />
        </label>
        <label className="text-xs text-text-muted space-y-1">
          <span>Used until</span>
          <input
            type="datetime-local"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            aria-label="Used until"
            className={INPUT}
          />
        </label>
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" disabled={busy !== null}>
            {busy === "search" ? <Loader2 className="animate-spin" /> : <Search />}
            Search
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => void exportCsv()}
          >
            {busy === "export" ? <Loader2 className="animate-spin" /> : <Download />}
            Export CSV
          </Button>
        </div>
      </form>

      {result && (
        <div className="space-y-2" data-testid="credential-use-result">
          <p className="text-xs text-text-muted">
            {result.rows.length === 0
              ? "No run was given a matching credential."
              : `${result.rows.length} ${result.rows.length === 1 ? "match" : "matches"}${
                  result.truncated ? " (more exist: narrow the time range or export)" : ""
                }.`}
            {result.fingerprint && (
              <>
                {" "}
                Fingerprint <code className="px-1 rounded bg-bg">{result.fingerprint}</code>
              </>
            )}
          </p>
          {result.rows.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="bg-bg-subtle/70 text-left text-text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Used</th>
                    <th className="px-3 py-2 font-medium">Run</th>
                    <th className="px-3 py-2 font-medium">Workspace</th>
                    <th className="px-3 py-2 font-medium">Person</th>
                    <th className="px-3 py-2 font-medium">Repository</th>
                    <th className="px-3 py-2 font-medium">Credential</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {result.rows.map((row) => {
                    const href = runHref(row);
                    const label = `${RUN_LABEL[row.runKind] ?? row.runKind} ${row.runId.slice(0, 8)}`;
                    return (
                      <tr key={row.id}>
                        <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                          {new Date(row.usedAt).toLocaleString()}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {href ? (
                            <Link href={href} className="text-primary hover:underline">
                              {label}
                            </Link>
                          ) : (
                            <span title={row.runId}>{label}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">{row.workspaceName ?? "—"}</td>
                        <td className="px-3 py-2">
                          {row.userName ?? row.userEmail ?? "Organization"}
                        </td>
                        <td className="px-3 py-2 break-all">{row.repoUrl ?? "—"}</td>
                        <td className="px-3 py-2">
                          <span className="font-mono">{row.name}</span>
                          <span className="text-text-muted">
                            {" "}
                            · {row.kind}, {row.scope}
                            {row.host ? `, ${row.host}` : ""}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </SectionCard>
  );
}
