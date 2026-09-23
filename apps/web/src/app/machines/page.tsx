"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ExternalLink, FolderGit2, Laptop, Merge, RefreshCw } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatRelativeTime } from "@/lib/utils";
import { usePageTitle } from "@/hooks/use-page-title";
import { useLocalHosts } from "@/hooks/use-local-hosts";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { shortDir } from "@/lib/work-feed";
import { AutomationsSection } from "@/components/local/automations-section";
import { likelySameComputer, mergeTargets } from "@/components/local/host-merge";

/**
 * Your paired machines (Optio Local hosts) and the directories each one
 * offers as a place to run work. Pairing is setup, not daily work, so
 * this lives in the Library next to Repos. Local Automations (agent /
 * terminal specs that fire on events in one of these directories) are
 * edited here too — they're per-machine configuration, not live work.
 */
export default function MachinesPage() {
  usePageTitle("Machines");
  const { hosts, loading, refetch } = useLocalHosts();

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        icon={Laptop}
        title="Machines"
        description="Computers paired with Optio Local. A session that runs “on my machine” runs in one of these directories, with that machine's own agent CLI and login."
        actions={
          <button
            onClick={refetch}
            className="p-2 rounded-lg hover:bg-bg-hover text-text-muted transition-all btn-press hover:text-text"
            title="Refresh"
          >
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
          </button>
        }
      />

      {loading && hosts.length === 0 ? (
        <div className="h-32 skeleton-shimmer rounded-lg" />
      ) : hosts.length === 0 ? (
        <EmptyState
          icon={Laptop}
          title="No machines paired"
          description={
            <>
              On the computer you want to use, run <code className="font-mono">optio login</code>{" "}
              then <code className="font-mono">optio local up</code>, and add directories with{" "}
              <code className="font-mono">optio local add &lt;dir&gt;</code>.
            </>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {hosts.map((h: any) => (
            <div key={h.id} className="rounded-xl border border-border/70 bg-bg-card/40 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full shrink-0",
                        h.state === "online" ? "bg-success" : "bg-text-muted/40",
                      )}
                    />
                    <h2 className="text-sm font-medium text-text-heading truncate">{h.name}</h2>
                  </div>
                  <p className="text-[11px] text-text-muted mt-0.5">
                    {h.platform}
                    {h.arch ? ` · ${h.arch}` : ""}
                    {h.daemonVersion ? ` · daemon ${h.daemonVersion}` : ""}
                    {h.lastSeenAt ? ` · seen ${formatRelativeTime(h.lastSeenAt)}` : ""}
                  </p>
                </div>
                <Link
                  href="/work"
                  className="text-[11px] text-primary hover:underline inline-flex items-center gap-1 shrink-0"
                >
                  Work <ExternalLink className="w-3 h-3" />
                </Link>
              </div>
              <ul className="mt-3 space-y-1">
                {(h.dirs ?? []).length === 0 ? (
                  <li className="text-xs text-text-muted">
                    No directories — run{" "}
                    <code className="font-mono">optio local add &lt;dir&gt;</code> on this machine.
                  </li>
                ) : (
                  h.dirs.map((d: any) => (
                    <li key={d.path} className="flex items-center gap-2 text-xs">
                      <FolderGit2
                        className={cn(
                          "w-3.5 h-3.5 shrink-0",
                          d.repoUrl ? "text-primary" : "text-text-muted/50",
                        )}
                      />
                      <span className="font-mono text-text truncate">{shortDir(d.path)}</span>
                      {d.repoUrl && (
                        <span className="text-text-muted truncate">
                          {d.repoUrl
                            .replace(/^(https?:\/\/[^/]+\/|git@[^:]+:)/, "")
                            .replace(/\.git$/, "")}
                        </span>
                      )}
                    </li>
                  ))
                )}
              </ul>
              {h.state !== "online" && likelySameComputer(h, hosts) && (
                <MergeInto source={h} hosts={hosts} onMerged={refetch} />
              )}
            </div>
          ))}
        </div>
      )}

      {hosts.length > 0 && <AutomationsSection hosts={hosts} defaultOpen />}
    </div>
  );
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * A computer whose hostname changed under an older daemon shows up twice:
 * the old row (offline for good, still holding its sessions and
 * automations) and the one it connects as now. Offered only on an offline
 * machine that looks like another one (same kind, a shared folder), so a
 * second computer that is merely switched off isn't invited to merge.
 * Merging moves everything onto the machine picked here and removes the
 * old row.
 */
function MergeInto({
  source,
  hosts,
  onMerged,
}: {
  source: any;
  hosts: any[];
  onMerged: () => void;
}) {
  const targets = mergeTargets(source, hosts);
  const likely = likelySameComputer(source, hosts);
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = targets.find((h) => h.id === targetId) ?? likely ?? targets[0];
  if (!likely || !target) return null;

  const merge = async () => {
    if (
      !confirm(
        `Merge “${source.name}” into “${target.name}”?\n\n` +
          `Its sessions, automations and run locations move to ${target.name}, and ` +
          `${source.name} is removed. Only do this if both are the same computer.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const { moved } = await api.mergeLocalHost(source.id, target.id);
      toast.success(
        `Moved ${count(moved.terminals, "session")} and ${count(moved.automations, "automation")} to ${target.name}`,
      );
      onMerged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to merge");
    }
    setBusy(false);
  };

  return (
    <div className="mt-3 pt-3 border-t border-border/60 text-xs">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 text-text-muted hover:text-text transition-colors"
        >
          <Merge className="w-3.5 h-3.5" />
          <span>
            Same computer as <span className="font-medium text-text">{likely.name}</span>? Merge…
          </span>
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-text-muted">Merge into</span>
          <select
            value={target.id}
            onChange={(e) => setTargetId(e.target.value)}
            className="px-2 py-1.5 rounded bg-bg-card border border-border text-xs focus:outline-none focus:border-primary"
          >
            {targets.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
                {h.state === "online" ? " (online)" : ""}
              </option>
            ))}
          </select>
          <button
            onClick={merge}
            disabled={busy}
            className="h-7 px-3 rounded-md bg-primary text-white font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
          >
            {busy ? "Merging…" : "Merge"}
          </button>
          <button
            onClick={() => setOpen(false)}
            className="h-7 px-2 rounded-md text-text-muted hover:text-text transition-colors"
          >
            Cancel
          </button>
          <p className="basis-full text-text-muted">
            For a computer that shows up twice because its name changed: {source.name}&apos;s
            sessions and automations move there, and {source.name} is removed.
          </p>
        </div>
      )}
    </div>
  );
}
