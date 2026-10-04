"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, Eye, FileCode2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { ConfigApplyResult, ConfigPlanItem, ConfigStatus } from "@optio/shared";
import { api } from "@/lib/api-client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { SectionCard } from "@/components/ui/section-card";
import { BTN_HEADER, SkeletonCard, Tag } from "@/components/settings/settings-ui";

/**
 * Settings → Config as code: the configuration directory a cluster reads
 * (`OPTIO_CONFIG_DIR`), its workspace, how the last sync went — counts and
 * every error with its file — and, for admins, **Sync now** and **Preview** (a
 * dry run). Without a directory the card says how to turn it on, and the
 * export and the CLI are there either way. docs/config-as-code.md.
 */
export function ConfigAsCodeSettings() {
  const { isAdmin, loaded } = useCurrentUser();
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"sync" | "preview" | null>(null);
  const [preview, setPreview] = useState<ConfigApplyResult | null>(null);

  const refresh = useCallback(() => {
    api
      .getConfigStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? "preview" : "sync");
    try {
      const result = await api.syncConfigSource(dryRun);
      if (dryRun) {
        setPreview(result);
      } else {
        setPreview(null);
        const s = result.summary;
        toast.success(
          s.errors
            ? `Synced with ${s.errors} error${s.errors === 1 ? "" : "s"}`
            : `Synced: ${s.created} created, ${s.updated} updated, ${s.pruned} pruned`,
        );
        refresh();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy(null);
    }
  };

  const label = "Config as code";
  const hint =
    "YAML manifests a cluster reads · Jobs, agents, prompts, repos, MCP servers, skills, connections";
  if (loading || !loaded) return <SkeletonCard label={label} hint={hint} rows={2} />;

  const source = status?.source ?? null;
  const last = source?.lastSync ?? null;

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={
        source ? (last ? summaryLine(last) : "Not synced yet") : "Off — no configuration directory"
      }
      actions={
        <div className="flex items-center gap-2">
          <a
            href={api.configExportUrl()}
            className={BTN_HEADER}
            title="Everything in this workspace as manifests"
          >
            <Download className="w-3.5 h-3.5" />
            Export YAML
          </a>
          {source && isAdmin && (
            <>
              <button onClick={() => run(true)} disabled={busy !== null} className={BTN_HEADER}>
                <Eye className="w-3.5 h-3.5" />
                {busy === "preview" ? "Planning…" : "Preview"}
              </button>
              <button onClick={() => run(false)} disabled={busy !== null} className={BTN_HEADER}>
                <RefreshCw className={`w-3.5 h-3.5 ${busy === "sync" ? "animate-spin" : ""}`} />
                {busy === "sync" ? "Syncing…" : "Sync now"}
              </button>
            </>
          )}
        </div>
      }
      bodyClassName="p-4 space-y-3"
    >
      {source ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-text-muted">Directory</dt>
            <dd className="font-mono text-text-heading break-all">{source.path}</dd>
            <dt className="text-text-muted">Reads</dt>
            <dd className="text-text-heading">
              every {Math.round(source.intervalMs / 1000)}s · prune {source.prune ? "on" : "off"}
              {source.origin === "env" && (
                <span className="text-text-muted"> · set by the deployment</span>
              )}
            </dd>
            <dt className="text-text-muted">Last sync</dt>
            <dd className="text-text-heading">
              {source.lastSyncAt ? new Date(source.lastSyncAt).toLocaleString() : "never"}
              {source.lastSyncHash && (
                <span className="text-text-muted font-mono"> · {source.lastSyncHash}</span>
              )}
            </dd>
          </dl>
          {source.lastSyncError && (
            <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
              {source.lastSyncError}
            </p>
          )}
          {last && <ResultSummary result={last} />}
          {preview && (
            <div className="rounded-lg border border-border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-heading">
                  Preview — what the next sync would do
                </span>
                <button
                  onClick={() => setPreview(null)}
                  className="text-xs text-text-muted hover:text-text-heading"
                >
                  Close
                </button>
              </div>
              <ResultSummary result={preview} all />
            </div>
          )}
        </>
      ) : (
        <p className="text-xs text-text-muted">
          Mount a directory of manifests into the API and set{" "}
          <code className="text-primary">OPTIO_CONFIG_DIR</code> (Helm:{" "}
          <code className="text-primary">configAsCode.enabled</code>) to have this workspace follow
          it. Start from what you have: <strong>Export YAML</strong> here, or{" "}
          <code className="text-primary">optio export -o optio/</code>, then commit the files.
        </p>
      )}
      <p className="text-[11px] text-text-muted">
        <FileCode2 className="inline w-3 h-3 mr-1 -mt-0.5" />
        Schema for editors and CI:{" "}
        <a
          href={status?.schemaUrl ?? "/api/config/schema.json"}
          className="text-primary hover:underline"
        >
          {status?.schemaUrl ?? "/api/config/schema.json"}
        </a>
        {" · "}
        <code>optio apply -f optio/</code> applies files by hand (no pruning).
      </p>
    </SectionCard>
  );
}

function summaryLine(result: ConfigApplyResult): string {
  const s = result.summary;
  const parts = [
    s.created && `${s.created} created`,
    s.updated && `${s.updated} updated`,
    s.reverted && `${s.reverted} reverted`,
    s.pruned && `${s.pruned} pruned`,
    s.errors && `${s.errors} error${s.errors === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : `${s.unchanged} unchanged`;
}

const TONE: Record<ConfigPlanItem["action"], "primary" | "warning" | "error" | undefined> = {
  create: "primary",
  update: "primary",
  adopt: "primary",
  replace: "warning",
  prune: "error",
  error: "error",
  unchanged: undefined,
};

/** Counts, then the items worth reading: errors always, everything with `all`. */
function ResultSummary({ result, all = false }: { result: ConfigApplyResult; all?: boolean }) {
  const s = result.summary;
  const items = result.items.filter((i) => all || i.action === "error" || i.reverted);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <Tag>{s.unchanged} unchanged</Tag>
        {s.created > 0 && <Tag tone="primary">{s.created} created</Tag>}
        {s.updated > 0 && <Tag tone="primary">{s.updated} updated</Tag>}
        {s.reverted > 0 && <Tag tone="warning">{s.reverted} UI edits put back</Tag>}
        {s.adopted > 0 && <Tag tone="primary">{s.adopted} adopted</Tag>}
        {s.replaced > 0 && <Tag tone="warning">{s.replaced} replaced</Tag>}
        {s.pruned > 0 && <Tag tone="error">{s.pruned} pruned</Tag>}
        {s.errors > 0 && <Tag tone="error">{s.errors} errors</Tag>}
      </div>
      {items.length > 0 && (
        <ul className="divide-y divide-border/60 rounded-md border border-border/70 text-xs">
          {items.map((item, i) => (
            <li
              key={`${item.kind}-${item.name}-${i}`}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5"
            >
              <Tag tone={TONE[item.action]}>{item.reverted ? "reverted" : item.action}</Tag>
              <span className="font-medium text-text-heading">
                {item.kind}/{item.name}
              </span>
              <code className="text-text-muted">{item.path}</code>
              {(item.message || item.changes?.length) && (
                <span className="basis-full text-text-muted">
                  {item.message ?? item.changes?.join(", ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
