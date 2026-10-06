"use client";

import { Panel } from "@/components/ui/panel";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, type IssueSourceError } from "@/lib/api-client";
import { toast } from "sonner";
import { cn, formatRelativeTime } from "@/lib/utils";
import { normalizeRepoUrl } from "@optio/shared";
import {
  Loader2,
  Zap,
  GitBranch,
  CircleDot,
  ArrowUpRight,
  Terminal,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { BRAND_LABEL, BrandIcon, IssueIcon, brandFor } from "@/components/brand-icon";
import { EmptyState } from "@/components/empty-state";
import { Chip, RepoFilter, RowSkeleton } from "@/components/pr-browser";
import { Button, ButtonLink } from "@/components/ui/button";

/**
 * Browser of GitHub Issues across the workspace's connected repos.
 * Lets the user assign individual or bulk issues to Optio (creates a Repo Task),
 * or — when an online local host advertises a matching checkout — start an
 * attended Optio Local terminal for the issue.
 */
export function IssuesBrowser() {
  const router = useRouter();
  const [issues, setIssues] = useState<any[]>([]);
  const [repos, setRepos] = useState<any[]>([]);
  const [localHosts, setLocalHosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  /** Sources the API could not read (stale token, 403, …); the page must say so. */
  const [sourceErrors, setSourceErrors] = useState<IssueSourceError[]>([]);
  /** The listing request itself failed (API down, 5xx). */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [assigning, setAssigning] = useState<number | null>(null);
  const [workingLocally, setWorkingLocally] = useState<string | null>(null);
  const [bulkAssigning, setBulkAssigning] = useState(false);

  useEffect(() => {
    api
      .listRepos()
      .then((res) => setRepos(res.repos))
      .catch(() => {});
    // Hosts flip online/offline as daemons connect — keep "Work on locally"
    // in step without a reload.
    const loadHosts = () =>
      api
        .listLocalHosts()
        .then((res) => setLocalHosts(res.hosts))
        .catch(() => {});
    loadHosts();
    const hostsTimer = setInterval(() => {
      if (document.visibilityState === "visible") loadHosts();
    }, 15_000);
    return () => clearInterval(hostsTimer);
  }, []);

  useEffect(() => {
    setLoading(true);
    setLoadError(null);
    api
      .listIssues({ repoId: selectedRepo || undefined })
      .then((res) => {
        setIssues(res.issues);
        setSourceErrors(res.errors ?? []);
      })
      .catch((err) => {
        setIssues([]);
        setSourceErrors([]);
        setLoadError(err instanceof Error ? err.message : "Failed to load issues");
      })
      .finally(() => setLoading(false));
  }, [selectedRepo, reloadKey]);

  // External-tracker tickets (Linear/Jira/Notion) flow into Optio via the
  // ticket-sync worker — they can't be manually assigned from this UI.
  const isAssignable = (i: any) =>
    (i.source === "github" || i.source === "gitlab" || !i.source) && i.repo?.id;
  const unassignedIssues = issues.filter((i: any) => !i.optioTask && isAssignable(i));

  // One stale token fails every repo with the same message; say it once and
  // list who it hit rather than repeating the sentence per repo.
  const groupedSourceErrors = Object.values(
    sourceErrors.reduce<
      Record<string, { key: string; message: string; status: number | null; names: string[] }>
    >((acc, e) => {
      const key = `${e.status ?? ""}:${e.message}`;
      (acc[key] ??= { key, message: e.message, status: e.status, names: [] }).names.push(e.name);
      return acc;
    }, {}),
  );

  /** Online local host advertising a dir whose git remote matches the issue's repo. */
  const findLocalHost = (issue: any): any | null => {
    const repoUrl = issue.repo?.repoUrl;
    if (!repoUrl) return null;
    const target = normalizeRepoUrl(repoUrl);
    return (
      localHosts.find(
        (h) =>
          h.state === "online" &&
          (h.dirs ?? []).some((d: any) => d.repoUrl && normalizeRepoUrl(d.repoUrl) === target),
      ) ?? null
    );
  };

  const handleWorkLocally = async (issue: any, host: any) => {
    const key = `${issue.repo.id}:${issue.number}`;
    setWorkingLocally(key);
    try {
      const res = await api.createLocalTerminal({
        hostId: host.id,
        ticket: {
          repoId: issue.repo.id,
          issueNumber: issue.number,
          title: issue.title,
          body: issue.body ?? undefined,
        },
      });
      toast.success(`Terminal started on ${host.name}`);
      router.push(`/local/${res.terminal.id}`);
      return;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start local terminal");
    }
    setWorkingLocally(null);
  };

  const handleAssignAll = async () => {
    if (!confirm(`Assign ${unassignedIssues.length} issues to Optio?`)) return;
    setBulkAssigning(true);
    let assigned = 0;
    for (const issue of unassignedIssues) {
      try {
        const res = await api.assignIssue({
          issueNumber: issue.number,
          repoId: issue.repo.id,
          title: issue.title,
          body: issue.body,
        });
        setIssues((prev) =>
          prev.map((i) =>
            i.number === issue.number && i.repo.fullName === issue.repo.fullName
              ? {
                  ...i,
                  optioTask: { taskId: res.task?.id, state: "queued" },
                  labels: [...(i.labels || []), "optio"],
                }
              : i,
          ),
        );
        assigned++;
      } catch {
        // Continue with remaining issues
      }
    }
    toast.success(`Assigned ${assigned} of ${unassignedIssues.length} issues`);
    setBulkAssigning(false);
  };

  const handleAssign = async (issue: any) => {
    setAssigning(issue.number);
    try {
      const res = await api.assignIssue({
        issueNumber: issue.number,
        repoId: issue.repo.id,
        title: issue.title,
        body: issue.body,
      });
      toast.success(`Assigned #${issue.number} to Optio`);
      setIssues((prev) =>
        prev.map((i) =>
          i.number === issue.number && i.repo.fullName === issue.repo.fullName
            ? {
                ...i,
                optioTask: { taskId: res.task?.id, state: "queued" },
                labels: [...(i.labels || []), "optio"],
              }
            : i,
        ),
      );
    } catch {
      toast.error("Failed to assign issue");
    }
    setAssigning(null);
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-4">
        <RepoFilter repos={repos} value={selectedRepo} onChange={setSelectedRepo} />
        {!loading && unassignedIssues.length > 0 && (
          <Button
            onClick={handleAssignAll}
            disabled={bulkAssigning}
            title="Create a Repo Task for every unassigned issue in this list"
            className="sm:ml-auto"
          >
            {bulkAssigning ? <Loader2 className="animate-spin" /> : <Zap />}
            {bulkAssigning ? "Assigning..." : `Assign all to Optio (${unassignedIssues.length})`}
          </Button>
        )}
      </div>

      {!loading && (loadError || sourceErrors.length > 0) && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              {loadError ? (
                <p className="text-text">Couldn&apos;t load issues: {loadError}</p>
              ) : (
                <>
                  <p className="text-text">
                    Couldn&apos;t fetch issues from{" "}
                    {sourceErrors.length === 1
                      ? sourceErrors[0].name
                      : `${sourceErrors.length} sources`}
                    {issues.length > 0 ? " — showing the rest." : "."}
                  </p>
                  <ul className="mt-1.5 space-y-1 text-xs text-text-muted">
                    {groupedSourceErrors.map((g) => (
                      <li key={g.key} className="flex gap-1.5">
                        <span className="font-mono text-text shrink-0" title={g.names.join(", ")}>
                          {g.names.length <= 2
                            ? g.names.join(", ")
                            : `${g.names[0]} +${g.names.length - 1} more`}
                        </span>
                        <span className="min-w-0">
                          {g.message}
                          {g.status === 401 && (
                            <>
                              {" "}
                              <Link href="/setup" className="text-primary hover:underline">
                                Open setup
                              </Link>
                            </>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="shrink-0"
              title="Retry"
            >
              <RefreshCw />
              Retry
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <RowSkeleton />
      ) : issues.length === 0 ? (
        <EmptyState
          icon={CircleDot}
          title={
            loadError || sourceErrors.length > 0 ? "No issues to show" : "No open issues found"
          }
          description={
            loadError || sourceErrors.length > 0
              ? "Fix the problem above and retry — there may be issues Optio can't see yet."
              : repos.length === 0
                ? "Add a repo first — its open issues show up here."
                : "Issues will appear here from your configured repos."
          }
          action={
            repos.length === 0 && !loadError && sourceErrors.length === 0
              ? { label: "Add a repo", href: "/repos" }
              : undefined
          }
        />
      ) : (
        <Panel title="Issues" actions={<span>{issues.length} issues</span>}>
          <div className="divide-y divide-border/60">
            {issues.map((issue: any) => {
              const localKey = issue.repo ? `${issue.repo.id}:${issue.number}` : null;
              const busy = assigning === issue.number || workingLocally === localKey;
              const localHost =
                !issue.optioTask && isAssignable(issue) ? findLocalHost(issue) : null;
              const brand = brandFor(issue.source ?? "github");
              return (
                <div
                  key={issue.id ?? `${issue.repo?.fullName}-${issue.number}`}
                  className="group grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-4 bg-bg-card/40 hover:bg-bg-hover/60 transition-colors"
                >
                  <IssueSourceIcon source={issue.source} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <a
                        href={issue.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-text-heading hover:text-primary transition-colors line-clamp-2"
                      >
                        {issue.title}
                      </a>
                      <span className="text-xs text-text-muted/70 shrink-0 tabular-nums">
                        {typeof issue.number === "number" ? `#${issue.number}` : issue.number}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5 text-[11px] text-text-muted min-w-0">
                      {issue.optioTask && <TaskStatus task={issue.optioTask} />}
                      <span className="inline-flex items-center gap-1">
                        {brand ? (
                          <BrandIcon brand={brand} className="w-3 h-3" />
                        ) : (
                          <GitBranch className="w-3 h-3 text-text-muted/60" />
                        )}
                        <span className={cn(issue.repo?.fullName && "font-mono")}>
                          {issue.repo?.fullName ?? (brand ? BRAND_LABEL[brand] : issue.source)}
                        </span>
                      </span>
                      {issue.author && <span>@{issue.author}</span>}
                      {issue.assignee && <span>assignee @{issue.assignee}</span>}
                      {issue.labels.map((label: string) => (
                        <Chip
                          key={label}
                          className={
                            label === "optio"
                              ? "border-primary/30 bg-primary/10 text-primary"
                              : undefined
                          }
                        >
                          {label}
                        </Chip>
                      ))}
                    </div>
                  </div>

                  <div className="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-auto">
                    {issue.optioTask ? (
                      <ButtonLink
                        variant="secondary"
                        size="sm"
                        href={`/tasks/${issue.optioTask.taskId}`}
                        className="sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                      >
                        <ArrowUpRight />
                        Open task
                      </ButtonLink>
                    ) : isAssignable(issue) ? (
                      <div
                        className={cn(
                          "flex flex-wrap items-center gap-1.5 transition-opacity",
                          !busy &&
                            "sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100",
                        )}
                      >
                        {localHost && localKey && (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleWorkLocally(issue, localHost)}
                            disabled={workingLocally === localKey}
                            title={`Start an attended terminal in the matching checkout on ${localHost.name}`}
                          >
                            {workingLocally === localKey ? (
                              <Loader2 className="animate-spin" />
                            ) : (
                              <Terminal />
                            )}
                            Work on locally
                          </Button>
                        )}
                        <Button
                          size="sm"
                          onClick={() => handleAssign(issue)}
                          disabled={assigning === issue.number}
                        >
                          {assigning === issue.number ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Zap />
                          )}
                          Assign to Optio
                        </Button>
                      </div>
                    ) : (
                      <span
                        className="inline-flex items-center gap-1 text-[11px] text-text-muted/70"
                        title="External tracker tickets are picked up automatically by the ticket-sync worker."
                      >
                        <RefreshCw className="w-3 h-3" />
                        auto-sync
                      </span>
                    )}
                    <span className="w-16 text-right text-[11px] text-text-muted/70 whitespace-nowrap">
                      {issue.updatedAt ? formatRelativeTime(issue.updatedAt) : ""}
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

const TASK_STATUS: Record<string, { label: string; dot: string; text: string }> = {
  completed: { label: "Done", dot: "bg-text-muted/40", text: "text-text-muted" },
  pr_opened: { label: "PR open", dot: "bg-success", text: "text-success" },
  failed: { label: "Failed", dot: "bg-error", text: "text-error" },
  needs_attention: { label: "Needs you", dot: "bg-warning", text: "text-warning" },
  queued: { label: "Queued", dot: "bg-warning/70", text: "text-warning" },
};

/** The Optio task working the issue, as the row's status line. */
function TaskStatus({ task }: { task: { state?: string } }) {
  const s = TASK_STATUS[task.state ?? ""] ?? {
    label: "Running",
    dot: "bg-primary animate-pulse",
    text: "text-primary",
  };
  return (
    <span className={cn("inline-flex items-center gap-1.5", s.text)}>
      <span className={cn("w-1.5 h-1.5 rounded-full", s.dot)} />
      Optio · {s.label}
    </span>
  );
}

/** GitHub / GitLab issues get GitHub's issue glyph; other trackers their own mark. */
function IssueSourceIcon({ source }: { source?: string | null }) {
  const brand = brandFor(source);
  if (brand && brand !== "github" && brand !== "gitlab") {
    return (
      <BrandIcon brand={brand} className="w-4 h-4 text-text-muted" title={BRAND_LABEL[brand]} />
    );
  }
  return <IssueIcon state="open" className="w-4 h-4" />;
}
