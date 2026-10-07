"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { useCurrentUser } from "@/hooks/use-current-user";
import { WorkForm } from "@/components/work-form/work-form";
import { ViewerReadOnlyNotice } from "@/components/role-gate";

export default function NewWorkPage() {
  usePageTitle("New work");
  // A viewer who follows an old link or types the URL gets the reason, not a
  // form that fails on submit.
  const { canMutate } = useCurrentUser();
  return canMutate ? <WorkForm /> : <ViewerReadOnlyNotice />;
}
