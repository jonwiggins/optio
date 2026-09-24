"use client";

import { cn } from "@/lib/utils";
import { GitPullRequest, CircleDot, ExternalLink, Hash } from "lucide-react";
import { dedupeWorkLinks, type WorkLink } from "@optio/shared";

/**
 * Badges for the PR / ticket links a terminal is working on. Every badge
 * opens in a new tab and swallows the click so it works inside clickable
 * cards. `ticket` (the issue or PR the terminal was spawned from) comes
 * first, and each PR / ticket shows once however often it was seen
 * (`dedupeWorkLinks`).
 */
export function collectWorkLinks(terminal: {
  links?: WorkLink[] | null;
  ticketUrl?: string | null;
  ticketSource?: string | null;
  ticketExternalId?: string | null;
}): WorkLink[] {
  const scanned = terminal.links ?? [];
  if (!terminal.ticketUrl) return dedupeWorkLinks(scanned);
  const provider = terminal.ticketSource === "gitlab" ? "gitlab" : "github";
  // A review-request automation's "ticket" is the PR itself.
  const pr = /\/(pull|merge_requests)\/\d+/.test(terminal.ticketUrl);
  // An event trigger stores the full ref ("acme/app#607"); a ticket sync just the number.
  const id = terminal.ticketExternalId;
  const ticket: WorkLink = {
    url: terminal.ticketUrl,
    kind: pr ? "pr" : "issue",
    provider,
    label: !id ? "ticket" : /[#!/]/.test(id) ? id : `#${id}`,
  };
  return dedupeWorkLinks([ticket, ...scanned]);
}

/** Text a search box should match against for a terminal's links. */
export function workLinksSearchText(links: WorkLink[]): string {
  return links.map((l) => `${l.label} ${l.url}`).join(" ");
}

/**
 * Quiet chips: neutral surface, the kind carried by the icon's color (PR
 * green, ticket blue, plain ref grey — the colors those things have on
 * GitHub), so a row of badges reads as a list, not a row of buttons.
 */
const KIND: Record<WorkLink["kind"], { icon: typeof GitPullRequest; tint: string; title: string }> =
  {
    pr: { icon: GitPullRequest, tint: "text-success", title: "Pull request" },
    issue: { icon: CircleDot, tint: "text-info", title: "Ticket" },
    ref: { icon: Hash, tint: "text-text-muted", title: "Reference" },
  };

export function WorkLinkBadge({ link, size = "sm" }: { link: WorkLink; size?: "xs" | "sm" }) {
  const kind = KIND[link.kind] ?? KIND.ref;
  const Icon = kind.icon;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${kind.title} · ${link.url}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border/70 bg-bg-card/60 font-mono max-w-full",
        "text-text-muted hover:text-text hover:border-border-strong transition-colors",
        size === "xs" ? "px-1.5 py-0.5 text-[11px]" : "px-2 py-1 text-xs",
      )}
    >
      <Icon className={cn("shrink-0", kind.tint, size === "xs" ? "w-3 h-3" : "w-3.5 h-3.5")} />
      <span className="truncate">{link.label}</span>
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
  /** Show at most this many, then a "+N" chip. */
  max?: number;
  className?: string;
}) {
  if (links.length === 0) return null;
  const shown = max ? links.slice(0, max) : links;
  const rest = links.length - shown.length;
  return (
    <div className={cn("flex items-center gap-1 flex-wrap min-w-0", className)}>
      {shown.map((l) => (
        <WorkLinkBadge key={l.url} link={l} size={size} />
      ))}
      {rest > 0 && (
        <span
          className={cn("text-text-muted/70 font-mono", size === "xs" ? "text-[11px]" : "text-xs")}
          title={links
            .slice(shown.length)
            .map((l) => l.label)
            .join(", ")}
        >
          +{rest}
        </span>
      )}
    </div>
  );
}
