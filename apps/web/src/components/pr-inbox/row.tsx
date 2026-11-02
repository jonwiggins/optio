"use client";

import { useEffect, useRef, useState, type ComponentType, type CSSProperties } from "react";
import Link from "next/link";
import { Bot, Copy, ExternalLink, Loader2, MoreHorizontal, Sparkles } from "lucide-react";
import { OctCheck, OctFileDiff, OctGitCompare, OctGitMerge, OctSync } from "./octicons";
import type { PrInboxItem } from "@optio/shared";
import { cn } from "@/lib/utils";
import { Button, buttonClass } from "@/components/ui/button";
import { ConfirmPopover } from "@/components/ui/confirm-popover";
import { ActionBadge, Signals } from "./signals";
import { MERGE_VERB, menuActions, rowActions, shortAge, type RowAction } from "./model";

type Run = (item: PrInboxItem, action: RowAction) => Promise<boolean>;

const ICON: Record<RowAction["kind"], ComponentType<{ className?: string }>> = {
  agent: Bot,
  "open-task": Bot,
  "open-files": OctFileDiff,
  "optio-review": Sparkles,
  "open-review": Sparkles,
  merge: OctGitMerge,
  quick: OctSync,
  "copy-link": Copy,
};

function iconFor(a: RowAction) {
  if (a.kind === "quick") {
    return a.action === "approve"
      ? OctCheck
      : a.action === "update_branch"
        ? OctGitCompare
        : OctSync;
  }
  return ICON[a.kind];
}

function hrefFor(a: RowAction): { href: string; external: boolean } | null {
  if (a.kind === "open-files") return { href: a.href, external: true };
  if (a.kind === "open-task") return { href: `/work/${a.taskId}`, external: false };
  if (a.kind === "open-review") return { href: `/reviews/${a.reviewId}`, external: false };
  return null;
}

/** The confirm step every merge goes through: what, into what, how. */
function mergeDetail(item: PrInboxItem) {
  const f = item.facts;
  const approvers = f.reviews.filter((r) => r.state === "approved").map((r) => `@${r.author}`);
  const ci =
    f.checks === "passing" ? "CI green" : f.checks === "none" ? "no checks" : `CI ${f.checks}`;
  return (
    <span className="block space-y-0.5">
      <span className="block text-text">{f.title}</span>
      <span className="block">
        Into <code>{f.baseBranch ?? "base"}</code> · {ci}
        {approvers.length > 0 && ` · approved by ${approvers.join(", ")}`}
      </span>
    </span>
  );
}

export function PrRow({
  item,
  me,
  showRepo,
  canMutate,
  run,
}: {
  item: PrInboxItem;
  me: Set<string>;
  showRepo: boolean;
  canMutate: boolean;
  run: Run;
}) {
  const { facts, status } = item;
  const buttons = rowActions(item);
  const quiet = status.owner === "others";
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmMerge, setConfirmMerge] = useState<RowAction | null>(null);

  const go = async (a: RowAction) => {
    if (a.kind === "merge") {
      setConfirmMerge(a);
      return;
    }
    setBusy(a.label);
    try {
      await run(item, a);
    } finally {
      setBusy(null);
    }
  };

  const age = (
    <span
      className={cn(
        "w-9 text-right text-[11px] tabular-nums whitespace-nowrap",
        status.stale ? "text-warning font-medium" : "text-text-muted/70",
      )}
      title={
        status.since
          ? `${status.stale ? "Waiting a while · " : ""}since ${new Date(status.since).toLocaleString()}`
          : undefined
      }
    >
      {shortAge(status.since ?? facts.updatedAt)}
    </span>
  );
  const host = facts.platform === "gitlab" ? "GitLab" : "GitHub";
  // The detail line already names the author on these rows.
  const showAuthor =
    status.role !== "author" && status.role !== "reviewer" && status.action !== "needs_reviewer";

  return (
    <div
      className={cn(
        "group flex flex-col gap-1.5 px-4 py-3 transition-colors hover:bg-bg-hover/50",
        "md:grid md:grid-cols-[10rem_minmax(0,1fr)_auto] md:items-center md:gap-x-3 md:gap-y-0",
      )}
      data-testid="pr-row"
      data-action={status.action}
    >
      <div className="flex items-center justify-between gap-2">
        <ActionBadge status={status} />
        <span className="md:hidden">{age}</span>
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <a
            href={facts.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "text-sm font-medium hover:text-primary transition-colors line-clamp-2 md:line-clamp-none md:truncate",
              quiet ? "text-text" : "text-text-heading",
            )}
            title={facts.title}
          >
            {facts.title}
          </a>
          <span className="text-xs text-text-muted/70 shrink-0 tabular-nums">#{facts.number}</span>
          {facts.draft && status.label !== "Draft" && (
            <span className="text-[10px] px-1.5 rounded-full border border-border text-text-muted shrink-0">
              Draft
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-muted min-w-0">
          {status.detail && <span className={cn(!quiet && "text-text")}>{status.detail}</span>}
          {status.detail && (showRepo || showAuthor) && (
            <span aria-hidden className="text-text-muted/40">
              ·
            </span>
          )}
          {showRepo && <span className="font-mono text-[11px]">{facts.repoFullName}</span>}
          {showAuthor && <span>@{facts.author}</span>}
        </div>
        <Signals facts={facts} className="mt-1.5 flex" />
      </div>
      <div className="flex items-center justify-end gap-1.5">
        {canMutate &&
          buttons.map((a, i) => (
            <ActionButton
              key={a.label}
              action={a}
              busy={busy === a.label}
              onRun={() => void go(a)}
              className={i > 0 ? "hidden lg:inline-flex" : undefined}
            />
          ))}
        <span className="hidden md:inline">{age}</span>
        <ConfirmPopover
          open={!!confirmMerge}
          title={`${confirmMerge?.kind === "merge" ? MERGE_VERB[confirmMerge.method] : "Merge"} #${facts.number}?`}
          detail={mergeDetail(item)}
          confirmLabel={confirmMerge?.kind === "merge" ? MERGE_VERB[confirmMerge.method] : "Merge"}
          busy={busy === "merge"}
          onCancel={() => setConfirmMerge(null)}
          onConfirm={async () => {
            if (!confirmMerge) return;
            setBusy("merge");
            const ok = await run(item, confirmMerge);
            setBusy(null);
            if (ok) setConfirmMerge(null);
          }}
        >
          <RowMenu
            item={item}
            actions={
              canMutate
                ? menuActions(item, me)
                : menuActions(item, me).filter((a) => hrefFor(a) || a.kind === "copy-link")
            }
            onRun={(a) => void go(a)}
          />
        </ConfirmPopover>
        <a
          href={facts.url}
          target="_blank"
          rel="noopener noreferrer"
          className="p-1 rounded text-text-muted/60 hover:text-text hover:bg-bg-hover"
          aria-label={`Open #${facts.number} on ${host}`}
          title={`Open on ${host}`}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>
    </div>
  );
}

