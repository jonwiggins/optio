"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Bot,
  Briefcase,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Laptop,
  Merge,
  Plus,
  RefreshCw,
  Server,
  X,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { cn, formatRelativeTime } from "@/lib/utils";
import { shortDir, type WorkRow } from "@/lib/work-feed";
import {
  groupWorkByPlace,
  nowSummary,
  placeSize,
  type PlaceWork,
  type PodGroup,
} from "@/lib/work-places";
import { usePageTitle } from "@/hooks/use-page-title";
import { useLocalHosts } from "@/hooks/use-local-hosts";
import { useWorkFeed } from "@/hooks/use-work-feed";
import { PageHeader } from "@/components/page-header";
import { WorkRowView } from "@/components/work-row";
import { AutomationsSection } from "@/components/local/automations-section";
import { likelySameComputer, mergeTargets } from "@/components/local/host-merge";
import { PairMachineGuide } from "@/components/local/pair-machine";
import { AddDirForm, HostDirList, dirsLockedReason } from "@/components/local/host-dirs";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";

/**
 * Where work runs. Each paired machine (Optio Local host) with the work on
 * it — what's live there now, and what's set up to run there (automations,
 * Jobs and scheduled Tasks pointed at it) — and, as that machine's setup,
 * the directories it offers. Then the Optio pods: the cluster as the other
 * place work runs, grouped by repo, Jobs and persistent agents. Rows come
 * from the Work feed (`GET /api/work`), grouped by `where.hostId` in
 * `lib/work-places.ts`. "Add machine" walks through pairing another
 * computer; Local Automations are created from the section at the bottom.
 */
