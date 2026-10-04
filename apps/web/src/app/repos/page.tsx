"use client";

import { useEffect, useState } from "react";
import { ManagedChip } from "@/components/ui/managed-chip";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import Link from "next/link";
import { FolderGit2, Lock, Globe, ChevronRight, GitBranch, Box, Plus } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { BrandIcon, type Brand } from "@/components/brand-icon";
import { ButtonLink } from "@/components/ui/button";

/** The git host's mark, from the repo URL (GitHub unless it says otherwise). */
function repoBrand(repoUrl: string | undefined): Brand | null {
  const url = (repoUrl ?? "").toLowerCase();
  if (url.includes("codecommit")) return null;
  if (url.includes("gitlab")) return "gitlab";
  if (url.includes("bitbucket")) return "bitbucket";
  return "github";
}

export default function ReposPage() {
  usePageTitle("Repositories");
  const [repos, setRepos] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listRepos()
      .then((res) => setRepos(res.repos))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const privateCount = repos.filter((r) => r.isPrivate).length;

  return (
    <div className="page-column py-6">
      <PageHeader
        icon={FolderGit2}
        title="Repositories"
        description="Repos Optio can clone into a pod, open PRs against, and watch."
        meta={
          repos.length > 0 ? (
            <span>
              {repos.length} repo{repos.length === 1 ? "" : "s"} · {privateCount} private
            </span>
          ) : null
        }
        actions={
          <ButtonLink href="/repos/new">
            <Plus />
            Add Repository
          </ButtonLink>
        }
      />

      {loading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-14 skeleton-shimmer rounded-lg" />
          ))}
        </div>
      ) : repos.length === 0 ? (
        <EmptyState
          icon={FolderGit2}
          title="No repositories configured"
          description="Add a GitHub, GitLab, or CodeCommit repo to run PR work against it."
          action={{ label: "Add Repository", href: "/repos/new" }}
        />
      ) : (
        <div className="rounded-xl border border-border/70 overflow-hidden divide-y divide-border/60">
          {repos.map((repo: any) => {
            const brand = repoBrand(repo.repoUrl);
            return (
              <Link
                key={repo.id}
                href={`/repos/${repo.id}`}
                className="group flex items-center gap-3 px-4 py-3 bg-bg-card/40 hover:bg-bg-hover/60 transition-colors"
              >
                <span className="grid place-items-center w-7 h-7 rounded-md border border-border/70 bg-bg/60 text-text-muted shrink-0">
                  {brand ? (
                    <BrandIcon brand={brand} className="w-3.5 h-3.5" />
                  ) : (
                    <FolderGit2 className="w-3.5 h-3.5" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-heading truncate">
                      {repo.fullName}
                    </span>
                    {repo.isPrivate ? (
                      <Lock className="w-3 h-3 text-text-muted shrink-0" aria-label="Private" />
                    ) : (
                      <Globe className="w-3 h-3 text-text-muted shrink-0" aria-label="Public" />
                    )}
                    <ManagedChip managedBy={repo.managedBy} className="shrink-0" />
                  </div>
                </div>
                <div className="hidden sm:flex items-center gap-4 text-[11px] text-text-muted shrink-0">
                  <span className="inline-flex items-center gap-1">
                    <GitBranch className="w-3 h-3" />
                    <span className="font-mono">{repo.defaultBranch}</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Box className="w-3 h-3" />
                    {repo.imagePreset ?? "base"}
                  </span>
                  {repo.autoMerge && (
                    <span className="px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                      auto-merge
                    </span>
                  )}
                </div>
                <ChevronRight className="w-4 h-4 text-text-muted/50 group-hover:text-text-muted shrink-0 transition-colors" />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
