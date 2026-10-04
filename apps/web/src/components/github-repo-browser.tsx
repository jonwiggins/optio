"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Globe, Loader2, Lock, Search } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { inputClass } from "@/components/ui/input";

type BrowsedRepo = Awaited<ReturnType<typeof api.browseGitHubRepos>>["repos"][number];

const PER_PAGE = 20;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Searchable list of the GitHub repositories the server's stored credentials
 * can reach (GitHub App installation or GITHUB_TOKEN, org repos included).
 * Picking one hands its metadata to the parent; a free-text URL still works
 * next to it for anything not listed.
 */
export function GitHubRepoBrowser({
  selected,
  onPick,
}: {
  /** `owner/name` of the repo currently chosen, to mark it. */
  selected: string | null;
  onPick: (repo: BrowsedRepo) => void;
}) {
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<BrowsedRepo[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Drop responses to a search the user has already typed past.
  const requestId = useRef(0);

  const load = async (q: string, nextPage: number) => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const res = await api.browseGitHubRepos({
        q: q.trim() || undefined,
        page: nextPage,
        perPage: PER_PAGE,
      });
      if (id !== requestId.current) return;
      setRepos((prev) => (nextPage === 1 ? res.repos : [...prev, ...res.repos]));
      setPage(nextPage);
      setHasMore(res.hasMore);
      setTruncated(!!res.truncated);
      setError(res.error ?? "");
    } catch {
      if (id !== requestId.current) return;
      setError("Could not list repositories");
      if (nextPage === 1) setRepos([]);
      setHasMore(false);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => void load(query, 1), query ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your repositories…"
          aria-label="Search accessible repositories"
          className={inputClass({ className: "pl-9" })}
          autoFocus
        />
      </div>

      <div
        className="max-h-64 overflow-y-auto rounded-lg border border-border divide-y divide-border/60"
        role="listbox"
        aria-label="Accessible repositories"
      >
        {repos.map((r) => {
          const isSelected = selected === r.fullName;
          return (
            <button
              key={r.fullName}
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => onPick(r)}
              className={cn(
                "w-full flex items-start gap-2 px-3 py-2 text-left text-sm transition-colors",
                isSelected ? "bg-primary/5" : "hover:bg-bg-hover",
              )}
            >
              {r.isPrivate ? (
                <Lock className="w-3.5 h-3.5 text-text-muted mt-0.5 shrink-0" />
              ) : (
                <Globe className="w-3.5 h-3.5 text-text-muted mt-0.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1">
                <span className="font-medium">{r.fullName}</span>
                {r.description && (
                  <span className="block text-xs text-text-muted truncate">{r.description}</span>
                )}
              </span>
              {isSelected && <Check className="w-4 h-4 text-success shrink-0" />}
            </button>
          );
        })}

        {loading && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-text-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading repositories…
          </div>
        )}
        {!loading && repos.length === 0 && (
          <p className="px-3 py-2 text-xs text-text-muted">
            {error || (query ? "No repositories match." : "No repositories found.")}
          </p>
        )}
        {!loading && hasMore && (
          <button
            type="button"
            onClick={() => void load(query, page + 1)}
            className="w-full px-3 py-2 text-xs text-primary hover:bg-bg-hover text-left"
          >
            Load more
          </button>
        )}
      </div>

      {repos.length > 0 && error && <p className="text-xs text-error">{error}</p>}
      {truncated && (
        <p className="text-[11px] text-text-muted/80">
          Searched the first 1,000 repositories — paste the URL below if yours isn't listed.
        </p>
      )}
    </div>
  );
}
