"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Globe, Loader2, Lock, Search } from "lucide-react";
import { api } from "@/lib/api-client";
import { gitlabInstancesApi, type GitLabInstance } from "@/lib/gitlab-instances-api";
import { cn } from "@/lib/utils";
import { inputClass } from "@/components/ui/input";

type BrowsedProject = Awaited<ReturnType<typeof api.browseRepos>>["repos"][number];

const SEARCH_DEBOUNCE_MS = 300;

/**
 * Searchable list of the GitLab projects the person's own GITLAB_TOKEN (else
 * the organization's) is a member of, from `GET /api/repos/browse` — the
 * counterpart of `GitHubRepoBrowser` for GitLab. GitLab searches
 * path, name and description server-side (50 at a time); picking one hands
 * its metadata to the parent, and a pasted URL still works next to it.
 */
export function GitLabRepoBrowser({
  selected,
  onPick,
}: {
  /** `group/project` of the project currently chosen, to mark it. */
  selected: string | null;
  onPick: (repo: BrowsedProject) => void;
}) {
  const [instances, setInstances] = useState<GitLabInstance[]>([]);
  const [instance, setInstance] = useState("");
  useEffect(() => {
    void gitlabInstancesApi
      .list()
      .then((v) => setInstances(v.instances))
      .catch(() => {});
  }, []);
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<BrowsedProject[]>([]);
  const [host, setHost] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Drop responses to a search the user has already typed past.
  const requestId = useRef(0);

  const load = async (q: string) => {
    const id = ++requestId.current;
    setLoading(true);
    try {
      const res = await api.browseRepos({
        q: q.trim() || undefined,
        platform: "gitlab",
        ...(instance ? { instance } : {}),
      });
      if (id !== requestId.current) return;
      setRepos(res.repos);
      setHost(res.host);
      setError(res.error ?? "");
    } catch {
      if (id !== requestId.current) return;
      setError("Could not list GitLab projects");
      setRepos([]);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => void load(query), query ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
  }, [query, instance]);

  return (
    <div className="space-y-2">
      {instances.length > 0 && (
        <label className="block text-sm">
          GitLab instance
          <select
            aria-label="GitLab instance"
            className={inputClass()}
            value={instance}
            onChange={(e) => {
              setInstance(e.target.value);
              setRepos([]);
            }}
          >
            <option value="">Default GitLab host</option>
            {!instances.some((v) => v.baseUrl === "https://gitlab.com") && (
              <option value="https://gitlab.com">GitLab.com</option>
            )}
            {instances.map((v) => (
              <option key={v.id} value={v.baseUrl}>
                {v.displayName} · {v.baseUrl}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="relative">
        <Search className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your GitLab projects…"
          aria-label="Search GitLab projects"
          className={inputClass({ className: "pl-9" })}
          autoFocus
        />
      </div>

      <div
        className="max-h-64 overflow-y-auto rounded-lg border border-border divide-y divide-border/60"
        role="listbox"
        aria-label="GitLab projects"
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
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading projects…
          </div>
        )}
        {!loading && repos.length === 0 && (
          <p className="px-3 py-2 text-xs text-text-muted">
            {error || (query ? "No projects match." : "No projects found.")}
          </p>
        )}
      </div>

      {repos.length > 0 && error && <p className="text-xs text-error">{error}</p>}
      {!loading && repos.length >= 50 && (
        <p className="text-[11px] text-text-muted/80">
          Showing the 50 most recently active
          {host ? ` on ${host}` : ""} — search, or paste the URL below if yours isn't listed.
        </p>
      )}
    </div>
  );
}
