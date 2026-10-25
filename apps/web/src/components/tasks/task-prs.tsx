"use client";

import { useState } from "react";
import { ExternalLink, GitBranch, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { isMergeRequest, knownHostPlatform, type TaskPr } from "@optio/shared";
import { useFeatures } from "@/hooks/use-features";
import { PrIcon } from "@/components/brand-icon";
import { api } from "@/lib/api-client";
import { inputClass } from "@/components/ui/input";

/** The platform a repo URL's host is known to be (github.com, gitlab.com), else null. */
function repoHostPlatform(repoUrl: string): string | null {
  try {
    return knownHostPlatform(new URL(repoUrl).host);
  } catch {
    return null;
  }
}

/** `owner/repo` from a repo URL, for the row's label. */
function repoName(repoUrl: string): string {
  try {
    const path = new URL(repoUrl).pathname.replace(/^\/+|\.git$|\/+$/g, "");
    return path || repoUrl;
  } catch {
    return repoUrl;
  }
}

/**
 * Every PR a task opened or tracks, including the primary. Rows reflow in
 * the Details pane; the "Add PR" input is always one click away.
 */
export function TaskPrs({
  taskId,
  prs,
  onChange,
  repoUrl,
}: {
  taskId: string;
  prs: TaskPr[];
  onChange: () => void;
  /** The task's repo: a GitLab repo's input shows a merge request URL. */
  repoUrl?: string | null;
}) {
  const { features } = useFeatures();
  const mergeRequests = isMergeRequest(prs.find((p) => p.url)?.url, {
    features,
    platform: repoUrl ? repoHostPlatform(repoUrl) : null,
  });
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const attach = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      await api.attachTaskPr(taskId, url.trim());
      toast.success("PR added");
      setUrl("");
      setAdding(false);
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add PR");
    }
    setBusy(false);
  };

  const remove = async (pr: TaskPr) => {
    setBusy(true);
    try {
      await api.removeTaskPr(taskId, pr.id);
      toast.success(`Stopped tracking #${pr.number}`);
      onChange();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to stop tracking the PR");
    }
    setBusy(false);
  };

  const addForm = adding ? (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void attach();
      }}
    >
      <input
        autoFocus
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={
          mergeRequests
            ? "https://gitlab.example.com/group/project/-/merge_requests/123"
            : "https://github.com/owner/repo/pull/123"
        }
        className={inputClass({ size: "sm", className: "w-72 max-w-full" })}
      />
      <button
        type="submit"
        disabled={busy || !url.trim()}
        className="px-2 py-1 rounded-md bg-primary/10 text-primary text-xs hover:bg-primary/20 disabled:opacity-50"
      >
        Add
      </button>
      <button
        type="button"
        onClick={() => setAdding(false)}
        className="p-1 rounded-md text-text-muted hover:bg-bg-hover"
        title="Cancel"
      >
        <X className="w-3 h-3" />
      </button>
    </form>
  ) : (
    <button
      onClick={() => setAdding(true)}
      className="flex items-center gap-1 text-xs text-primary hover:underline"
    >
      <Plus className="w-3 h-3" />
      Add PR
    </button>
  );

  return (
    <div className="mt-3 space-y-3">
      {prs.length === 0 && <p className="text-xs text-text-muted">No pull requests yet.</p>}
      {prs.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border bg-bg">
          {prs.map((pr) => (
            <li key={pr.id} className="flex flex-wrap items-center gap-2 p-3 text-xs">
              <PrIcon state={pr.state} className="w-3.5 h-3.5 shrink-0" />
              <a
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium hover:underline inline-flex items-center gap-1"
              >
                #{pr.number}
                <ExternalLink className="w-3 h-3 opacity-60" />
              </a>
              <span className="text-text-muted">{pr.state}</span>
              {pr.primary && (
                <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary">primary</span>
              )}
              <button
                onClick={() => void remove(pr)}
                disabled={busy}
                className="ml-auto rounded p-1 text-text-muted hover:bg-bg-hover hover:text-error disabled:opacity-50"
                aria-label={`Stop tracking PR #${pr.number}`}
                title={
                  pr.primary
                    ? "Stop tracking — the next PR becomes the one Optio follows"
                    : "Stop tracking"
                }
              >
                <X className="h-3 w-3" />
              </button>
              <span className="w-full break-all text-text-muted">{repoName(pr.repoUrl)}</span>
              {pr.headBranch && (
                <span className="flex w-full min-w-0 items-start gap-1 text-text-muted">
                  <GitBranch className="mt-0.5 w-3 h-3 shrink-0" />
                  <span className="break-all font-mono text-[11px]">{pr.headBranch}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end">{addForm}</div>
    </div>
  );
}
