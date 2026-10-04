"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { PageHeader } from "@/components/page-header";
import { IssuesBrowser } from "@/components/issues-browser";
import { CircleDot } from "lucide-react";

export default function IssuesPage() {
  usePageTitle("Issues");
  return (
    <div className="page-column py-6">
      <PageHeader
        icon={CircleDot}
        title="Issues"
        description="GitHub issues across your connected repos. Assign one or many to Optio to spawn Repo Tasks."
      />
      <IssuesBrowser />
    </div>
  );
}
