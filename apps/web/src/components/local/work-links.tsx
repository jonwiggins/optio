"use client";

import { cn } from "@/lib/utils";
import { GitPullRequest, CircleDot, ExternalLink, Hash } from "lucide-react";
import type { WorkLink } from "@optio/shared";

/**
 * Badges for the PR / ticket links a terminal is working on. Every badge
 * opens in a new tab and swallows the click so it works inside clickable
 * cards. `ticket` (the issue the terminal was spawned from) is merged in
 * first when it isn't already among the scanned links.
 */
export function collectWorkLinks(terminal: {
  links?: WorkLink[] | null;
  ticketUrl?: string | null;
  ticketSource?: string | null;
  ticketExternalId?: string | null;
}): WorkLink[] {
  const scanned = terminal.links ?? [];
  if (!terminal.ticketUrl || scanned.some((l) => l.url === terminal.ticketUrl)) return scanned;
  const provider = terminal.ticketSource === "gitlab" ? "gitlab" : "github";
  return [
    {
      url: terminal.ticketUrl,
      kind: "issue",
      provider,
      label: terminal.ticketExternalId ? `#${terminal.ticketExternalId}` : "ticket",
    },
    ...scanned,
  ];
}

/** Text a search box should match against for a terminal's links. */
export function workLinksSearchText(links: WorkLink[]): string {
  return links.map((l) => `${l.label} ${l.url}`).join(" ");
}

export function WorkLinkBadge({ link, size = "sm" }: { link: WorkLink; size?: "xs" | "sm" }) {
  const Icon = link.kind === "pr" ? GitPullRequest : link.kind === "ref" ? Hash : CircleDot;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`${link.kind === "pr" ? "Pull request" : link.kind === "ref" ? "Reference" : "Ticket"} · ${link.url}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border font-mono transition-colors max-w-full",
        "hover:text-text hover:border-primary/50",
        link.kind === "pr"
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border bg-bg text-text-muted",
        size === "xs" ? "px-1.5 py-px text-[10px]" : "px-2 py-0.5 text-[11px]",
      )}
    >
      <Icon className={cn("shrink-0", size === "xs" ? "w-2.5 h-2.5" : "w-3 h-3")} />
      <span className="truncate">{link.label}</span>
      {size === "sm" && <ExternalLink className="w-2.5 h-2.5 opacity-50 shrink-0" />}
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
          className={cn(
            "text-text-muted/70 font-mono",
            size === "xs" ? "text-[10px]" : "text-[11px]",
          )}
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
