"use client";

import Link from "next/link";
import { ExternalLink, FolderGit2, Laptop, RefreshCw } from "lucide-react";
import { cn, formatRelativeTime } from "@/lib/utils";
import { usePageTitle } from "@/hooks/use-page-title";
import { useLocalHosts } from "@/hooks/use-local-hosts";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { shortDir } from "@/lib/sessions-feed";

/**
 * Your paired machines (Optio Local hosts) and the directories each one
 * offers as a place to run sessions. Pairing is setup, not daily work, so
 * this lives in the Library next to Repos.
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
                  href="/local"
                  className="text-[11px] text-primary hover:underline inline-flex items-center gap-1 shrink-0"
                >
                  Terminals <ExternalLink className="w-3 h-3" />
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
