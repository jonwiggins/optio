"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Keyboard, PanelLeftClose, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { OptioMark } from "@/components/optio-mark";
import { useOptioChatStore } from "@/hooks/use-optio-chat";
import { SidebarNavigation } from "./sidebar-navigation";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { UserMenu } from "./user-menu";

export function SidebarHeader({
  onNavigate,
  onCollapse,
}: {
  onNavigate?: () => void;
  onCollapse?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div className="relative shrink-0 px-3 pb-3 pt-4">
      <div className="flex items-center justify-between gap-2 px-1 pb-3">
        <div
          ref={menuRef}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          <button
            ref={triggerRef}
            type="button"
            aria-label="Optio navigation"
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => setOpen(!open)}
            className="flex items-center gap-2.5 rounded-lg text-text-heading"
          >
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-primary text-white shadow-sm">
              <OptioMark className="h-[18px] w-[18px]" />
            </span>
            <span className="text-lg font-semibold tracking-tight">Optio</span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 text-text-muted transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
          {open && (
            <div
              id={menuId}
              className="absolute z-[60] left-3 right-3 top-14 max-h-[calc(100dvh-5rem)] overflow-y-auto overscroll-contain rounded-xl border border-border bg-bg-card shadow-xl"
            >
              <SidebarNavigation
                compact
                onNavigate={() => {
                  setOpen(false);
                  onNavigate?.();
                }}
              />
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {onCollapse && (
            <button
              type="button"
              aria-label="Hide sessions"
              title="Hide sessions (⌃⇧B)"
              onClick={onCollapse}
              className="hidden h-8 w-8 place-items-center rounded-lg text-text-muted hover:bg-bg-hover hover:text-text md:grid"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onNavigate}
            aria-label="Close menu"
            className="grid h-9 w-9 place-items-center rounded-lg text-text-muted hover:bg-bg-hover md:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <WorkspaceSwitcher returnToWork={!!onCollapse} />
    </div>
  );
}

const STATUS_LABELS: Record<string, string> = {
  ready: "Ready to help",
  starting: "Starting up…",
  unavailable: "Currently unavailable",
  thinking: "Working on your request…",
  disconnected: "Not connected",
};

const STATUS_DOT_COLORS: Record<string, string> = {
  ready: "bg-success",
  starting: "bg-warning",
  unavailable: "bg-error",
  thinking: "bg-primary animate-pulse",
  disconnected: "bg-text-muted/40",
};

export function SidebarFooter({
  onNavigate,
  sessionKind,
}: {
  onNavigate?: () => void;
  sessionKind?: "local" | "pod";
}) {
  const optioChat = useOptioChatStore();
  return (
    <div className="relative shrink-0 border-t border-border/60 p-3">
      <button
        type="button"
        aria-expanded={optioChat.isOpen}
        data-optio-agent-launcher
        title={`Optio Agent — ${STATUS_LABELS[optioChat.status]}`}
        onClick={() => {
          optioChat.toggle();
          onNavigate?.();
        }}
        className={cn(
          "flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-xs transition-colors",
          optioChat.isOpen ? "bg-primary/10 text-text-heading" : "text-text hover:bg-bg-hover/60",
        )}
      >
        <OptioMark className="h-4 w-4 text-primary" />
        <span className="flex-1">Optio Agent</span>
        <span
          aria-hidden
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT_COLORS[optioChat.status])}
        />
        <span className="sr-only">{STATUS_LABELS[optioChat.status]}</span>
      </button>
      <UserMenu onNavigate={onNavigate}>
        {sessionKind && <SessionShortcuts kind={sessionKind} />}
      </UserMenu>
    </div>
  );
}

function SessionShortcuts({ kind }: { kind: "local" | "pod" }) {
  return (
    <details className="group/shortcuts border-b border-border px-3 py-2.5 text-[10px] text-text-muted">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded text-xs hover:text-text [&::-webkit-details-marker]:hidden">
        <Keyboard className="h-3.5 w-3.5" />
        Keyboard shortcuts
        <ChevronDown className="ml-auto h-3 w-3 transition-transform group-open/shortcuts:rotate-180" />
      </summary>
      <div className="mt-3 space-y-2">
        {kind === "local" && (
          <>
            <div className="flex justify-between gap-2">
              <span>Switch session</span>
              <kbd>⌃⇧↑↓</kbd>
            </div>
            <div className="flex justify-between gap-2">
              <span>Next needs you</span>
              <kbd>⌃⇧↵</kbd>
            </div>
            <div className="flex justify-between gap-2">
              <span>Open side by side</span>
              <kbd>⇧click</kbd>
            </div>
          </>
        )}
        <div className="flex justify-between gap-2">
          <span>Hide sessions</span>
          <kbd>⌃⇧B</kbd>
        </div>
      </div>
    </details>
  );
}
