"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, ChevronUp, ExternalLink, Hash } from "lucide-react";
import { BrandIcon, BRAND_LABEL, IssueIcon, PrIcon, brandFor } from "@/components/brand-icon";
import {
  collectWorkLinks,
  describeWorkLinkStatus,
  type WorkLink,
  type WorkLinkStatus,
} from "@optio/shared";
import { useWorkLinkStatuses } from "@/hooks/use-work-link-statuses";

/**
 * Badges for the PR / ticket links a terminal is working on. Every badge
 * opens in a new tab and swallows the click so it works inside clickable
 * cards. The ticket the terminal was spawned from comes first, and each PR
 * / ticket shows once however often it was seen (`collectWorkLinks` in
 * `@optio/shared`; the API folds the ticket in too, so every client agrees).
 */
export { collectWorkLinks };

/** Text a search box should match against for a terminal's links. */
export function workLinksSearchText(links: WorkLink[]): string {
  return links.map((l) => `${l.label} ${l.url}`).join(" ");
}

/**
 * Quiet chips: neutral surface, the kind carried by the icon (GitHub's PR
 * and issue glyphs in their colors, a Linear / Jira ticket by its brand
 * mark, a plain ref grey), so a row of badges reads as a list, not a row
 * of buttons. Once the host has answered (`useWorkLinkStatuses`) the icon
 * wears the state — a PR grey while draft, green open, purple merged, red
 * closed; a done issue the closed glyph — the border takes a hint of the
 * same color, and an open PR or a live ticket carries one small mark after
 * its label: a dot for CI (amber running, green passing, red failing or
 * changes requested) or a ticket in progress, a check for approved or done.
 */
function linkTitle(link: WorkLink, status?: WorkLinkStatus): string {
  if (isPr(link, status)) return link.provider === "gitlab" ? "Merge request" : "Pull request";
  if (link.kind === "ref") return "Reference";
  const brand = brandFor(link.provider);
  return brand && link.provider !== "github" ? `${BRAND_LABEL[brand]} ticket` : "Issue";
}

/** A PR's state as the PR glyph knows it; a bare ref that turned out to be a PR counts. */
function prState(status: WorkLinkStatus | undefined): "draft" | "open" | "merged" | "closed" {
  const s = status?.state;
  return s === "draft" || s === "merged" || s === "closed" ? s : "open";
}

function isPr(link: WorkLink, status: WorkLinkStatus | undefined): boolean {
  if (link.kind === "pr") return true;
  // A bare ref the host answered for as a PR (a closed issue reads `done`, so
  // `closed` is a PR too).
  const s = status?.state;
  return link.kind === "ref" && (s === "draft" || s === "merged" || s === "closed");
}

export function WorkLinkIcon({
  link,
  status,
  className,
}: {
  link: WorkLink;
  status?: WorkLinkStatus;
  className?: string;
}) {
  if (isPr(link, status)) return <PrIcon state={prState(status)} className={className} />;
  if (link.kind === "issue") {
    if (link.provider === "linear" || link.provider === "jira") {
      return (
        <BrandIcon
          brand={link.provider}
          className={cn(status?.state === "canceled" ? "text-text-muted" : "text-text", className)}
        />
      );
    }
    return <IssueIcon state={status?.state === "done" ? "closed" : "open"} className={className} />;
  }
  if (status?.state === "done") return <IssueIcon state="closed" className={className} />;
  return <Hash className={cn("shrink-0 text-text-muted", className)} aria-hidden />;
}

/** The hint of state color the chip's border takes. */
function borderTint(link: WorkLink, status: WorkLinkStatus | undefined): string {
  if (!status?.state) return "border-border/70";
  if (isPr(link, status)) {
    switch (prState(status)) {
      case "open":
        return "border-success/30";
      case "merged":
        return "border-[#8957e5]/40";
      case "closed":
        return "border-error/30";
      default:
        return "border-border/70";
    }
  }
  return status.state === "done" ? "border-[#8957e5]/40" : "border-border/70";
}

