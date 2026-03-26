"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  ListTodo,
  FolderGit2,
  Server,
  KeyRound,
  Settings,
  Building2,
  Zap,
  DollarSign,
  Terminal,
  Clock,
  FileText,
  GitBranch,
} from "lucide-react";
import { UserMenu } from "./user-menu";
import { WorkspaceSwitcher } from "./workspace-switcher";

const MAIN_NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
  { href: "/sessions", label: "Sessions", icon: Terminal },
  { href: "/repos", label: "Repos", icon: FolderGit2 },
  { href: "/cluster", label: "Cluster", icon: Server },
  { href: "/costs", label: "Costs", icon: DollarSign },
  { href: "/schedules", label: "Schedules", icon: Clock },
  { href: "/templates", label: "Templates", icon: FileText },
  { href: "/workflows", label: "Workflows", icon: GitBranch },
];

const SECONDARY_NAV = [
  { href: "/secrets", label: "Secrets", icon: KeyRound },
  { href: "/workspace-settings", label: "Workspace", icon: Building2 },
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: any;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2.5 py-2 px-2.5 rounded-lg text-[13px] font-medium transition-all duration-150",
        active
          ? "bg-primary/10 text-text nav-active-glow"
          : "text-text-muted hover:bg-bg-hover/60 hover:text-text",
      )}
    >
      <Icon className={cn("w-4 h-4 shrink-0", active && "text-primary")} />
      {label}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");

  return (
    <aside className="w-60 shrink-0 border-r border-border/50 glass-sidebar flex flex-col">
      <div className="px-4 py-4 border-b border-border/50 animated-gradient">
        <Link href="/" className="flex items-center gap-2.5 text-primary group">
          <div className="w-8 h-8 rounded-lg bg-primary/15 flex items-center justify-center group-hover:bg-primary/25 transition-all duration-300 shadow-sm shadow-primary/10">
            <Zap className="w-4.5 h-4.5" />
          </div>
          <div>
            <span className="font-semibold text-base tracking-tight text-text">Optio</span>
            <span className="block text-[10px] text-text-muted font-normal tracking-widest uppercase">
              Agent Orchestration
            </span>
          </div>
        </Link>
      </div>
      <div className="px-2.5 py-2 border-b border-border">
        <WorkspaceSwitcher />
      </div>
      <nav className="flex-1 px-2.5 py-3 overflow-y-auto">
        <div className="space-y-0.5">
          {MAIN_NAV.map((item) => (
            <NavLink key={item.href} {...item} active={isActive(item.href)} />
          ))}
        </div>
        <div className="my-3 mx-1 gradient-divider" />
        <div className="space-y-0.5">
          {SECONDARY_NAV.map((item) => (
            <NavLink key={item.href} {...item} active={isActive(item.href)} />
          ))}
        </div>
      </nav>
      <div className="border-t border-border/50 px-2.5 py-2.5">
        <UserMenu />
      </div>
      <div className="px-4 py-1.5 text-[10px] text-text-muted/30 tracking-wider">Optio v0.1.0</div>
    </aside>
  );
}
