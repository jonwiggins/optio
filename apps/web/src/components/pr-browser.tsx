"use client";

import { useState, useEffect, type ReactNode } from "react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  Loader2,
  GitPullRequest,
  GitBranch,
  Eye,
  Check,
  Link2,
  Search,
  ThumbsUp,
  ThumbsDown,
  MessageSquare,
  Zap,
  GitMerge,
  X,
} from "lucide-react";
import { PrIcon } from "@/components/brand-icon";
import { EmptyState } from "@/components/empty-state";
import { Segmented } from "@/components/ui/segmented";
import { Button, ButtonLink } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { inputClass } from "@/components/ui/input";

export function PrBrowser() {
  const router = useRouter();
  const [prs, setPrs] = useState<any[]>([]);
  const [repos, setRepos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [merging, setMerging] = useState<number | null>(null);
  const [prUrl, setPrUrl] = useState("");
  const [submittingUrl, setSubmittingUrl] = useState(false);

  useEffect(() => {
    api
      .listRepos()
      .then((res) => setRepos(res.repos))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    api
      .listPullRequests({ repoId: selectedRepo || undefined })
      .then((res) => setPrs(res.pullRequests))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedRepo]);

  const handleReview = async (pr: any) => {
    setReviewing(pr.number);
    try {
      const res = await api.createPrReview({ prUrl: pr.url });
      toast.success(`Review started for PR #${pr.number}`);
      router.push(`/reviews/${res.review.id}`);
    } catch (err: any) {
      toast.error(err.message || "Failed to start review");
    }
    setReviewing(null);
  };

  const handleApproveAndMerge = async (pr: any) => {
    if (!confirm(`Approve and merge PR #${pr.number}? This skips agent review.`)) return;
    setMerging(pr.number);
    try {
      if (pr.review?.id) {
        try {
          await api.updatePrReview(pr.review.id, {
            verdict: "approve",
            summary: "Approved by user",
          });
          await api.submitPrReview(pr.review.id);
        } catch {
          // Already submitted or not editable — continue.
        }
      }
      await api.mergePullRequest({ prUrl: pr.url, mergeMethod: "squash" });
      toast.success(`PR #${pr.number} merged`);
      const res = await api.listPullRequests({ repoId: selectedRepo || undefined });
      setPrs(res.pullRequests);
    } catch (err: any) {
      toast.error(err.message || "Failed to merge PR");
    } finally {
      setMerging(null);
    }
  };

  const handleUrlSubmit = async () => {
    if (!prUrl.trim()) return;
    setSubmittingUrl(true);
    try {
      const res = await api.createPrReview({ prUrl: prUrl.trim() });
      toast.success("Review started");
      router.push(`/reviews/${res.review.id}`);
    } catch (err: any) {
      toast.error(err.message || "Failed to start review");
    }
    setSubmittingUrl(false);
  };

  return (
    <div>
      <div className="flex flex-col lg:flex-row lg:items-center gap-3 mb-4">
        <RepoFilter repos={repos} value={selectedRepo} onChange={setSelectedRepo} />
        {/* Review any PR by URL */}
        <div className="flex items-center gap-2 lg:ml-auto w-full lg:w-[30rem]">
          <div className="relative flex-1 min-w-0">
            <Link2 className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
            <input
              value={prUrl}
              onChange={(e) => setPrUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleUrlSubmit()}
              aria-label="Pull request URL"
              placeholder="Paste a PR URL to review…"
              title="e.g. https://github.com/owner/repo/pull/123"
              className={inputClass({ size: "sm", className: "pl-8 bg-bg-card" })}
            />
          </div>
          <Button size="sm" onClick={handleUrlSubmit} disabled={submittingUrl || !prUrl.trim()}>
            {submittingUrl ? <Loader2 className="animate-spin" /> : <Eye />}
            Review
          </Button>
        </div>
      </div>

      {loading ? (
        <RowSkeleton />
      ) : prs.length === 0 ? (
        <EmptyState
          icon={GitPullRequest}
          title="No open pull requests found"
          description={
            repos.length === 0
              ? "Add a repo first — its open pull requests show up here."
              : "Pull requests will appear here from your configured repos. Paste a URL above to review any other PR."
          }
          action={repos.length === 0 ? { label: "Add a repo", href: "/repos" } : undefined}
        />
      ) : (
        <Panel title="Open pull requests" actions={<span>{prs.length} open</span>}>
          <div className="divide-y divide-border/60">
            {prs.map((pr: any) => {
              const busy = reviewing === pr.number || merging === pr.number;
              return (
                <div
                  key={`${pr.repo.fullName}-${pr.number}`}
                  className="group grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-4 bg-bg-card/40 hover:bg-bg-hover/60 transition-colors"
                >
                  <PrIcon state={pr.draft ? "draft" : "open"} className="w-4 h-4" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-text-heading hover:text-primary transition-colors line-clamp-2"
                      >
                        {pr.title}
                      </a>
                      <span className="text-xs text-text-muted/70 shrink-0 tabular-nums">
                        #{pr.number}
                      </span>
                      {pr.draft && <Chip>Draft</Chip>}
                      {pr.review?.origin === "auto" && (
                        <Chip className="border-primary/30 bg-primary/10 text-primary">
                          <span
                            title="Automatically reviewed by Optio"
                            className="inline-flex items-center gap-0.5"
                          >
                            <Zap className="w-2.5 h-2.5" />
                            Auto
                          </span>
                        </Chip>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5 text-[11px] text-text-muted min-w-0">
                      {pr.review && <ReviewStatus review={pr.review} />}
                      <span className="inline-flex items-center gap-1 font-mono">
                        <GitBranch className="w-3 h-3 text-text-muted/60" />
                        {pr.repo.fullName}
                      </span>
                      {pr.author && <span>@{pr.author}</span>}
                      {pr.labels?.map((label: string) => (
                        <Chip key={label}>{label}</Chip>
                      ))}
                    </div>
                  </div>

                  <div className="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-auto">
                    <div
                      className={cn(
                        "flex flex-wrap items-center gap-1.5 transition-opacity",
                        !busy &&
                          "sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100",
                      )}
                    >
                      {pr.review ? (
                        <ButtonLink variant="secondary" size="sm" href={`/reviews/${pr.review.id}`}>
                          <Eye />
                          View review
                        </ButtonLink>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => handleReview(pr)}
                          disabled={reviewing === pr.number}
                        >
                          {reviewing === pr.number ? <Loader2 className="animate-spin" /> : <Eye />}
                          Review with Optio
                        </Button>
                      )}
                      <button
                        onClick={() => handleApproveAndMerge(pr)}
                        disabled={merging === pr.number}
                        title="Approve and merge without using the agent"
                        className="flex items-center gap-1 px-2.5 py-1 rounded-md border border-success/30 bg-success/10 text-success text-xs hover:bg-success/20 disabled:opacity-50 transition-colors"
                      >
                        {merging === pr.number ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <GitMerge className="w-3 h-3" />
                        )}
                        Approve &amp; merge
                      </button>
                    </div>
                    <span className="w-16 text-right text-[11px] text-text-muted/70 whitespace-nowrap">
                      {formatRelativeTime(pr.updatedAt)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}
    </div>
  );
}

const REVIEW_STATE: Record<string, { label: string; dot: string; text: string }> = {
  queued: { label: "Review queued", dot: "bg-warning/70", text: "text-warning" },
  waiting_ci: { label: "Waiting for CI", dot: "bg-text-muted/60", text: "text-text-muted" },
  reviewing: { label: "Reviewing…", dot: "bg-primary animate-pulse", text: "text-primary" },
  ready: { label: "Draft ready", dot: "bg-success", text: "text-success" },
  stale: { label: "Stale review", dot: "bg-error", text: "text-error" },
  submitted: { label: "Submitted", dot: "bg-info", text: "text-info" },
  cancelled: { label: "Cancelled", dot: "bg-text-muted/40", text: "text-text-muted" },
  failed: { label: "Review failed", dot: "bg-error", text: "text-error" },
};

const VERDICT: Record<string, { icon: typeof ThumbsUp; text: string; label: string }> = {
  approve: { icon: ThumbsUp, text: "text-success", label: "Approve" },
  request_changes: { icon: ThumbsDown, text: "text-error", label: "Request changes" },
  comment: { icon: MessageSquare, text: "text-info", label: "Comment" },
};

/** The Optio review's state and verdict, as the row's status line. */
function ReviewStatus({ review }: { review: any }) {
  const s = REVIEW_STATE[review.state] ?? {
    label: review.state,
    dot: "bg-text-muted/40",
    text: "text-text-muted",
  };
  const v = review.verdict ? VERDICT[review.verdict] : null;
  return (
    <span className="inline-flex items-center gap-2">
      <span className={cn("inline-flex items-center gap-1.5", s.text)}>
        <span className={cn("w-1.5 h-1.5 rounded-full", s.dot)} />
        {s.label}
      </span>
      {v && (
        <span className={cn("inline-flex items-center gap-1", v.text)}>
          <v.icon className="w-3 h-3" />
          {v.label}
        </span>
      )}
    </span>
  );
}

/** A tiny pill for labels and flags inside a row's title / meta line. */
export function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center text-[10px] leading-4 px-1.5 rounded-full border border-border bg-bg text-text-muted shrink-0",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Loading placeholder shaped like the rows: glyph, title + meta, recency. */
export function RowSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      className="rounded-xl border border-border/70 overflow-hidden divide-y divide-border/60"
      aria-busy="true"
      aria-label="Loading"
    >
      {[...Array(rows)].map((_, i) => (
        <div
          key={i}
          className="grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-4 bg-bg-card/40"
        >
          <div className="w-4 h-4 rounded-full skeleton-shimmer" />
          <div className="space-y-1.5">
            <div className="h-3.5 skeleton-shimmer" style={{ width: `${60 - (i % 3) * 12}%` }} />
            <div className="h-2.5 w-1/3 skeleton-shimmer" />
          </div>
          <div className="h-2.5 w-12 skeleton-shimmer" />
        </div>
      ))}
    </div>
  );
}

type RepoOption = { id: string; fullName: string };

/**
 * Narrow a list to one repo. A few repos get pills; more get a search box
 * that suggests matching repos (the same box as the Work list's search).
 */
export function RepoFilter({
  repos,
  value,
  onChange,
}: {
  repos: RepoOption[];
  value: string;
  onChange: (repoId: string) => void;
}) {
  if (repos.length < 2) return null;
  if (repos.length <= 4) {
    return (
      <Segmented
        size="md"
        surface="card"
        wrap
        className="gap-1"
        aria-label="Repository"
        value={value}
        onChange={onChange}
        options={[
          { value: "", label: "All repos" },
          ...repos.map((r) => ({ value: r.id, label: r.fullName })),
        ]}
      />
    );
  }
  return <RepoSearch repos={repos} value={value} onChange={onChange} />;
}

function RepoSearch({
  repos,
  value,
  onChange,
}: {
  repos: RepoOption[];
  value: string;
  onChange: (repoId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const selected = repos.find((r) => r.id === value);
  const needle = q.trim().toLowerCase();
  const matches = repos.filter((r) => r.fullName.toLowerCase().includes(needle));
  const pick = (id: string) => {
    onChange(id);
    setQ("");
    setOpen(false);
  };
  return (
    <div
      className="relative w-full sm:w-72"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setQ("");
        }
      }}
    >
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
      <input
        value={open ? q : (selected?.fullName ?? "")}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          if (e.key === "Enter" && needle && matches[0]) pick(matches[0].id);
        }}
        placeholder={selected ? selected.fullName : `All repos (${repos.length}) — search…`}
        aria-label="Filter by repository"
        role="combobox"
        aria-expanded={open}
        className={inputClass({
          size: "sm",
          className: cn("pl-8 bg-bg-card", selected ? "pr-8 font-mono" : "pr-3"),
        })}
      />
      {selected && !open && (
        <button
          type="button"
          onClick={() => pick("")}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-text-muted hover:text-text hover:bg-bg-hover"
          aria-label="Show all repos"
          title="Show all repos"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
      {open && (
        <div
          role="listbox"
          className="absolute z-20 mt-1 w-full max-h-72 overflow-auto rounded-lg border border-border bg-bg-card shadow-lg py-1"
        >
          {!needle && <RepoOptionRow label="All repos" active={!value} onPick={() => pick("")} />}
          {matches.map((r) => (
            <RepoOptionRow
              key={r.id}
              label={r.fullName}
              mono
              active={r.id === value}
              onPick={() => pick(r.id)}
            />
          ))}
          {matches.length === 0 && (
            <div className="px-3 py-2 text-xs text-text-muted">No repo matches “{q}”</div>
          )}
        </div>
      )}
    </div>
  );
}

function RepoOptionRow({
  label,
  active,
  mono,
  onPick,
}: {
  label: string;
  active: boolean;
  mono?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      // Keep focus in the input so the list doesn't close before the click lands.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-bg-hover transition-colors",
        active ? "text-primary" : "text-text",
        mono && "font-mono text-[13px]",
      )}
    >
      <span className="truncate flex-1">{label}</span>
      {active && <Check className="w-3.5 h-3.5 shrink-0" />}
    </button>
  );
}
