"use client";

import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Bot,
  Check,
  GitPullRequest,
  Loader2,
  RefreshCw,
  UserRound,
  X,
} from "lucide-react";
import type { PrInboxItem, PrInboxResponse } from "@optio/shared";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Panel } from "@/components/ui/panel";
import { Segmented } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { ConfirmPopover } from "@/components/ui/confirm-popover";
import { SearchField } from "@/components/ui/search-field";
import { useCurrentUser } from "@/hooks/use-current-user";
import { RepoFilter, RowSkeleton } from "@/components/pr-browser";
import { HandlesForm } from "./handles-form";
import {
  OctCodeReview,
  OctCommentDiscussion,
  OctGitCompare,
  OctGitMerge,
  OctXCircleFill,
} from "./octicons";
import { PrRow } from "./row";
import { ReviewAnyPr } from "./review-any-pr";
import { usePrActions } from "./actions";
import {
  PR_BUCKETS,
  PR_LENSES,
  bucketCounts,
  bulkActions,
  defaultLens,
  inBucket,
  inLens,
  lensCounts,
  matchesQuery,
  sections,
  shortAge,
  viewerSet,
  type BulkAction,
  type PrBucket,
  type PrLens,
} from "./model";

/** A list of rows: on wider screens one grid whose columns each row shares. */
const PR_LIST =
  "divide-y divide-border/60 md:grid md:grid-cols-[minmax(0,1fr)_auto_auto_auto] md:gap-x-3";

const POLL_MS = 60_000;

const BUCKET_LOOK: Record<
  PrBucket,
  { icon: ComponentType<{ className?: string }>; tone: string; hint: string }
> = {
  ready: { icon: OctGitMerge, tone: "text-success", hint: "Approved, green and mergeable" },
  ci: { icon: OctXCircleFill, tone: "text-error", hint: "A check failed on the head commit" },
  rebase: { icon: OctGitCompare, tone: "text-warning", hint: "Conflicts, or behind its base" },
  comments: {
    icon: OctCommentDiscussion,
    tone: "text-primary",
    hint: "Unresolved threads or replies owed",
  },
  review: { icon: OctCodeReview, tone: "text-primary", hint: "Waiting for a review" },
  agents: { icon: Bot, tone: "text-info", hint: "An Optio agent is working on it" },
};

/**
 * The pull-request panel: headline numbers over every open PR in the
 * workspace's repositories (click one to narrow the list), lenses by your
 * relation to the PR, and per-row and bulk quick actions.
 */
