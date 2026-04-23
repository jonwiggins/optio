import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type ChecksStatus = "passing" | "failing" | "pending" | "none" | string | null | undefined;
type ReviewStatus =
  | "approved"
  | "changes_requested"
  | "commented"
  | "none"
  | string
  | null
  | undefined;
type PrState = "open" | "merged" | "closed" | string | null | undefined;

/**
 * Compact CI / review / merge-state row used by both task and PR-review
 * detail pages. All fields are optional — pass only what you have. The
 * `actions` slot renders right-aligned (e.g. "Request Review" button, cost
 * chip, merge button).
 */
export function PrStatusBar({
  checksStatus,
  reviewStatus,
  prState,
  actions,
}: {
  checksStatus?: ChecksStatus;
  reviewStatus?: ReviewStatus;
  prState?: PrState;
  actions?: ReactNode;
}) {
  const hasChecks = checksStatus && checksStatus !== "none";
  const hasReview = reviewStatus && reviewStatus !== "none";
  const hasPrState = prState && prState !== "open";
  if (!hasChecks && !hasReview && !hasPrState && !actions) return null;

  return (
    <div className="flex items-center gap-4 text-xs flex-wrap">
      {hasChecks && (
        <span
          className={cn(
            "flex items-center gap-1.5",
            checksStatus === "passing"
              ? "text-success"
              : checksStatus === "failing"
                ? "text-error"
                : "text-warning",
          )}
        >
          <span
            className={cn(
              "w-2 h-2 rounded-full",
              checksStatus === "passing"
                ? "bg-success"
                : checksStatus === "failing"
                  ? "bg-error"
                  : checksStatus === "pending"
                    ? "bg-warning animate-pulse"
                    : "bg-warning",
            )}
          />
          CI: {checksStatus}
        </span>
      )}
      {hasReview && (
        <span
          className={cn(
            "flex items-center gap-1",
            reviewStatus === "approved"
              ? "text-success"
              : reviewStatus === "changes_requested"
                ? "text-warning"
                : "text-text-muted",
          )}
        >
          Review: {reviewStatus === "changes_requested" ? "changes requested" : reviewStatus}
        </span>
      )}
      {hasPrState && (
        <span className={prState === "merged" ? "text-success" : "text-text-muted"}>{prState}</span>
      )}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}
