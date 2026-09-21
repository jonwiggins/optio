"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { WorkForm } from "@/components/work-form/work-form";

export default function NewWorkPage() {
  usePageTitle("New work");
  return <WorkForm />;
}
