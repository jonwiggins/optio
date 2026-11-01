"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Bot,
  Eye,
  ExternalLink,
  FileDiff,
  GitMerge,
  GitPullRequest,
  Link2,
  Loader2,
  RefreshCw,
  Sparkles,
  UserRound,
} from "lucide-react";
import type { PrInboxItem, PrInboxResponse } from "@optio/shared";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Panel } from "@/components/ui/panel";
import { Segmented } from "@/components/ui/segmented";
import { Button, ButtonLink, buttonClass } from "@/components/ui/button";
import { ConfirmPopover } from "@/components/ui/confirm-popover";
import { SearchField } from "@/components/ui/search-field";
import { inputClass } from "@/components/ui/input";
import { useCurrentUser } from "@/hooks/use-current-user";
import { RepoFilter, RowSkeleton } from "@/components/pr-browser";
import { ActionBadge, Signals } from "./signals";
import { HandlesForm } from "./handles-form";
import {
  PR_VIEWS,
  defaultView,
  matchesQuery,
  rowActions,
  MERGE_VERB,
  sections,
  shortAge,
  viewCounts,
  type PrView,
  type RowAction,
} from "./model";

const POLL_MS = 60_000;

/**
 * The pull-request panel: every open PR in the workspace's repositories,
 * grouped by whose move it is, with the one next step for each.
 */
export function PrInbox() {
  const router = useRouter();
  const params = useSearchParams();
  const { canMutate } = useCurrentUser();
  const [data, setData] = useState<PrInboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [view, setView] = useState<PrView | null>(
    (PR_VIEWS.find((v) => v.value === params.get("view"))?.value as PrView) ?? null,
  );
  const [repoId, setRepoId] = useState("");
  const [query, setQuery] = useState("");
  const [editingHandles, setEditingHandles] = useState(false);
  const [, tick] = useState(0);

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

  const effectiveView: PrView = view ?? defaultView(data);
  const pickView = (v: PrView) => {
    setView(v);
    const next = new URLSearchParams(params.toString());
    next.set("view", v);
    router.replace(`?${next.toString()}`, { scroll: false });
  };

  const repos = useMemo(() => {
    const byId = new Map<string, { id: string; fullName: string }>();
    for (const i of data?.items ?? [])
      byId.set(i.repo.id, { id: i.repo.id, fullName: i.repo.fullName });
    return [...byId.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }, [data]);

  const filtered = useMemo(
    () =>
      (data?.items ?? []).filter(
        (i) => (!repoId || i.repo.id === repoId) && matchesQuery(i, query),
      ),
    [data, repoId, query],
  );
  const counts = viewCounts(filtered);
  const groups = sections(filtered, effectiveView);
  const noHandles = !!data && data.viewer.handles.length === 0;
  const hasGitLab = (data?.items ?? []).some((i) => i.facts.platform === "gitlab");

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
              onClick={() => void load(true)}
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
                Optio finds the pull requests you opened, were asked to review, or are mentioned on
                by your handle. Until then you see every open PR.
              </p>
            </>
          )}
          <HandlesForm
            current={data.viewer}
            suggested={data.viewer.suggestedHandle}
            showGitLab={hasGitLab}
            onSaved={() => {
              setEditingHandles(false);
              setView(null);
              void load();
            }}
          />
        </div>
      )}

      <div className="flex flex-col gap-3 mb-4 lg:flex-row lg:items-center">
        <Segmented
          size="md"
          surface="card"
          aria-label="Which pull requests"
          value={effectiveView}
          onChange={pickView}
          options={PR_VIEWS.map((v) => ({
            ...v,
            // A disabled view's count would read as a bug.
            count: noHandles && v.value !== "all" ? undefined : counts[v.value],
            disabled:
              noHandles && v.value !== "all" ? "Tell Optio your handle to see your own" : undefined,
          }))}
        />
        <RepoFilter repos={repos} value={repoId} onChange={setRepoId} />
        <div className="lg:ml-auto flex items-center gap-2 w-full lg:w-auto">
          <SearchField
            value={query}
            onChange={setQuery}
            label="Filter pull requests"
            placeholder="Filter by title, #, repo, author…"
            size="sm"
            className="w-full lg:w-72"
          />
        </div>
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
            <Button size="sm" onClick={() => void load(true)}>
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
      ) : groups.length === 0 ? (
        <EmptyState
          icon={GitPullRequest}
          title={query || repoId ? "Nothing matches" : "Nothing needs you"}
          description={
            query || repoId
              ? "Try another filter."
              : effectiveView === "mine"
                ? "You have no open pull requests."
                : "No pull request is waiting on you. Nice."
          }
          action={
            effectiveView !== "all" ? (
              <Button variant="secondary" size="sm" onClick={() => pickView("all")}>
                See all open
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-5">
          {effectiveView !== "all" && !groups.some((g) => g.owner === "you") && (
            <p
              className="flex items-center gap-2 text-sm text-text-muted"
              data-testid="nothing-yours"
            >
              <Check className="w-4 h-4 text-success" />
              Nothing&apos;s your move right now.
            </p>
          )}
          {groups.map((g) => (
            <Panel
              key={g.owner}
              title={
                <span className="inline-flex items-center gap-2">
                  {g.title}
                  <span className="tabular-nums text-text-muted/70">{g.items.length}</span>
                </span>
              }
            >
              <div className="divide-y divide-border/60" data-testid={`pr-section-${g.owner}`}>
                {g.items.map((item) => (
                  <PrRow
                    key={item.facts.url}
                    item={item}
                    showRepo={!repoId && repos.length > 1}
                    canMutate={canMutate}
                    onChanged={() => void load(true)}
                  />
                ))}
              </div>
            </Panel>
          ))}
        </div>
      )}

      <ReviewAnyPr />
    </div>
  );
}