function ActionButton({
  action,
  busy,
  onRun,
  className,
}: {
  action: RowAction;
  busy: boolean;
  onRun: () => void;
  className?: string;
}) {
  const Icon = iconFor(action);
  const link = hrefFor(action);
  const disabled = "disabled" in action ? action.disabled : undefined;
  if (link) {
    return link.external ? (
      <a
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonClass({ variant: "secondary", size: "sm", className })}
      >
        <Icon />
        {action.label}
      </a>
    ) : (
      <Link
        href={link.href}
        className={buttonClass({ variant: "secondary", size: "sm", className })}
      >
        <Icon />
        {action.label}
      </Link>
    );
  }
  return (
    <Button
      size="sm"
      variant="secondary"
      className={className}
      disabled={busy || !!disabled}
      title={disabled}
      onClick={onRun}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Icon />}
      {action.label}
    </Button>
  );
}

/** "⋯": everything the PR's state makes possible. Escape or a click outside closes it. */
function RowMenu({
  item,
  actions,
  onRun,
}: {
  item: PrInboxItem;
  actions: RowAction[];
  onRun: (a: RowAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({});
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Fixed to the viewport, beside the button: list panels clip their overflow.
  const toggle = () => {
    if (!open && trigger.current) {
      const r = trigger.current.getBoundingClientRect();
      const right = window.innerWidth - r.right;
      setPlace(
        r.bottom + 340 > window.innerHeight
          ? { position: "fixed", right, bottom: window.innerHeight - r.top + 4 }
          : { position: "fixed", right, top: r.bottom + 4 },
      );
    }
    setOpen((o) => !o);
  };
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    menu.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [
          ...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])") ?? []),
        ];
        const at = items.indexOf(document.activeElement as HTMLElement);
        const next = (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const label = `More actions for #${item.facts.number}`;
  return (
    <span className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className="p-1.5 rounded-md text-text-muted hover:text-text hover:bg-bg-hover"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div
            ref={menu}
            role="menu"
            aria-label={label}
            style={place}
            className="z-30 min-w-[15rem] rounded-lg border border-border bg-bg shadow-lg py-1 text-sm"
          >
            {actions.map((a) => {
              const Icon = iconFor(a);
              const link = hrefFor(a);
              const disabled = "disabled" in a ? a.disabled : undefined;
              const cls =
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-text hover:bg-bg-hover focus:bg-bg-hover focus:outline-none disabled:text-text-muted/50 disabled:hover:bg-transparent";
              const body = (
                <>
                  <Icon className="w-3.5 h-3.5 shrink-0 text-text-muted" />
                  <span className="flex-1">{a.label}</span>
                  {disabled && (
                    <span className="text-[10px] text-text-muted/70">{disabled.split(":")[0]}</span>
                  )}
                </>
              );
              return link ? (
                <a
                  key={a.label}
                  role="menuitem"
                  href={link.href}
                  {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  className={cls}
                  onClick={() => setOpen(false)}
                >
                  {body}
                </a>
              ) : (
                <button
                  key={a.label}
                  type="button"
                  role="menuitem"
                  disabled={!!disabled}
                  title={disabled}
                  className={cls}
                  onClick={() => {
                    setOpen(false);
                    onRun(a);
                  }}
                >
                  {body}
                </button>
              );
            })}
          </div>
        </>
      )}
    </span>
  );
}