export default function MachinesPage() {
  usePageTitle("Machines");
  const [pairing, setPairing] = useState(false);
  // Poll faster while someone is pairing a machine, so it shows up as it connects.
  const [fastPoll, setFastPoll] = useState(false);
  const { hosts, loading, refetch, replaceHost } = useLocalHosts({
    pollMs: fastPoll ? 3000 : undefined,
  });
  const work = useWorkFeed();
  const noHosts = !loading && hosts.length === 0;
  const showGuide = pairing || noHosts;
  useEffect(() => setFastPoll(showGuide), [showGuide]);

  // `/machines?pair=1` (the New work form links here) opens the guide.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("pair") === "1") setPairing(true);
  }, []);

  // Online machines first, then by name.
  const sortedHosts = useMemo(
    () =>
      [...hosts].sort(
        (a: any, b: any) =>
          Number(b.state === "online") - Number(a.state === "online") ||
          String(a.name).localeCompare(String(b.name)),
      ),
    [hosts],
  );
  const places = useMemo(
    () =>
      groupWorkByPlace(
        work.rows,
        hosts.map((h: any) => h.id),
      ),
    [work.rows, hosts],
  );
  const refresh = () => {
    refetch();
    work.refetch();
  };

  return (
    <div className="page-column py-6">
      <PageHeader
        icon={Laptop}
        title="Machines"
        description="Your computers and Optio pods, with a clear view of the work running on each."
        actions={
          <div className="flex items-center gap-1">
            {!showGuide && (
              <Button onClick={() => setPairing(true)} className="btn-press">
                <Plus />
                Add machine
              </Button>
            )}
            <button
              onClick={refresh}
              className="p-2 rounded-lg hover:bg-bg-hover text-text-muted transition-all btn-press hover:text-text"
              title="Refresh"
            >
              <RefreshCw className={cn("w-4 h-4", (loading || work.loading) && "animate-spin")} />
            </button>
          </div>
        }
      />

      {showGuide && (
        <section className="rounded-xl border border-border/70 bg-bg-card/40 p-5 mb-6">
          <div className="flex items-start justify-between gap-3 mb-3">
            <h2 className="text-sm font-medium text-text-heading">
              {noHosts ? "Pair your first machine" : "Pair another machine"}
            </h2>
            {!noHosts && (
              <button
                onClick={() => setPairing(false)}
                className="p-1 -m-1 rounded text-text-muted hover:text-text"
                title="Close"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <PairMachineGuide hosts={hosts} loading={loading} />
        </section>
      )}

      {loading && hosts.length === 0 ? (
        <div className="h-32 skeleton-shimmer rounded-lg" />
      ) : hosts.length === 0 ? null : (
        <div className="space-y-4">
          <PlaceHeading icon={Laptop} title="Your machines" />
          {sortedHosts.map((h: any) => (
            <MachineSection
              key={h.id}
              host={h}
              hosts={hosts}
              work={places.machines[h.id] ?? { now: [], setUp: [] }}
              loadingWork={work.loading}
              onHostChanged={replaceHost}
              onMerged={refetch}
            />
          ))}
          {placeSize(places.otherMachines) > 0 && (
            <section
              aria-label="Other machines"
              className="rounded-xl border border-border/70 overflow-hidden"
            >
              <header className="px-4 py-3 bg-bg-card/40">
                <h3 className="text-sm font-medium text-text-heading">Other machines</h3>
                <p className="text-[11px] text-text-muted mt-0.5">
                  Work set to run on a machine that isn&apos;t one of yours — a teammate&apos;s, or
                  one that was removed.
                </p>
              </header>
              <PlaceRows work={places.otherMachines} />
            </section>
          )}
        </div>
      )}

      <PodsSection groups={places.pods} loading={work.loading && work.rows.length === 0} />

      {hosts.length > 0 && <AutomationsSection hosts={hosts} />}
    </div>
  );
}

/** A heading over one kind of place ("Your machines", "Optio pods"). */
function PlaceHeading({
  icon: Icon,
  title,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 pt-2">
      <h2 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-text-muted">
        <Icon className="w-3.5 h-3.5" />
        {title}
      </h2>
      {hint && <span className="text-xs text-text-muted/70 truncate">{hint}</span>}
    </div>
  );
}

/** How many rows of each half a place shows before "N more in Work". */
const ROWS_SHOWN = 6;

/**
 * A place's work: "Now" (live, needs-you first), then "Set up to run here"
 * (recurring definitions and standing agents), each a flush list of Work rows.
 */
function PlaceRows({
  work,
  whereLabel,
  empty = "Nothing running here, and nothing set up to run here.",
  setUpTitle = "Set up to run here",
}: {
  work: PlaceWork;
  whereLabel?: (row: WorkRow) => string | undefined;
  empty?: string;
  setUpTitle?: string;
}) {
  if (placeSize(work) === 0) {
    return <p className="px-4 py-3 text-xs text-text-muted border-t border-border/60">{empty}</p>;
  }
  return (
    <>
      <RowList title="Now" rows={work.now} more="/work?view=active" whereLabel={whereLabel} />
      <RowList
        title={setUpTitle}
        rows={work.setUp}
        more="/work?view=recurring"
        whereLabel={whereLabel}
      />
    </>
  );
}

function RowList({
  title,
  rows,
  more,
  whereLabel,
}: {
  title: string;
  rows: WorkRow[];
  more: string;
  whereLabel?: (row: WorkRow) => string | undefined;
}) {
  if (rows.length === 0) return null;
  const hidden = rows.length - ROWS_SHOWN;
  return (
    <div className="border-t border-border/60">
      <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted/80">
        {title}
      </div>
      <div className="divide-y divide-border/60">
        {rows.slice(0, ROWS_SHOWN).map((r) => (
          <WorkRowView key={r.key} row={r} whereLabel={whereLabel?.(r)} />
        ))}
      </div>
      {hidden > 0 && (
        <Link
          href={more}
          className="block px-4 py-2 text-[11px] text-text-muted hover:text-primary border-t border-border/60"
        >
          {hidden} more in Work →
        </Link>
      )}
    </div>
  );
}

/** On a machine the row already sits under its name: its chip names only the directory. */
const machineWhere = (row: WorkRow) => shortDir(row.where.dir) ?? undefined;

/**
 * One paired machine: who it is and whether it's connected, the work on it,
 * and its setup — the directories it offers (collapsed unless it has none)
 * and, for a stale duplicate, a merge offer.
 */
function MachineSection({
  host,
  hosts,
  work,
  loadingWork,
  onHostChanged,
  onMerged,
}: {
  host: any;
  hosts: any[];
  work: PlaceWork;
  loadingWork: boolean;
  onHostChanged: (host: any) => void;
  onMerged: () => void;
}) {
  const online = host.state === "online";
  const dirs: any[] = host.dirs ?? [];
  const [dirsOpen, setDirsOpen] = useState(dirs.length === 0);
  const summary = nowSummary(work);
  return (
    <section aria-label={host.name} className="rounded-xl border border-border/70 overflow-hidden">
      <header className="flex items-start justify-between gap-3 px-4 py-3 bg-bg-card/40">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "w-2 h-2 rounded-full shrink-0",
                online ? "bg-success" : "bg-text-muted/40",
              )}
              aria-label={online ? "online" : "offline"}
            />
            <h3 className="text-sm font-medium text-text-heading truncate">{host.name}</h3>
            <span className={cn("text-[11px]", online ? "text-success" : "text-text-muted")}>
              {online ? "online" : "offline"}
            </span>
          </div>
          <p className="text-[11px] text-text-muted mt-0.5">
            {host.platform}
            {host.arch ? ` · ${host.arch}` : ""}
            {host.daemonVersion ? ` · daemon ${host.daemonVersion}` : ""}
            {host.lastSeenAt ? ` · seen ${formatRelativeTime(host.lastSeenAt)}` : ""}
          </p>
        </div>
        {summary && (
          <span className="text-[11px] text-text-muted whitespace-nowrap pt-0.5">{summary}</span>
        )}
      </header>

      {loadingWork && placeSize(work) === 0 ? (
        <div className="h-12 skeleton-shimmer border-t border-border/60" />
      ) : (
        <PlaceRows work={work} whereLabel={machineWhere} />
      )}

      <div className="px-4 py-2.5 border-t border-border/60 bg-bg-card/20">
        <button
          type="button"
          onClick={() => setDirsOpen(!dirsOpen)}
          aria-expanded={dirsOpen}
          className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text transition-colors"
        >
          {dirsOpen ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
          <FolderOpen className="w-3.5 h-3.5" />
          Directories
          <span className="text-text-muted/60">({dirs.length})</span>
        </button>
        {dirsOpen && (
          <div className="mt-2">
            <HostDirList host={host} onChanged={onHostChanged} />
            <HostDirAdder host={host} onAdded={onHostChanged} />
          </div>
        )}
        {!online && likelySameComputer(host, hosts) && (
          <MergeInto source={host} hosts={hosts} onMerged={onMerged} />
        )}
      </div>
    </section>
  );
}

