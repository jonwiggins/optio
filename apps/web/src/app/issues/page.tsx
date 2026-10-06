"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { PageHeader } from "@/components/page-header";
import { IssuesBrowser } from "@/components/issues-browser";
import { Inbox } from "lucide-react";

export default function IssuesPage() {
  usePageTitle("Inbox");
  return (
    <div className="page-column py-6">
      <PageHeader
        icon={Inbox}
        title="Inbox"
        description="Issues from your connected repositories and ticket providers. Choose what Optio should work on next."
      />
      <IssuesBrowser />
    </div>
  );
}
