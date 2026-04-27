"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { usePageTitle } from "@/hooks/use-page-title";
import { TaskList } from "@/components/task-list";
import { PageHeader } from "@/components/page-header";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import Link from "next/link";
import { Plus, RotateCcw, XCircle, Loader2, Calendar, ListTodo } from "lucide-react";

/**
 * Tasks list page — Repo Tasks only.
 *
 * The legacy tab system (Tasks / Standalone / Issues / PRs all on one page)
 * was retired in favor of dedicated sidebar items: /jobs, /reviews, /issues.
 * Tab-based bookmarks redirect to the appropriate dedicated page.
 */
export default function TasksPage() {
  usePageTitle("Tasks");
  const searchParams = useSearchParams();
  const router = useRouter();
  const [bulkLoading, setBulkLoading] = useState(false);

  // Back-compat: ?tab=standalone|issues|prs → dedicated pages.
  useEffect(() => {
    const q = searchParams.get("tab");
    if (q === "standalone") router.replace("/jobs");
    else if (q === "issues") router.replace("/issues");
    else if (q === "prs") router.replace("/reviews");
  }, [searchParams, router]);

  const handleRetryFailed = async () => {
    if (!confirm("Retry all failed tasks?")) return;
    setBulkLoading(true);
    try {
      const res = await api.bulkRetryFailed();
      toast.success(`Retried ${res.retried} of ${res.total} failed tasks`);
    } catch {
      toast.error("Failed to retry tasks");
    }
    setBulkLoading(false);
  };

  const handleCancelActive = async () => {
    if (!confirm("Cancel all running and queued tasks?")) return;
    setBulkLoading(true);
    try {
      const res = await api.bulkCancelActive();
      toast.success(`Cancelled ${res.cancelled} of ${res.total} active tasks`);
    } catch {
      toast.error("Failed to cancel tasks");
    }
    setBulkLoading(false);
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        icon={ListTodo}
        title="Tasks"
        description="Agents that work in a repo and end by opening a pull request."
        actions={
          <>
            <button
              onClick={handleRetryFailed}
              disabled={bulkLoading}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-bg-card border border-border text-text-muted hover:text-text hover:bg-bg-hover disabled:opacity-50 transition-colors"
            >
              <RotateCcw className="w-3 h-3" />
              Retry Failed
            </button>
            <button
              onClick={handleCancelActive}
              disabled={bulkLoading}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-bg-card border border-border text-text-muted hover:text-error hover:bg-error/5 disabled:opacity-50 transition-colors"
            >
              <XCircle className="w-3 h-3" />
              Cancel Active
            </button>
            <Link
              href="/tasks/scheduled"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-bg-card border border-border text-text-muted hover:text-text hover:bg-bg-hover transition-colors"
            >
              <Calendar className="w-3 h-3" />
              Scheduled
            </Link>
            <Link
              href="/tasks/new"
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Task
            </Link>
          </>
        }
      />

      <Suspense
        fallback={
          <div className="flex items-center justify-center py-16 text-text-muted">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            Loading tasks...
          </div>
        }
      >
        <TaskList />
      </Suspense>
    </div>
  );
}
