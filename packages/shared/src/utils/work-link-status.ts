import type { CICheck, Review } from "../types/git-platform.js";
import type { WorkLink } from "./extract-work-links.js";

/**
 * Where a PR / ticket a session touches stands, looked up at its host so a
 * badge can wear it: a PR's draft / open / merged / closed, and for an open
 * one how its CI and review are going; a ticket's open / in progress /
 * done / canceled. `state: null` means the host could not be asked (no
 * token, no access, not configured) — the badge then shows nothing extra.
 */
export type WorkLinkState =
  "draft" | "open" | "merged" | "closed" | "in_progress" | "done" | "canceled";

/** Where an open PR's CI stands; `none` = no checks reported. */
export type WorkLinkChecks = "none" | "pending" | "passing" | "failing";
/** Where an open PR's review stands; `none` = no review yet. */
export type WorkLinkReview = "none" | "approved" | "changes_requested";

export interface WorkLinkStatus {
  /** The canonical URL the status was asked for. */
  url: string;
  state: WorkLinkState | null;
  /** Open PRs only. */
  checks?: WorkLinkChecks;
  /** Open PRs only. */
  review?: WorkLinkReview;
}

/** How many URLs one status request may carry. */
export const MAX_WORK_LINK_STATUS_URLS = 50;

/** Roll a PR's check runs up into one word. */
export function summarizeChecks(checks: CICheck[]): WorkLinkChecks {
  if (checks.length === 0) return "none";
  if (checks.some((c) => c.conclusion === "failure" || c.conclusion === "cancelled"))
    return "failing";
  if (checks.some((c) => c.status !== "completed")) return "pending";
  return "passing";
}

/**
 * Roll a PR's reviews up into one word: each reviewer's latest verdict
 * counts (an approval after a change request supersedes it), a change
 * request from anyone outranks approvals.
 */
export function summarizeReviews(reviews: Review[]): WorkLinkReview {
  const latest = new Map<string, Review["state"]>();
  for (const r of reviews) {
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") latest.set(r.author, r.state);
    else if (r.state === "DISMISSED") latest.delete(r.author);
  }
  const states = [...latest.values()];
  if (states.includes("CHANGES_REQUESTED")) return "changes_requested";
  if (states.includes("APPROVED")) return "approved";
  return "none";
}

const STATE_WORD: Record<WorkLinkState, string> = {
  draft: "draft",
  open: "open",
  merged: "merged",
  closed: "closed",
  in_progress: "in progress",
  done: "done",
  canceled: "canceled",
};

const CHECKS_WORD: Record<WorkLinkChecks, string | null> = {
  none: null,
  pending: "CI running",
  passing: "CI passing",
  failing: "CI failing",
};

const REVIEW_WORD: Record<WorkLinkReview, string | null> = {
  none: null,
  approved: "approved",
  changes_requested: "changes requested",
};

/** The status in words for a tooltip: "open · CI passing · approved". Empty when unknown. */
export function describeWorkLinkStatus(status: WorkLinkStatus | undefined): string {
  if (!status?.state) return "";
  const parts = [STATE_WORD[status.state]];
  if (status.checks && CHECKS_WORD[status.checks]) parts.push(CHECKS_WORD[status.checks]!);
  if (status.review && REVIEW_WORD[status.review]) parts.push(REVIEW_WORD[status.review]!);
  return parts.join(" · ");
}

/** The links whose status a host can report (bare refs resolve to an issue or PR too). */
export function statusableWorkLinks(links: WorkLink[]): WorkLink[] {
  return links.filter((l) => l.kind === "pr" || l.kind === "issue" || l.kind === "ref");
}
