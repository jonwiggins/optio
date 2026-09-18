"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { cn, formatRelativeTime } from "@/lib/utils";
import { normalizeRepoUrl } from "@optio/shared";
import { Loader2, Zap, GitBranch, CircleDot, Check, Terminal } from "lucide-react";

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
    api
      .listIssues({ repoId: selectedRepo || undefined })
      .then((res) => setIssues(res.issues))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedRepo]);

  // External-tracker tickets (Linear/Jira/Notion) flow into Optio via the
  // ticket-sync worker — they can't be manually assigned from this UI.
  const isAssignable = (i: any) =>
    (i.source === "github" || i.source === "gitlab" || !i.source) && i.repo?.id;
  const unassignedIssues = issues.filter((i: any) => !i.optioTask && isAssignable(i));

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
      {repos.length > 1 && (
        <div className="mb-4">
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            className="px-3 py-1.5 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
          >
            <option value="">All repos</option>
            {repos.map((r: any) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </select>
        </div>
      )}

      {!loading && unassignedIssues.length > 0 && (
        <div className="mb-4">
          <button
            onClick={handleAssignAll}
            disabled={bulkAssigning}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
          >
            {bulkAssigning ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Zap className="w-3 h-3" />
            )}
            {bulkAssigning ? "Assigning..." : `Assign All (${unassignedIssues.length})`}
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading issues...
        </div>
      ) : issues.length === 0 ? (
        <div className="text-center py-12 text-text-muted border border-dashed border-border rounded-lg">
          <CircleDot className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>No open issues found</p>
          <p className="text-xs mt-1">
            {repos.length === 0
              ? "Add a repo first in the Repos settings."
              : "Issues will appear here from your configured repos."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {issues.map((issue: any) => (
            <div
              key={issue.id ?? `${issue.repo?.fullName}-${issue.number}`}
              className="card-hover p-3 rounded-lg border border-border bg-bg-card hover:border-primary/30"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <a
                      href={issue.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-medium hover:text-primary transition-colors truncate"
                    >
                      {issue.title}
                    </a>
                    <span className="text-xs text-text-muted shrink-0">
                      {typeof issue.number === "number" ? `#${issue.number}` : issue.number}
                    </span>
                    {issue.source && issue.source !== "github" && issue.source !== "gitlab" && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-primary uppercase tracking-wide shrink-0">
                        {issue.source}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-text-muted">
                    <span className="flex items-center gap-1">
                      <GitBranch className="w-3 h-3" />
                      {issue.repo?.fullName ?? issue.source}
                    </span>
                    {issue.author && <span>@{issue.author}</span>}
                    {issue.assignee && <span>assignee: @{issue.assignee}</span>}
                    {issue.updatedAt && <span>{formatRelativeTime(issue.updatedAt)}</span>}
                  </div>
                  {issue.labels.length > 0 && (
                    <div className="flex items-center gap-1 mt-1.5">
                      {issue.labels.map((label: string) => (
                        <span
                          key={label}
                          className={cn(
                            "text-[10px] px-1.5 py-0.5 rounded-full border",
                            label === "optio"
                              ? "border-primary/30 bg-primary/10 text-primary"
                              : "border-border bg-bg text-text-muted",
                          )}
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="shrink-0 flex items-center gap-1.5">
                  {issue.optioTask ? (
                    <Link
                      href={`/tasks/${issue.optioTask.taskId}`}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-success/10 text-success text-xs hover:bg-success/20"
                    >
                      <Check className="w-3 h-3" />
                      {issue.optioTask.state === "completed"
                        ? "Done"
                        : issue.optioTask.state === "pr_opened"
                          ? "PR"
                          : "Running"}
                    </Link>
                  ) : isAssignable(issue) ? (
                    <>
                      <button
                        onClick={() => handleAssign(issue)}
                        disabled={assigning === issue.number}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs hover:bg-primary-hover disabled:opacity-50"
                      >
                        {assigning === issue.number ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Zap className="w-3 h-3" />
                        )}
                        Assign to Optio
                      </button>
                      {(() => {
                        const localHost = findLocalHost(issue);
                        if (!localHost) return null;
                        const key = `${issue.repo.id}:${issue.number}`;
                        return (
                          <button
                            onClick={() => handleWorkLocally(issue, localHost)}
                            disabled={workingLocally === key}
                            title={`Start an attended terminal in the matching checkout on ${localHost.name}`}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-primary/40 bg-primary/10 text-primary text-xs hover:bg-primary/20 disabled:opacity-50 transition-colors"
                          >
                            {workingLocally === key ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Terminal className="w-3 h-3" />
                            )}
                            Work on locally
                          </button>
                        );
                      })()}
                    </>
                  ) : (
                    <span
                      className="text-[10px] px-2 py-1 rounded-md border border-border bg-bg text-text-muted"
                      title="External tracker tickets are picked up automatically by the ticket-sync worker."
                    >
                      auto-sync
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
