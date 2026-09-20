"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * The per-kind Tasks list is retired: every kind of work lives in the one
 * list at /sessions. This stub keeps old bookmarks and the legacy
 * `?tab=standalone|issues|prs` URLs working.
 */
export default function LegacyTasksRedirect() {
  return (
    <Suspense fallback={null}>
      <Redirect />
    </Suspense>
  );
}

function Redirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab === "issues") router.replace("/issues");
    else if (tab === "prs") router.replace("/reviews");
    else if (tab === "standalone") router.replace("/sessions?view=recurring");
    else {
      const stage = searchParams.get("stage");
      const view = stage === "failed" || stage === "done" ? "history" : "active";
      router.replace(`/sessions?view=${view}`);
    }
  }, [searchParams, router]);
  return null;
}
