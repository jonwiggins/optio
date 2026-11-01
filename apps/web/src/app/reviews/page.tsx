"use client";

import { Suspense } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { PrInbox } from "@/components/pr-inbox/pr-inbox";

/**
 * Pull requests — every open PR in the workspace's repositories, grouped by
 * whose move it is (components/pr-inbox/). Optio's own reviews keep their
 * detail pages at /reviews/:id.
 */
export default function ReviewsPage() {
  usePageTitle("Pull requests");
  return (
    <Suspense>
      <PrInbox />
    </Suspense>
  );
}
