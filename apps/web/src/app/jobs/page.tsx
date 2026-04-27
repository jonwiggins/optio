"use client";

import Link from "next/link";
import { usePageTitle } from "@/hooks/use-page-title";
import { StandaloneList } from "@/components/standalone-list";
import { PageHeader } from "@/components/page-header";
import { Plus, Zap } from "lucide-react";

/**
 * Jobs list — Standalone Tasks (workflows in the schema). One-shot agent runs
 * with no repo checkout. Triggered manually, by schedule, or by webhook.
 */
export default function JobsPage() {
  usePageTitle("Jobs");
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        icon={Zap}
        title="Jobs"
        description="Standalone agent runs — no repo checkout. Side effects via Connections (Slack, DBs, tickets) or pure logs."
        actions={
          <Link
            href="/tasks/new?mode=standalone"
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Job
          </Link>
        }
      />
      <StandaloneList />
    </div>
  );
}
