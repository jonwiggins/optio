"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import Link from "next/link";
import { cn, formatRelativeTime, formatDuration } from "@/lib/utils";
import { Plus, Terminal, Loader2, FolderGit2, CircleDot, StopCircle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";

export default function SessionsPage() {
  const [sessions, setSessions] = useState<any[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "active" | "ended">("all");
  const [repos, setRepos] = useState<any[]>([]);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api
      .listRepos()
      .then((res) => setRepos(res.repos))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    api
      .listSessions({
        state: filter === "all" ? undefined : filter,
        repoUrl: selectedRepo || undefined,
      })
      .then((res) => {
        setSessions(res.sessions);
        setActiveCount(res.activeCount);
      })
      .catch(() => toast.error("Failed to load sessions"))
      .finally(() => setLoading(false));
  }, [filter, selectedRepo]);

  const handleCreate = async () => {
    if (repos.length === 0) {
      toast.error("Add a repo first");
      return;
    }
    const repoUrl = selectedRepo || repos[0]?.repoUrl;
    if (!repoUrl) return;
    setCreating(true);
    try {
      const res = await api.createSession({ repoUrl });
      toast.success("Session created");
      setSessions((prev) => [res.session, ...prev]);
      setActiveCount((c) => c + 1);
      // Navigate to the new session
      window.location.href = `/sessions/${res.session.id}`;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create session");
    }
    setCreating(false);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        icon={Terminal}
        title="Sessions"
        description="Interactive workspaces connected to repo pods. Use the terminal + chat to drive an agent in real time."
        meta={
          <>
            {activeCount > 0 && (
              <span className="inline-flex items-center gap-1.5 text-primary">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                {activeCount} active
              </span>
            )}
            <div className="flex items-center gap-1.5">
              {(["all", "active", "ended"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setFilter(tab)}
                  className={cn(
                    "px-2 py-0.5 rounded text-[11px] capitalize transition-colors",
                    filter === tab
                      ? "bg-primary/15 text-primary"
                      : "text-text-muted/80 hover:text-text",
                  )}
                >
                  {tab}
                </button>
              ))}
            </div>
          </>
        }
        actions={
          <>
            {repos.length > 1 && (
              <select
                value={selectedRepo}
                onChange={(e) => setSelectedRepo(e.target.value)}
                className="px-3 py-2 rounded-lg bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
              >
                <option value="">All repos</option>
                {repos.map((r: any) => (
                  <option key={r.id} value={r.repoUrl}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={handleCreate}
              disabled={creating || repos.length === 0}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
            >
              {creating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              New Session
            </button>
          </>
        }
      />

      {loading ? (
        <div className="flex items-center justify-center py-16 text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading sessions...
        </div>
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={Terminal}
          title="No sessions yet"
          description="Start a new session to get an interactive terminal connected to a repo pod."
        />
      ) : (
        <div className="grid gap-2">
          {sessions.map((session: any) => (
            <SessionCard key={session.id} session={session} />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionCard({ session }: { session: any }) {
  const isActive = session.state === "active";
  const repoName = session.repoUrl ? session.repoUrl.replace("https://github.com/", "") : "Unknown";

  return (
    <Link
      href={`/sessions/${session.id}`}
      className="card-hover block p-4 rounded-lg border border-border bg-bg-card hover:border-primary/30"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={cn(
              "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
              isActive ? "bg-primary/10 text-primary" : "bg-bg text-text-muted",
            )}
          >
            <Terminal className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">
                {session.branch ?? `Session ${session.id.slice(0, 8)}`}
              </span>
              <span
                className={cn(
                  "inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium tracking-wide uppercase",
                  isActive ? "text-primary" : "text-text-muted",
                )}
              >
                <span
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    isActive ? "bg-primary animate-pulse" : "bg-text-muted",
                  )}
                />
                {session.state}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-0.5 text-xs text-text-muted">
              <span className="flex items-center gap-1">
                <FolderGit2 className="w-3 h-3" />
                {repoName}
              </span>
              <span>Started {formatRelativeTime(session.createdAt)}</span>
              {isActive && (
                <span className="text-primary">{formatDuration(session.createdAt)}</span>
              )}
              {session.endedAt && (
                <span>Duration: {formatDuration(session.createdAt, session.endedAt)}</span>
              )}
            </div>
          </div>
        </div>
        {isActive && (
          <div className="shrink-0">
            <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-xs font-medium">
              <CircleDot className="w-3 h-3" />
              Connect
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}
