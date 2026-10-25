"use client";

import { BookOpen } from "lucide-react";
import { usePageTitle } from "@/hooks/use-page-title";
import { useDeploymentSwitches } from "@/hooks/use-deployment-switches";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { GuideMarkdown } from "@/components/help/guide-markdown";
import { USING_OPTIO_GUIDE } from "@/content/using-optio-guide";

/**
 * The guide for the people who use Optio (docs/using-optio.md), in the app:
 * Help → Using Optio. Shown while a deployment admin has the getting-started
 * guide on (Settings → Access); otherwise the page says it is off.
 */
export default function HelpPage() {
  usePageTitle("Using Optio");
  const { onboarding, loaded } = useDeploymentSwitches();
  return (
    <div className="page-column py-6">
      <PageHeader
        icon={BookOpen}
        title="Using Optio"
        description="Signing in, starting work, reviewing and merging: the guide for the people who use Optio."
      />
      {!loaded ? null : onboarding ? (
        // The page header is the guide's title.
        <GuideMarkdown source={USING_OPTIO_GUIDE.replace(/^# .*\n+/, "")} />
      ) : (
        <EmptyState
          icon={BookOpen}
          title="The guide is off"
          description="A deployment admin turns it on under Settings → Access → Getting-started guide."
        />
      )}
    </div>
  );
}
