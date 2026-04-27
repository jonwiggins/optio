"use client";

import Link from "next/link";
import { usePageTitle } from "@/hooks/use-page-title";
import { StandaloneList } from "@/components/standalone-list";
import { Plus } from "lucide-react";

/**
 * Jobs list — Standalone Tasks (workflows in the schema). One-shot agent runs
 * with no repo checkout. Triggered manually, by schedule, or by webhook.
 */
export default function JobsPage() {
  usePageTitle("Jobs");
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
          <p className="text-sm text-text-muted mt-1">
            Standalone agent runs — no repo checkout. Side effects via Connections (Slack, DBs,
            tickets) or pure logs.
          </p>
        </div>
        <Link
          href="/tasks/new?mode=standalone"
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors w-fit"
        >
          <Plus className="w-4 h-4" />
          New Job
        </Link>
      </div>
      <StandaloneList />
    </div>
  );
}
