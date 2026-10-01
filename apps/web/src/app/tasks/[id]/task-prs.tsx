"use client";

import { useState } from "react";
import { ExternalLink, GitBranch, Plus, X } from "lucide-react";
import { toast } from "sonner";
import type { TaskPr } from "@optio/shared";
import { PrIcon } from "@/components/brand-icon";
import { api } from "@/lib/api-client";

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
 * The PRs a task opened or tracks. The list shows once a task has more than
 * one (the primary is already the header's PR chip); the "Add PR" input is
 * always one click away.
 */
export function TaskPrs({
  taskId,
  prs,
  onChange,
}: {
  taskId: string;
  prs: TaskPr[];
  onChange: () => void;
}) {
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
        placeholder="https://github.com/owner/repo/pull/123"
        className="w-72 max-w-full px-2 py-1 rounded-md bg-bg border border-border text-xs focus:outline-none focus:border-primary"
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

  if (prs.length <= 1) {
    return <div className="mt-2 flex justify-end">{addForm}</div>;
  }

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-xs font-medium text-text-muted">Pull requests ({prs.length})</h3>
        {addForm}
      </div>
      <ul className="divide-y divide-border rounded-md border border-border bg-bg">
        {prs.map((pr) => (
          <li key={pr.id} className="flex items-center gap-2 px-2.5 py-1.5 text-xs group">
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
            <span className="text-text-muted truncate">{repoName(pr.repoUrl)}</span>
            {pr.headBranch && (
              <span className="inline-flex items-center gap-1 text-text-muted truncate min-w-0">
                <GitBranch className="w-3 h-3 shrink-0" />
                <span className="truncate font-mono">{pr.headBranch}</span>
              </span>
            )}
            <span className="text-text-muted">{pr.state}</span>
            {pr.primary && (
              <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary">primary</span>
            )}
            <button
              onClick={() => void remove(pr)}
              disabled={busy}
              className="ml-auto text-text-muted hover:text-error opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity disabled:opacity-50"
              title={
                pr.primary
                  ? "Stop tracking — the next PR becomes the one Optio follows"
                  : "Stop tracking"
              }
            >
              Stop tracking
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