const GROUP_ICON: Record<PodGroup["kind"], React.ComponentType<{ className?: string }>> = {
  repo: FolderGit2,
  jobs: Briefcase,
  agents: Bot,
  other: Server,
};

/**
 * The cluster as the other place work runs: Repo Tasks, pod sessions and
 * scheduled Tasks by repo (one pod set per repo), Jobs and their runs
 * (pooled pods per Job), and persistent agents (a pod each).
 */
function PodsSection({ groups, loading }: { groups: PodGroup[]; loading: boolean }) {
  return (
    <div className="space-y-4 mt-8">
      <PlaceHeading
        icon={Server}
        title="Optio pods"
        hint="Work that runs in the cluster, with the workspace's secrets and connections"
      />
      {loading ? (
        <div className="h-24 skeleton-shimmer rounded-lg" />
      ) : groups.length === 0 ? (
        <p className="rounded-xl border border-border/70 px-4 py-3 text-xs text-text-muted">
          Nothing running in Optio pods, and nothing set up to.{" "}
          <Link href="/work/new" className="text-primary hover:underline">
            New work
          </Link>
        </p>
      ) : (
        groups.map((g) => {
          const Icon = GROUP_ICON[g.kind];
          const summary = nowSummary(g.work);
          return (
            <section
              key={g.key}
              aria-label={g.label}
              className="rounded-xl border border-border/70 overflow-hidden"
            >
              <header className="flex items-center justify-between gap-3 px-4 py-2.5 bg-bg-card/40">
                <h3
                  className={cn(
                    "flex items-center gap-2 text-sm font-medium text-text-heading min-w-0",
                    g.kind === "repo" && "font-mono text-[13px]",
                  )}
                >
                  <Icon className="w-4 h-4 shrink-0 text-text-muted" />
                  <span className="truncate">{g.label}</span>
                </h3>
                {summary && (
                  <span className="text-[11px] text-text-muted whitespace-nowrap">{summary}</span>
                )}
              </header>
              <PlaceRows
                work={g.work}
                setUpTitle={g.kind === "agents" ? "Standing by" : "Set up to run"}
                // Under a repo's heading its rows needn't repeat it.
                whereLabel={g.kind === "repo" ? () => "Optio pod" : undefined}
              />
            </section>
          );
        })
      )}
    </div>
  );
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * "Add a directory" under a machine's list — open straight away when it has
 * none. A machine that can't take the request says what to run on it.
 */
function HostDirAdder({ host, onAdded }: { host: any; onAdded: (host: any) => void }) {
  const empty = (host.dirs ?? []).length === 0;
  const [open, setOpen] = useState(false);
  const locked = dirsLockedReason(host);

  if (locked) {
    return (
      <p className="text-xs text-text-muted mt-2">
        {empty ? "No directories yet. " : ""}
        {locked}
      </p>
    );
  }
  if (!open && !empty) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} className="mt-2">
        <FolderPlus />
        Add a directory
      </Button>
    );
  }
  return (
    <div className="mt-2">
      {empty && (
        <p className="text-xs text-text-muted mb-2">No directories yet — add one it may work in.</p>
      )}
      <AddDirForm
        host={host}
        autoFocus={open}
        onAdded={(next) => {
          onAdded(next);
          setOpen(false);
        }}
        onCancel={empty ? undefined : () => setOpen(false)}
      />
    </div>
  );
}

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
            className={inputClass({ size: "sm", className: "w-auto" })}
          >
            {targets.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
                {h.state === "online" ? " (online)" : ""}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={merge} disabled={busy}>
            {busy ? "Merging…" : "Merge"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <p className="basis-full text-text-muted">
            For a computer that shows up twice because its name changed: {source.name}&apos;s
            sessions and automations move there, and {source.name} is removed.
          </p>
        </div>
      )}
    </div>
  );
}
