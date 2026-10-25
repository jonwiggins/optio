"use client";

import { usePageTitle } from "@/hooks/use-page-title";
import { AuditTrail } from "@/components/audit/audit-trail";

/** The Audit page (docs/audit.md): components/audit/audit-trail.tsx. */
export default function AuditPage() {
  usePageTitle("Audit");
  return <AuditTrail />;
}