function PrRow({
  item,
  showRepo,
  canMutate,
  onChanged,
}: {
  item: PrInboxItem;
  showRepo: boolean;
  canMutate: boolean;
  onChanged: () => void;
}) {
  const { facts, status } = item;
  const actions = rowActions(item);
  const quiet = status.owner === "others";
  const age = (
    <span
      className={cn(
        "w-9 text-right text-[11px] tabular-nums whitespace-nowrap",
        status.stale ? "text-warning font-medium" : "text-text-muted/70",
      )}
      title={
        status.since
          ? `${status.stale ? "Waiting over 2 days · " : ""}since ${new Date(status.since).toLocaleString()}`
          : undefined
      }
    >
      {shortAge(status.since ?? facts.updatedAt)}
    </span>
  );
  const host = facts.platform === "gitlab" ? "GitLab" : "GitHub";
  // The detail line already names the author on a reviewer's row.
  const showAuthor = status.role !== "author" && status.role !== "reviewer";
  return (
    <div
      className={cn(
        "group flex flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-bg-hover/50",
        "md:grid md:grid-cols-[9.5rem_minmax(0,1fr)_auto_auto] md:items-center md:gap-x-3 md:gap-y-0",
      )}
      data-testid="pr-row"
      data-action={status.action}
    >
      <div className="flex items-center justify-between gap-2">
        <ActionBadge status={status} />
        <span className="md:hidden">{age}</span>
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <a
            href={facts.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "text-sm font-medium hover:text-primary transition-colors line-clamp-2 md:line-clamp-none md:truncate",
              quiet ? "text-text" : "text-text-heading",
            )}
            title={facts.title}
          >
            {facts.title}
          </a>
          <span className="text-xs text-text-muted/70 shrink-0 tabular-nums">#{facts.number}</span>
          {facts.draft && status.action !== "draft" && (
            <span className="text-[10px] px-1.5 rounded-full border border-border text-text-muted shrink-0">
              Draft
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-muted min-w-0">
          {status.detail && <span className={cn(!quiet && "text-text")}>{status.detail}</span>}
          {status.detail && (showRepo || showAuthor) && (
            <span aria-hidden className="text-text-muted/40">
              ·
            </span>
          )}
          {showRepo && <span className="font-mono text-[11px]">{facts.repoFullName}</span>}
          {showAuthor && <span>@{facts.author}</span>}
          {item.agent &&
            status.action !== "agent_working" &&
            status.action !== "agent_needs_you" && (
              <a
                href={`/work/${item.agent.taskId}`}
                className="inline-flex items-center gap-1 text-primary hover:underline"
                title={item.agent.title}
              >
                <Bot className="w-3 h-3" />
                Optio task
              </a>
            )}
        </div>
      </div>
      <Signals facts={facts} className="hidden md:flex" />
      <div className="flex items-center justify-between gap-2 md:justify-end">
        <Signals facts={facts} className="flex md:hidden" />
        <div className="flex items-center gap-2">
          {canMutate &&
            actions.map((a, i) => (
              <RowButton
                key={a.kind}
                item={item}
                action={a}
                onChanged={onChanged}
                className={i > 0 ? "hidden lg:inline-flex" : undefined}
              />
            ))}
          <span className="hidden md:inline">{age}</span>
          <a
            href={facts.url}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 rounded text-text-muted/60 hover:text-text hover:bg-bg-hover"
            aria-label={`Open #${facts.number} on ${host}`}
            title={`Open on ${host}`}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}

function RowButton({
  item,
  action,
  onChanged,
  className,
}: {
  item: PrInboxItem;
  action: RowAction;
  onChanged: () => void;
  className?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { facts } = item;
  // Every row button is secondary: the badge carries the urgency, and the
  // loudest thing on the page shouldn't be the one you can't undo.
  switch (action.kind) {
    case "open-task":
      return (
        <ButtonLink
          size="sm"
          variant="secondary"
          className={className}
          href={`/work/${action.taskId}`}
        >
          <Bot />
          {action.label}
        </ButtonLink>
      );
    case "open-files":
      return (
        <a
          href={action.href}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonClass({ variant: "secondary", size: "sm", className })}
        >
          <FileDiff />
          {action.label}
        </a>
      );
    case "open-review":
      return (
        <ButtonLink
          size="sm"
          variant="secondary"
          className={className}
          href={`/reviews/${action.reviewId}`}
        >
          <Sparkles />
          {action.label}
        </ButtonLink>
      );
    case "optio-review":
      return (
        <Button
          size="sm"
          variant="secondary"
          className={className}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await api.createPrReview({ prUrl: facts.url });
              toast.success(`Optio is reviewing #${facts.number}`);
              router.push(`/reviews/${res.review.id}`);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Couldn't start the review");
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {action.label}
        </Button>
      );
    case "agent":
      return (
        <Button
          size="sm"
          variant="secondary"
          className={className}
          disabled={busy || !!action.disabled}
          title={action.disabled}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await api.sendPrToAgent({ prUrl: facts.url, action: action.action });
              toast.success(
                res.mode === "created"
                  ? `An agent is on #${facts.number}`
                  : `The agent picked #${facts.number} back up`,
                { action: { label: "Watch", onClick: () => router.push(`/work/${res.taskId}`) } },
              );
              onChanged();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Couldn't start an agent");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Bot />}
          {action.label}
        </Button>
      );
    case "merge": {
      const approvers = facts.reviews
        .filter((r) => r.state === "approved")
        .map((r) => `@${r.author}`);
      const ci =
        facts.checks === "passing"
          ? "CI green"
          : facts.checks === "none"
            ? "no checks"
            : `CI ${facts.checks}`;
      return (
        <ConfirmPopover
          open={confirming}
          title={`${MERGE_VERB[action.method]} #${facts.number}?`}
          detail={
            <span className="block space-y-0.5">
              <span className="block text-text">{facts.title}</span>
              <span className="block">
                Into <code>{facts.baseBranch ?? "base"}</code> · {ci}
                {approvers.length > 0 && ` · approved by ${approvers.join(", ")}`}
              </span>
            </span>
          }
          confirmLabel={MERGE_VERB[action.method]}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await api.mergePullRequest({
                prUrl: facts.url,
                mergeMethod: action.method,
                // Refuse if someone pushed since this page last looked.
                ...(facts.platform === "github" && facts.headSha
                  ? { expectedHeadSha: facts.headSha }
                  : {}),
              });
              toast.success(`Merged #${facts.number}`);
              setConfirming(false);
              onChanged();
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Couldn't merge");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Button
            size="sm"
            variant="secondary"
            className={className}
            onClick={() => setConfirming(true)}
          >
            <GitMerge />
            {action.label}
          </Button>
        </ConfirmPopover>
      );
    }
  }
}

/** The old page's "review any PR by URL", kept below the list. */
function ReviewAnyPr() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const submit = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const res = await api.createPrReview({ prUrl: url.trim() });
      toast.success("Review started");
      router.push(`/reviews/${res.review.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start review");
      setBusy(false);
    }
  };
  return (
    <div className="mt-8 flex flex-col gap-2 sm:flex-row sm:items-center">
      <label htmlFor="review-any-pr" className="text-xs text-text-muted shrink-0">
        Review any other PR with Optio
      </label>
      <div className="relative flex-1 min-w-0 sm:max-w-md">
        <Link2 className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
        <input
          id="review-any-pr"
          ref={input}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="https://github.com/owner/repo/pull/123"
          className={inputClass({ size: "sm", className: "pl-8 bg-bg-card" })}
        />
      </div>
      <Button size="sm" variant="secondary" onClick={submit} disabled={busy || !url.trim()}>
        {busy ? <Loader2 className="animate-spin" /> : <Eye />}
        Review
      </Button>
    </div>
  );
}
