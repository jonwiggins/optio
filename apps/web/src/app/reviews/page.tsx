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
    <div className="page-column py-6">
      <PageHeader
        icon={GitPullRequest}
        title="Reviews"
        description="Keep pull requests moving, from the first review to the final verdict."
      />
      <PrBrowser />
    </div>
  );
}
