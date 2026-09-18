"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  ListTodo,
  FolderGit2,
  Server,
  Zap,
  DollarSign,
  Terminal,
  Laptop,
  Bot,
  Plug,
  BarChart3,
  Activity,
  FileText,
  GitPullRequest,
  Calendar,
  CircleDot,
  ChevronDown,
} from "lucide-react";
import { UserMenu } from "./user-menu";
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
    label: null,
    items: [{ href: "/", label: "Overview", icon: LayoutDashboard }],
  },
  {
    label: "Run",
    items: [
      { href: "/tasks", label: "Tasks", icon: ListTodo },
      { href: "/jobs", label: "Jobs", icon: Zap },
      { href: "/reviews", label: "Reviews", icon: GitPullRequest },
      { href: "/issues", label: "Issues", icon: CircleDot },
      { href: "/tasks/scheduled", label: "Scheduled", icon: Calendar },
    ],
  },
  {
    label: "Live",
    items: [
      { href: "/agents", label: "Agents", icon: Bot },
      { href: "/sessions", label: "Sessions", icon: Terminal },
      { href: "/local", label: "Local", icon: Laptop },
    ],
  },
  {
    label: "Library",
    items: [
      { href: "/templates", label: "Prompts", icon: FileText },
      { href: "/repos", label: "Repos", icon: FolderGit2 },
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
        "flex items-center gap-2.5 py-1.5 px-2.5 rounded-lg text-[13px] font-medium transition-all duration-150",
        active
          ? "text-text-heading nav-active"
          : "text-text-muted hover:bg-bg-hover/60 hover:text-text",
      )}
    >
      <Icon className={cn("w-4 h-4 shrink-0", active && "text-primary")} />
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
      className={cn(
        "w-full flex items-center justify-between px-2.5 py-1 rounded-md",
        "text-[10px] font-semibold tracking-widest uppercase transition-colors",
        "text-text-muted/60 hover:text-text-muted",
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

const STATUS_DOT_COLORS: Record<string, string> = {
  ready: "bg-success",
  starting: "bg-warning",
  unavailable: "bg-error",
  thinking: "bg-primary animate-pulse",
  disconnected: "bg-text-muted/40",
};

export function Sidebar({ open, onClose }: { open?: boolean; onClose?: () => void }) {
  const pathname = usePathname();
  const optioChat = useOptioChatStore();
  const collapsed = useNavStore((s) => s.collapsed);

  useEffect(() => {
    useNavStore.getState().hydrate();
  }, []);

  return (
    <aside
      className={cn(
        "w-60 shrink-0 border-r border-border/50 glass-sidebar flex flex-col",
        "fixed inset-y-0 left-0 z-30 transition-transform duration-200 md:static md:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full",
      )}
    >
      <div className="px-4 py-3 border-b border-border/50 animated-gradient">
        <Link href="/" className="flex items-center gap-2.5 text-primary group">
          <div className="w-7 h-7 rounded-lg bg-primary/15 flex items-center justify-center group-hover:bg-primary/25 transition-all duration-300 shadow-sm shadow-primary/10">
            <Zap className="w-4 h-4" />
          </div>
          <span className="font-semibold text-base tracking-tight text-text">Optio</span>
        </Link>
      </div>
      <div className="px-2.5 py-1.5 border-b border-border">
        <WorkspaceSwitcher />
      </div>
      <nav className="flex-1 px-2.5 py-2 overflow-y-auto">
        {NAV_GROUPS.map((group, idx) => {
          const containsActive = group.items.some((item) => isNavActive(pathname, item.href));
          const isOpen = group.label === null || containsActive || !collapsed.includes(group.label);
          return (
            <div key={group.label ?? `group-${idx}`} className={idx > 0 ? "mt-2.5" : ""}>
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
                <div className="space-y-0.5">
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
      {/* Optio chat button */}
      <div className="px-2.5 py-1.5 border-t border-border/50">
        <button
          onClick={() => {
            optioChat.toggle();
            onClose?.();
          }}
          className={cn(
            "w-full flex items-center gap-2.5 py-1.5 px-2.5 rounded-lg text-[13px] font-medium transition-all duration-150",
            optioChat.isOpen
              ? "bg-primary/10 text-text"
              : "text-text-muted hover:bg-bg-hover/60 hover:text-text",
          )}
        >
          <div className="relative">
            <Bot className={cn("w-4 h-4 shrink-0", optioChat.isOpen && "text-primary")} />
            <span
              className={cn(
                "absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full border border-bg",
                STATUS_DOT_COLORS[optioChat.status] ?? "bg-text-muted/40",
              )}
            />
          </div>
          Ask Optio
        </button>
      </div>
      <div className="border-t border-border/50 px-2.5 py-1.5">
        <UserMenu onNavigate={onClose} />
      </div>
    </aside>
  );
}
