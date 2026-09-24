"use client";

import { useState } from "react";
import { toast } from "sonner";
import { FolderGit2, FolderPlus, Loader2, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { shortDir } from "@/lib/work-feed";

/**
 * A machine's directories, changed from here: the machine's daemon does
 * what `optio local add|remove` would on it (it resolves `~`, checks the
 * directory exists, and detects its git remote). A machine that is offline,
 * or whose daemon can't take the request, gets the command to run there.
 */

/** Why this machine's directories can't be changed from Optio right now, or null when they can. */
export function dirsLockedReason(host: {
  name: string;
  state?: string;
  manageDirs?: boolean;
}): string | null {
  if (host.manageDirs) return null;
  return host.state === "online"
    ? `${host.name}'s daemon can't add directories from here — update its CLI, or run optio local add <dir> on it.`
    : `${host.name} is offline — start optio local up on it, or run optio local add <dir> there.`;
}

/** `git@github.com:acme/app.git` → `acme/app`, for display. */
export function repoLabel(repoUrl: string): string {
  return repoUrl.replace(/^(https?:\/\/[^/]+\/|git@[^:]+:)/, "").replace(/\.git$/, "");
}

export function AddDirForm({
  host,
  onAdded,
  onCancel,
  autoFocus = false,
  className,
}: {
  host: { id: string; name: string };
  /** The updated host row and the directory as the machine resolved it. */
  onAdded: (host: any, path: string) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Enter must not reach the New work form this sits in (it would submit it).
  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const wanted = path.trim();
    if (!wanted || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.addLocalHostDir(host.id, wanted);
      setPath("");
      toast.success(`Added ${shortDir(res.path)} on ${host.name}`);
      onAdded(res.host, res.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add it");
    }
    setBusy(false);
  };

  return (
    // A div, not a <form>: this sits inside the New work form, and forms can't nest.
    <div className={cn("space-y-1", className)}>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit(e);
            if (e.key === "Escape" && onCancel) onCancel();
          }}
          placeholder="~/code/my-project"
          aria-label={`Directory on ${host.name}`}
          autoFocus={autoFocus}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="flex-1 min-w-0 px-3 py-1.5 rounded-lg bg-bg border border-border text-sm font-mono focus:outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy || !path.trim()}
          className="h-8 px-3 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary-hover disabled:opacity-50 inline-flex items-center gap-1.5 shrink-0"
        >
          {busy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <FolderPlus className="w-3.5 h-3.5" />
          )}
          Add
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="h-8 px-2 rounded-lg text-xs text-text-muted hover:text-text shrink-0"
          >
            Cancel
          </button>
        )}
      </div>
      {error ? (
        <p className="text-[11px] text-error">{error}</p>
      ) : (
        <p className="text-[11px] text-text-muted/80">
          A path on {host.name}, absolute or under ~. A git checkout can also take work that opens a
          PR.
        </p>
      )}
    </div>
  );
}

/** One machine's directories, each removable when the machine can take the request. */
export function HostDirList({
  host,
  onChanged,
}: {
  host: any;
  /** The updated host row after a removal. */
  onChanged: (host: any) => void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const dirs: Array<{ path: string; repoUrl?: string }> = host.dirs ?? [];
  const editable = !dirsLockedReason(host);

  const remove = async (path: string) => {
    if (
      !confirm(
        `Remove ${shortDir(path)} from ${host.name}?\n\nNew work can't start there any more; sessions running in it keep going. You can add it back.`,
      )
    ) {
      return;
    }
    setRemoving(path);
    try {
      const res = await api.removeLocalHostDir(host.id, path);
      onChanged(res.host);
    } catch (err) {
      toast.error("Couldn't remove it", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
    setRemoving(null);
  };

  if (dirs.length === 0) return null;
  return (
    <ul className="space-y-1">
      {dirs.map((d) => (
        <li key={d.path} className="group flex items-center gap-2 text-xs min-h-6">
          <FolderGit2
            className={cn(
              "w-3.5 h-3.5 shrink-0",
              d.repoUrl ? "text-primary" : "text-text-muted/50",
            )}
          />
          <span className="font-mono text-text truncate" title={d.path}>
            {shortDir(d.path)}
          </span>
          {d.repoUrl && <span className="text-text-muted truncate">{repoLabel(d.repoUrl)}</span>}
          {editable && (
            <button
              type="button"
              onClick={() => remove(d.path)}
              disabled={removing !== null}
              title={`Remove from ${host.name}`}
              aria-label={`Remove ${d.path}`}
              className="ml-auto p-0.5 rounded text-text-muted/60 hover:text-error hover:bg-error/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity disabled:opacity-40 shrink-0"
            >
              {removing === d.path ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <X className="w-3 h-3" />
              )}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
