"use client";

import type { ReactNode } from "react";
import { Eye } from "lucide-react";
import { useCurrentUser } from "@/hooks/use-current-user";

/**
 * Shows `children` only to people who may change things: members, admins,
 * and everyone when auth is disabled (Android's `IfCanMutate`). Viewers are
 * read-only on every mutating route, so a "New work" button would only take
 * them to a form the server rejects on submit. While the user is still
 * unknown the children show, so nothing flickers on auth-disabled installs.
 */
export function IfCanMutate({ children }: { children: ReactNode }) {
  const { canMutate } = useCurrentUser();
  return canMutate ? <>{children}</> : null;
}

/** What a viewer sees in place of a creation form. */
export function ViewerReadOnlyNotice({ what = "work" }: { what?: string }) {
  return (
    <div role="status" className="page-column py-16">
      <div className="mx-auto max-w-md rounded-xl border border-border/70 bg-bg-card/50 px-6 py-10 text-center">
        <div className="mx-auto mb-4 w-fit rounded-2xl bg-bg-hover/70 p-3.5">
          <Eye className="h-6 w-6 text-text-muted/70" />
        </div>
        <h1 className="text-base font-semibold text-text-heading">
          Viewers can&apos;t create {what}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-text-muted">
          Your role in this workspace is viewer, which is read-only. A workspace admin can make you
          a member.
        </p>
      </div>
    </div>
  );
}
