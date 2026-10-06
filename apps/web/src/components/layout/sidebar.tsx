"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  FolderGit2,
  Server,
  DollarSign,
  Terminal,
  Laptop,
  Plug,
  BarChart3,
  Activity,
  FileText,
  GitPullRequest,
  Inbox,
  ChevronDown,
  ArrowUpRight,
  Settings,
  X,
} from "lucide-react";
import { useCurrentUser } from "@/hooks/use-current-user";
import { UserMenu } from "./user-menu";
import { OptioMark } from "@/components/optio-mark";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { useNavStore } from "./nav-store";
import { isNavActive, type NavItem } from "./nav-items";
import { useOptioChatStore } from "@/hooks/use-optio-chat";

interface NavGroup {
  /** Section heading; null for the ungrouped top entries. Also the collapse key. */
  label: string | null;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    // One noun. Every Task, Job, automation, terminal, and agent is work
    // with a When / Where / Who / What / Then; the list filters them.
    // Reviews and the Inbox sit beside it at the top level.
    label: null,
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/work", label: "Work", icon: Terminal },
      { href: "/reviews", label: "Reviews", icon: GitPullRequest },
      { href: "/issues", label: "Inbox", icon: Inbox },
    ],
  },
  {
    label: "Library",
    items: [
      { href: "/templates", label: "Prompts", icon: FileText },
      { href: "/repos", label: "Repos", icon: FolderGit2 },
      { href: "/machines", label: "Machines", icon: Laptop },
      // Connections is every service, secret, and MCP server work can be
      // connected to; every member has private ones, so it's a Library page.
      // The deployment's own secrets live under Settings.
      { href: "/connections", label: "Connections", icon: Plug },
    ],
  },
  {
    label: "Insights",
    items: [
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
      { href: "/costs", label: "Costs", icon: DollarSign },
      { href: "/activity", label: "Activity", icon: Activity },
      { href: "/cluster", label: "Cluster", icon: Server },
    ],
  },
];

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  onClick,
}: NavItem & { active: boolean; onClick?: () => void }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex min-h-10 items-center gap-3 px-3 rounded-lg text-[13px] transition-colors duration-150",
        active
          ? "text-text-heading font-semibold sidebar-link-active"
          : "text-text-muted hover:bg-bg-hover/60 hover:text-text",
      )}
    >
      <Icon
        className={cn(
          "w-[18px] h-[18px] shrink-0 transition-colors",
          active ? "text-text-heading" : "text-text-muted group-hover:text-text",
        )}
      />
      {label}
    </Link>
  );
}

function GroupHeader({
  label,
  open,
  pinnedOpen,
  onToggle,
}: {
  label: string;
  open: boolean;
  /** The active page lives here, so the group can't be collapsed away. */
  pinnedOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={`sidebar-${label.toLowerCase()}`}
      aria-disabled={pinnedOpen}
      title={pinnedOpen ? "This section stays open while you’re using it" : undefined}
      className={cn(
        "w-full flex items-center justify-between px-3 py-2 rounded-md",
        "text-[11px] font-medium tracking-wide transition-colors",
        "text-text-muted hover:text-text",
        pinnedOpen && "cursor-default",
      )}
    >
      {label}
      <ChevronDown
        className={cn(
          "w-3 h-3 transition-transform duration-150",
          !open && "-rotate-90",
          pinnedOpen && "opacity-40",
        )}
      />
    </button>
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

export function Sidebar({ open, onClose }: { open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const sidebarRef = useRef<HTMLElement>(null);
  const { isAdmin, isDeploymentAdmin } = useCurrentUser();
  const optioChat = useOptioChatStore();
  const collapsed = useNavStore((s) => s.collapsed);

  useEffect(() => {
    useNavStore.getState().hydrate();
  }, []);

  useEffect(() => {
    if (!open || !window.matchMedia("(max-width: 767px)").matches) return;
    const previous = document.activeElement as HTMLElement | null;
    const sidebar = sidebarRef.current;
    sidebar?.querySelector<HTMLButtonElement>('[aria-label="Close menu"]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (!window.matchMedia("(max-width: 767px)").matches) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose?.();
      }
      if (event.key !== "Tab" || !sidebar) return;
      const targets = [
        ...sidebar.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input, [tabindex="0"]',
        ),
      ].filter((element) => element.getClientRects().length > 0);
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [open, onClose]);

  return (
    <aside
      ref={sidebarRef}
      aria-label="Sidebar"
      className={cn(
        "w-60 shrink-0 border-r border-border/60 bg-bg-subtle flex flex-col",
        "fixed inset-y-0 left-0 z-30 transition-transform duration-200 md:static md:translate-x-0",
        open ? "visible translate-x-0" : "invisible -translate-x-full md:visible",
      )}
    >
      <div className="flex shrink-0 items-center justify-between px-5 py-5">
        <Link href="/" onClick={onClose} className="flex items-center gap-2.5 group">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-primary text-white shadow-sm">
            <OptioMark className="w-[18px] h-[18px]" />
          </span>
          <span className="font-semibold text-lg tracking-tight text-text-heading">Optio</span>
        </Link>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close menu"
          className="md:hidden grid h-9 w-9 place-items-center rounded-lg text-text-muted hover:bg-bg-hover"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="px-3 pb-3 empty:hidden">
        <WorkspaceSwitcher />
      </div>
      <nav aria-label="Main navigation" className="flex-1 min-h-0 px-3 pb-4 overflow-y-auto">
        {NAV_GROUPS.map((group, idx) => {
          const containsActive = group.items.some((item) => isNavActive(pathname, item.href));
          const isOpen = group.label === null || containsActive || !collapsed.includes(group.label);
          return (
            <div key={group.label ?? `group-${idx}`} className={idx > 0 ? "mt-5" : ""}>
              {group.label && (
                <GroupHeader
                  label={group.label}
                  open={isOpen}
                  pinnedOpen={containsActive}
                  onToggle={() => {
                    if (!containsActive) useNavStore.getState().toggle(group.label!);
                  }}
                />
              )}
              {isOpen && (
                <div
                  id={group.label ? `sidebar-${group.label.toLowerCase()}` : undefined}
                  className="space-y-1"
                >
                  {group.items.map((item) => (
                    <NavLink
                      key={item.href}
                      {...item}
                      active={isNavActive(pathname, item.href)}
                      onClick={onClose}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <div className="shrink-0 border-t border-border/60 p-3 space-y-2">
        {(isAdmin || isDeploymentAdmin) && (
          <NavLink
            href="/settings"
            label="Settings"
            icon={Settings}
            active={isNavActive(pathname, "/settings")}
            onClick={onClose}
          />
        )}
        <button
          type="button"
          aria-expanded={optioChat.isOpen}
          onClick={() => {
            optioChat.toggle();
            onClose?.();
          }}
          className={cn(
            "group w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-colors",
            optioChat.isOpen
              ? "border-primary/40 bg-primary/10"
              : "border-border/70 bg-bg-card/60 hover:border-border-strong hover:bg-bg-card",
          )}
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-text">
            <OptioMark className="w-4 h-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-text-heading">Ask Optio</span>
            <span className="mt-1 flex items-center gap-1.5 text-[10px] text-text-muted">
              <span
                aria-hidden
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  STATUS_DOT_COLORS[optioChat.status],
                )}
              />
              {STATUS_LABELS[optioChat.status]}
            </span>
          </span>
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-text-muted group-hover:text-text" />
        </button>
        <UserMenu onNavigate={onClose} hideSettings />
      </div>
    </aside>
  );
}
