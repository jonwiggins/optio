"use client";

import { useEffect, useId } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
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
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useNavStore } from "./nav-store";
import { useDeploymentSwitches } from "@/hooks/use-deployment-switches";
import { isNavActive, type NavItem } from "./nav-items";

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
      // Teams share what they own with their members; anyone can start or
      // ask to join one, so it's a Library page too.
      { href: "/teams", label: "Teams", icon: Users },
    ],
  },
  {
    label: "Insights",
    items: [
      { href: "/analytics", label: "Analytics", icon: BarChart3 },
      { href: "/usage", label: "Usage", icon: DollarSign },
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
  id,
  label,
  open,
  pinnedOpen,
  onToggle,
}: {
  id: string;
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
      aria-controls={id}
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

export function SidebarNavigation({
  onNavigate,
  compact = false,
}: {
  onNavigate?: () => void;
  compact?: boolean;
}) {
  const pathname = usePathname();
  const id = useId();
  const collapsed = useNavStore((s) => s.collapsed);
  // Teams is a page only while a deployment admin has teams on.
  const { teams } = useDeploymentSwitches();
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => teams || item.href !== "/teams"),
  }));
  useEffect(() => {
    useNavStore.getState().hydrate();
  }, []);
  return (
    <nav
      aria-label={compact ? "App navigation" : "Main navigation"}
      className={cn("min-h-0 overflow-y-auto", compact ? "p-2" : "flex-1 px-3 pb-4")}
    >
      {groups.map((group, idx) => {
        const containsActive = group.items.some((item) => isNavActive(pathname, item.href));
        const isOpen = group.label === null || containsActive || !collapsed.includes(group.label);
        const groupId = `${id}-${group.label}`;
        return (
          <div
            key={group.label ?? `group-${idx}`}
            className={idx > 0 ? (compact ? "mt-2" : "mt-5") : ""}
          >
            {group.label && (
              <GroupHeader
                id={groupId}
                label={group.label}
                open={isOpen}
                pinnedOpen={containsActive}
                onToggle={() => {
                  if (!containsActive) useNavStore.getState().toggle(group.label!);
                }}
              />
            )}
            {isOpen && (
              <div id={group.label ? groupId : undefined} className="space-y-1">
                {group.items.map((item) => (
                  <NavLink
                    key={item.href}
                    {...item}
                    active={isNavActive(pathname, item.href)}
                    onClick={onNavigate}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}
