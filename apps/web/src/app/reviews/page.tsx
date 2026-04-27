"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { PrBrowser } from "@/components/pr-browser";

/**
 * Reviews list — PRs with their review status, across connected repos. Detail
 * pages live at /reviews/:id (one per pr_review record).
 */
export default function ReviewsPage() {
  usePageTitle("Reviews");
  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Reviews</h1>
        <p className="text-sm text-text-muted mt-1">
          PRs across your connected repos, with review status and verdicts. Click any PR to open its
          review.
        </p>
      </div>
      <PrBrowser />
    </div>
  );
}
