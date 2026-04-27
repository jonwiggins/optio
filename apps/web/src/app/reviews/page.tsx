"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { PageHeader } from "@/components/page-header";
import { PrBrowser } from "@/components/pr-browser";
import { GitPullRequest } from "lucide-react";

/**
 * Reviews list — PRs with their review status, across connected repos. Detail
 * pages live at /reviews/:id (one per pr_review record).
 */
export default function ReviewsPage() {
  usePageTitle("Reviews");
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        icon={GitPullRequest}
        title="Reviews"
        description="PRs across your connected repos, with review status and verdicts. Click any PR to open its review."
      />
      <PrBrowser />
    </div>
  );
}