export function PrInbox() {
  const router = useRouter();
  const params = useSearchParams();
  const { canMutate } = useCurrentUser();
  const [data, setData] = useState<PrInboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [repoId, setRepoId] = useState("");
  const [query, setQuery] = useState("");
  const [editingHandles, setEditingHandles] = useState(false);
  const [, tick] = useState(0);

  const lensParam = PR_LENSES.find((l) => l.value === params.get("lens"))?.value ?? null;
  const bucket = PR_BUCKETS.find((b) => b.value === params.get("bucket"))?.value ?? null;

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    try {
      const res = await api.getPrInbox({ refresh });
      setData(res);
      setFailed(null);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    // Ages ("3h") move on between polls.
    const clock = setInterval(() => tick((n) => n + 1), 30_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const refreshNow = useCallback(() => void load(true), [load]);
  const { run, runBulk } = usePrActions(refreshNow);

  const setParam = (key: "lens" | "bucket", value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  };

  const noHandles = !!data && data.viewer.handles.length === 0;
  const lens: PrLens = noHandles ? "all" : (lensParam ?? defaultLens(data));
  const me = useMemo(() => viewerSet(data?.viewer.handles ?? []), [data]);

  const repos = useMemo(() => {
    const byId = new Map<string, { id: string; fullName: string }>();
    for (const i of data?.items ?? [])
      byId.set(i.repo.id, { id: i.repo.id, fullName: i.repo.fullName });
    return [...byId.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [data]);

  // repo + text filter → lens → (tile) bucket
  const filtered = useMemo(
    () =>
      (data?.items ?? []).filter(
        (i) => (!repoId || i.repo.id === repoId) && matchesQuery(i, query),
      ),
    [data, repoId, query],
  );
  const lensed = filtered.filter((i) => inLens(i, lens, me));
  const tiles = bucketCounts(lensed);
  const shown = bucket ? lensed.filter((i) => inBucket(i, bucket)) : lensed;
  const counts = lensCounts(filtered, me);
  const hasGitLab = (data?.items ?? []).some((i) => i.facts.platform === "gitlab");
  const showRepo = !repoId && repos.length > 1;

  const rowFor = (item: PrInboxItem) => (
    <PrRow
      key={item.facts.url}
      item={item}
      me={me}
      showRepo={showRepo}
      canMutate={canMutate}
      run={run}
    />
  );

  return (
    <div className="page-column py-6">
      <PageHeader
        icon={GitPullRequest}
        title="Pull requests"
        description={
          <span className="hidden sm:inline">
            What&apos;s waiting on you across your repositories, and what agents are already fixing.
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            {data && failed ? (
              <span className="text-xs text-warning" role="status" title={failed}>
                Couldn&apos;t refresh · showing data from {shortAge(data.fetchedAt)} ago
              </span>
            ) : data ? (
              <span className="hidden sm:inline text-xs text-text-muted" title={data.fetchedAt}>
                Updated {shortAge(data.fetchedAt)} ago
              </span>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              onClick={refreshNow}
              disabled={refreshing}
              aria-label="Refresh"
            >
              <RefreshCw className={cn(refreshing && "animate-spin")} />
              <span className="hidden sm:inline">Refresh</span>
            </Button>
          </div>
        }
        meta={
          data && data.viewer.handles.length > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
              <UserRound className="w-3 h-3" />
              You are {data.viewer.handles.map((h) => `@${h}`).join(", ")}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => setEditingHandles((v) => !v)}
              >
                {editingHandles ? "Done" : "Change"}
              </button>
            </span>
          ) : null
        }
      />

      {data && (noHandles || editingHandles) && (
        <div className="mb-4 rounded-xl border border-primary/30 bg-primary/5 p-4">
          {noHandles && (
            <>
              <h2 className="text-sm font-medium text-text-heading">Who are you on GitHub?</h2>
              <p className="mt-0.5 mb-3 text-xs text-text-muted">
                Optio finds the pull requests you opened, were asked to review, or reviewed by your
                handle. Until then you see every open PR on your repositories.
              </p>
            </>
          )}
          <HandlesForm
            current={data.viewer}
            suggested={data.viewer.suggestedHandle}
            showGitLab={hasGitLab}
            onSaved={() => {
              setEditingHandles(false);
              void load();
            }}
          />
        </div>
      )}

      {/* Which PRs: your relation to them. */}
      <Segmented
        size="md"
        surface="card"
        wrap
        className="mb-4"
        aria-label="Which pull requests"
        value={lens}
        onChange={(v) => setParam("lens", v)}
        options={PR_LENSES.map((l) => ({
          value: l.value,
          label: l.label,
          // A disabled lens's count would read as a bug.
          count: noHandles && l.personal ? undefined : counts[l.value],
          disabled: noHandles && l.personal ? "Tell Optio your handle to see your own" : undefined,
        }))}
      />

      {/* The headline numbers: click one to narrow the list to it. */}
      <div
        className="grid grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3 mb-4"
        role="group"
        aria-label="Filter by state"
      >
        {PR_BUCKETS.map((b) => {
          const look = BUCKET_LOOK[b.value];
          const n = tiles[b.value];
          const active = bucket === b.value;
          return (
            <button
              key={b.value}
              type="button"
              aria-pressed={active}
              title={look.hint}
              onClick={() => setParam("bucket", active ? null : b.value)}
              data-testid={`pr-tile-${b.value}`}
              className={cn(
                "rounded-xl border px-2.5 py-2 sm:px-4 sm:py-3 text-left transition-colors",
                active
                  ? "border-primary bg-primary/10 ring-1 ring-primary/40"
                  : "border-border/70 bg-bg-card/50 hover:border-primary/40",
              )}
            >
              <div className="flex items-center gap-1.5 text-[10px] sm:text-[11px] leading-tight uppercase tracking-wider text-text-muted/70">
                <look.icon className={cn("hidden sm:block w-3 h-3 shrink-0", n > 0 && look.tone)} />
                {b.label}
              </div>
              <div
                className={cn(
                  "text-xl sm:text-2xl font-semibold tabular-nums mt-0.5 sm:mt-1",
                  n > 0 ? look.tone : "text-text-muted/50",
                )}
              >
                {loading && !data ? "–" : n}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-3 mb-4 lg:flex-row lg:flex-wrap lg:items-center">
        <RepoFilter repos={repos} value={repoId} onChange={setRepoId} />
        <SearchField
          value={query}
          onChange={setQuery}
          label="Filter pull requests"
          placeholder="Filter by title, #, repo, author…"
          size="sm"
          className="w-full lg:w-72 lg:ml-auto"
        />
      </div>

      {data && data.errors.length > 0 && (
        <p
          className="mb-3 flex items-start gap-1.5 text-xs text-warning"
          title={data.errors.map((e) => `${e.repo}: ${e.message}`).join("\n")}
        >
          <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
          <span>
            <span className="sm:hidden">
              {data.errors.length === 1 ? "1 repo" : `${data.errors.length} repos`} unreadable
            </span>
            <span className="hidden sm:inline">
              Couldn&apos;t read{" "}
              {data.errors.length === 1
                ? `${data.errors[0].repo} — ${data.errors[0].message}`
                : `${data.errors.length} repositories: ${data.errors.map((e) => e.repo).join(", ")}`}
              .
            </span>{" "}
            <a href="/repos" className="underline hover:no-underline">
              Repos
            </a>
          </span>
        </p>
      )}

      {loading ? (
        <RowSkeleton rows={6} />
      ) : failed && !data ? (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load pull requests"
          description={failed}
          action={
            <Button size="sm" onClick={refreshNow}>
              <RefreshCw />
              Try again
            </Button>
          }
        />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={GitPullRequest}
          title="No open pull requests"
          description={
            repos.length === 0 && (data?.errors.length ?? 0) === 0
              ? "Add a repository — its open pull requests show up here, with what each one needs."
              : "Nothing open in your repositories right now."
          }
          action={repos.length === 0 ? { label: "Add a repo", href: "/repos" } : undefined}
        />
      ) : bucket ? (
        <BucketPanel
          bucket={bucket}
          items={shown}
          canMutate={canMutate}
          onClear={() => setParam("bucket", null)}
          runBulk={runBulk}
        >
          {shown.map(rowFor)}
        </BucketPanel>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={GitPullRequest}
          title={query || repoId ? "Nothing matches" : "Nothing here"}
          description={
            query || repoId
              ? "Try another filter."
              : lens === "needs-me"
                ? "No pull request is waiting on you. Nice."
                : lens === "mine"
                  ? "You have no open pull requests."
                  : lens === "requested"
                    ? "Nobody is waiting on your review."
                    : "You haven't reviewed any open pull request."
          }
          action={
            lens !== "all" ? (
              <Button variant="secondary" size="sm" onClick={() => setParam("lens", "all")}>
                See all on my repos
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-5">
          {lens === "needs-me" && !shown.some((i) => i.status.owner === "you") && (
            <p
              className="flex items-center gap-2 text-sm text-text-muted"
              data-testid="nothing-yours"
            >
              <Check className="w-4 h-4 text-success" />
              Nothing&apos;s your move right now.
            </p>
          )}
          {sections(shown).map((g) => (
            <Panel
              key={g.owner}
              title={
                <span className="inline-flex items-center gap-2">
                  {g.title}
                  <span className="tabular-nums text-text-muted/70">{g.items.length}</span>
                </span>
              }
            >
              <div className={PR_LIST} data-testid={`pr-section-${g.owner}`}>
                {g.items.map(rowFor)}
              </div>
            </Panel>
          ))}
        </div>
      )}

      <ReviewAnyPr />
    </div>
  );
}

/** A tile's rows, flat, with what can be done to all of them at once. */
function BucketPanel({
  bucket,
  items,
  canMutate,
  onClear,
  runBulk,
  children,
}: {
  bucket: PrBucket;
  items: PrInboxItem[];
  canMutate: boolean;
  onClear: () => void;
  runBulk: (items: PrInboxItem[], action: BulkAction) => Promise<void>;
  children: React.ReactNode;
}) {
  const label = PR_BUCKETS.find((b) => b.value === bucket)!.label;
  const bulk = canMutate ? bulkActions(bucket, items) : [];
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          {label}
          <span className="tabular-nums text-text-muted/70">{items.length}</span>
        </span>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2 normal-case">
          {bulk.map(({ action, items: rows }) => (
            <BulkButton key={action.label} action={action} rows={rows} runBulk={runBulk} />
          ))}
          <Button variant="ghost" size="sm" onClick={onClear}>
            <X />
            Clear
          </Button>
        </div>
      }
    >
      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-text-muted">Nothing here right now.</p>
      ) : (
        <div className={PR_LIST} data-testid={`pr-bucket-${bucket}`}>
          {children}
        </div>
      )}
    </Panel>
  );
}

/** One bulk action: always confirmed, since it touches several PRs at once. */
function BulkButton({
  action,
  rows,
  runBulk,
}: {
  action: BulkAction;
  rows: PrInboxItem[];
  runBulk: (items: PrInboxItem[], action: BulkAction) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmPopover
      open={confirming}
      title={`${action.label}: ${rows.length} pull request${rows.length === 1 ? "" : "s"}?`}
      detail={
        <span className="block max-h-40 overflow-auto">
          {rows.map((r) => (
            <span key={r.facts.url} className="block truncate">
              #{r.facts.number} {r.facts.title}
            </span>
          ))}
        </span>
      }
      confirmLabel={action.label}
      busy={busy}
      onCancel={() => setConfirming(false)}
      onConfirm={async () => {
        setBusy(true);
        await runBulk(rows, action);
        setBusy(false);
        setConfirming(false);
      }}
    >
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        {`${action.label} (${rows.length})`}
      </Button>
    </ConfirmPopover>
  );
}
