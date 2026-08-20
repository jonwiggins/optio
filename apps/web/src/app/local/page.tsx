"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { cn, formatDuration } from "@/lib/utils";
import { createEventsClient } from "@/lib/ws-client";
import { getWsTokenProvider } from "@/lib/ws-auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Loader2, MonitorSmartphone, Plus, Search, Terminal } from "lucide-react";
import { TerminalCard, attentionLabel } from "@/components/local/terminal-card";
import { NewTerminalDialog } from "@/components/local/new-terminal-dialog";
import { BlueprintsSection } from "@/components/local/blueprints-section";

type StateFilter = "all" | "active" | "needs_you" | "exited";

const ACTIVE_STATES = ["pending", "launching", "running"];

export default function LocalPage() {
  usePageTitle("Local");

  const [hosts, setHosts] = useState<any[]>([]);
  const [terminals, setTerminals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewDialog, setShowNewDialog] = useState(false);

  const [hostFilter, setHostFilter] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [search, setSearch] = useState("");

  const refetch = useCallback(async () => {
    try {
      const [hostsRes, terminalsRes] = await Promise.all([
        api.listLocalHosts(),
        api.listLocalTerminals(),
      ]);
      setHosts(hostsRes.hosts);
      setTerminals(terminalsRes.terminals);
    } catch {
      // transient — the poll retries
    }
  }, []);

  useEffect(() => {
    refetch().finally(() => setLoading(false));
  }, [refetch]);

  // Live updates: content-free local:changed nudges on the shared events WS,
  // debounced 500ms, plus a 5s visible-tab poll and a visibilitychange refetch.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const debouncedRefetch = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => refetch(), 500);
    };

    const client = createEventsClient(getWsTokenProvider());
    const off = client.on("local:changed", debouncedRefetch);
    client.connect();

    const interval = setInterval(() => {
      if (document.visibilityState === "visible") refetch();
    }, 5000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") refetch();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      off();
      client.disconnect();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refetch]);

  const hostById = useMemo(() => {
    const map = new Map<string, any>();
    for (const h of hosts) map.set(h.id, h);
    return map;
  }, [hosts]);

  const needsYou = useMemo(
    () =>
      terminals
        .filter((t) => t.attentionState === "needs_you")
        .sort(
          (a, b) =>
            new Date(a.lastActivityAt ?? a.updatedAt).getTime() -
            new Date(b.lastActivityAt ?? b.updatedAt).getTime(),
        ),
    [terminals],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return terminals.filter((t) => {
      if (hostFilter && t.hostId !== hostFilter) return false;
      if (stateFilter === "active" && !ACTIVE_STATES.includes(t.state)) return false;
      if (stateFilter === "needs_you" && t.attentionState !== "needs_you") return false;
      if (stateFilter === "exited" && t.state !== "exited" && t.state !== "error") return false;
      if (q && !`${t.title} ${t.dir}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [terminals, hostFilter, stateFilter, search]);

  const handleStart = async (t: any) => {
    try {
      await api.startLocalTerminal(t.id);
      toast.success("Terminal started");
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start terminal");
    }
  };

  const handleKill = async (t: any) => {
    try {
      await api.killLocalTerminal(t.id);
      toast.success("Kill signal sent");
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to kill terminal");
    }
  };

  const handleDelete = async (t: any) => {
    if (!confirm(`Delete terminal "${t.title}"?`)) return;
    try {
      await api.deleteLocalTerminal(t.id);
      setTerminals((prev) => prev.filter((x) => x.id !== t.id));
      toast.success("Terminal deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete terminal");
    }
  };

  const hasHosts = hosts.length > 0;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        icon={Terminal}
        title="Local"
        description="Terminal sessions on your own machines, spawned and watched from here. Attended agents in your own checkouts — no pods, your local auth."
        meta={
          hasHosts ? (
            <div className="flex items-center gap-2 flex-wrap">
              {hosts.map((h) => (
                <span
                  key={h.id}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-border bg-bg-card text-[11px]"
                  title={`${h.hostname} · ${h.platform} · ${h.dirs.length} dir${h.dirs.length === 1 ? "" : "s"}`}
                >
                  <span
                    className={cn(
                      "w-1.5 h-1.5 rounded-full",
                      h.state === "online" ? "bg-success" : "bg-text-muted/40",
                    )}
                  />
                  {h.name}
                  <span className="text-text-muted/60">
                    {h.dirs.length} dir{h.dirs.length === 1 ? "" : "s"}
                  </span>
                </span>
              ))}
            </div>
          ) : undefined
        }
        actions={
          hasHosts ? (
            <button
              onClick={() => setShowNewDialog(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Terminal
            </button>
          ) : undefined
        }
      />

      {loading ? (
        <div className="flex items-center justify-center py-16 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading local terminals...
        </div>
      ) : !hasHosts ? (
        <EmptyState
          icon={MonitorSmartphone}
          title="No machines paired yet"
          description={
            <span>
              On your machine, run <code className="font-mono text-text">optio login</code>, then{" "}
              <code className="font-mono text-text">optio local add &lt;dir&gt;</code> for each
              directory you want to expose, and{" "}
              <code className="font-mono text-text">optio local up</code> to connect. Your host will
              appear here.
            </span>
          }
        />
      ) : (
        <>
          {needsYou.length > 0 && (
            <section className="mb-5">
              <h2 className="text-xs font-semibold tracking-widest uppercase text-warning mb-2">
                Needs you
              </h2>
              <div className="flex gap-2 overflow-x-auto pb-1.5">
                {needsYou.map((t) => (
                  <Link
                    key={t.id}
                    href={`/local/${t.id}`}
                    className="shrink-0 w-60 p-2.5 rounded-lg border border-warning/30 bg-warning/5 hover:border-primary/50 transition-colors"
                  >
                    <div className="text-sm font-medium truncate">{t.title}</div>
                    <div className="flex items-center justify-between gap-2 mt-1 text-[11px]">
                      <span className="text-warning truncate">
                        {attentionLabel(t.attentionReason)}
                      </span>
                      {t.lastActivityAt && (
                        <span className="text-text-muted shrink-0">
                          waiting {formatDuration(t.lastActivityAt)}
                        </span>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          )}

          <div className="flex items-center gap-2 mb-4 flex-wrap">
            {hosts.length > 1 && (
              <select
                value={hostFilter}
                onChange={(e) => setHostFilter(e.target.value)}
                className="px-3 py-1.5 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
              >
                <option value="">All hosts</option>
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            )}
            <div className="flex items-center gap-1 p-1 rounded-lg bg-bg-card border border-border">
              {(
                [
                  ["all", "All"],
                  ["active", "Active"],
                  ["needs_you", "Needs you"],
                  ["exited", "Exited"],
                ] as Array<[StateFilter, string]>
              ).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setStateFilter(value)}
                  className={cn(
                    "px-2.5 py-1 rounded-md text-xs transition-colors",
                    stateFilter === value
                      ? "bg-primary/15 text-primary"
                      : "text-text-muted hover:text-text",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search title or dir…"
                className="pl-8 pr-3 py-1.5 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary w-56"
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <EmptyState
              icon={Terminal}
              title={terminals.length === 0 ? "No terminals yet" : "Nothing matches the filters"}
              description={
                terminals.length === 0
                  ? "Spawn a terminal on one of your paired machines to get started."
                  : "Try widening the state filter or clearing the search."
              }
              action={
                terminals.length === 0 ? (
                  <button
                    onClick={() => setShowNewDialog(true)}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    New Terminal
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filtered.map((t) => (
                <TerminalCard
                  key={t.id}
                  terminal={t}
                  hostName={hostById.get(t.hostId)?.name}
                  onStart={handleStart}
                  onKill={handleKill}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}

          <BlueprintsSection hosts={hosts} />
        </>
      )}

      {showNewDialog && <NewTerminalDialog hosts={hosts} onClose={() => setShowNewDialog(false)} />}
    </div>
  );
}