/**
 * The one mark after the label that says how it is going, or nothing:
 * red / amber / green dot for CI (or changes requested, or a ticket in
 * progress), a check for approved or done.
 */
export function WorkLinkMark({
  link,
  status,
  size,
}: {
  link: WorkLink;
  status?: WorkLinkStatus;
  size: "xs" | "sm";
}) {
  if (!status?.state) return null;
  const dot = size === "xs" ? "h-1.5 w-1.5" : "h-2 w-2";
  const check = size === "xs" ? "h-2.5 w-2.5" : "h-3 w-3";
  const Dot = ({ tone }: { tone: string }) => (
    <span className={cn("shrink-0 rounded-full", dot, tone)} aria-hidden data-mark={tone} />
  );
  const { state, checks, review } = status;
  if (state === "open" || state === "draft") {
    if (checks === "failing" || review === "changes_requested") return <Dot tone="bg-error" />;
    if (checks === "pending") return <Dot tone="bg-warning" />;
    if (review === "approved")
      return <Check className={cn("shrink-0 text-success", check)} strokeWidth={3} aria-hidden />;
    if (checks === "passing") return <Dot tone="bg-success" />;
    return null;
  }
  if (state === "in_progress") return <Dot tone="bg-warning" />;
  // A GitHub / GitLab issue's glyph already closes when done; a brand mark can't.
  if (state === "done" && (link.provider === "linear" || link.provider === "jira"))
    return <Check className={cn("shrink-0 text-[#8957e5]", check)} strokeWidth={3} aria-hidden />;
  return null;
}

export function WorkLinkBadge({
  link,
  status,
  size = "sm",
}: {
  link: WorkLink;
  status?: WorkLinkStatus;
  size?: "xs" | "sm";
}) {
  const standing = describeWorkLinkStatus(status);
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={[linkTitle(link, status), standing, link.url].filter(Boolean).join(" · ")}
      data-state={status?.state ?? undefined}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border bg-bg-card/60 font-mono max-w-full",
        borderTint(link, status),
        "text-text-muted hover:text-text hover:border-border-strong transition-colors",
        status?.state === "canceled" && "line-through decoration-text-muted/60",
        size === "xs" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs",
      )}
    >
      <WorkLinkIcon
        link={link}
        status={status}
        className={size === "xs" ? "w-3 h-3" : "w-3.5 h-3.5"}
      />
      <span className="truncate">{link.label}</span>
      <WorkLinkMark link={link} status={status} size={size} />
      {size === "sm" && <ExternalLink className="w-3 h-3 opacity-40 shrink-0" />}
    </a>
  );
}

export function WorkLinkBadges({
  links,
  size = "sm",
  max,
  className,
}: {
  links: WorkLink[];
  size?: "xs" | "sm";
  /** Initially show this many, with a toggle to expand and collapse the rest. */
  max?: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const statuses = useWorkLinkStatuses(links);
  if (links.length === 0) return null;
  const limit = max && max > 0 ? max : links.length;
  const shown = expanded ? links : links.slice(0, limit);
  const rest = links.length - limit;
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return (
    <div className={cn("flex items-center gap-1 flex-wrap min-w-0", className)}>
      {shown.map((l) => (
        <WorkLinkBadge key={l.url} link={l} status={statuses[l.url]} size={size} />
      ))}
      {rest > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? "Show fewer links" : `Show ${rest} more links`}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((value) => !value);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex items-center gap-1 shrink-0 rounded-md border border-transparent text-text-muted hover:text-text hover:bg-bg-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
            size === "xs" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs",
          )}
        >
          {expanded ? "Show less" : `+${rest} more`}
          <Chevron className="h-3 w-3" aria-hidden />
        </button>
      )}
    </div>
  );
}
