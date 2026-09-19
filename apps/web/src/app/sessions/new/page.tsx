"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { SessionForm } from "@/components/session-form/session-form";

export default function NewSessionPage() {
  usePageTitle("New session");
  return <SessionForm />;
}
