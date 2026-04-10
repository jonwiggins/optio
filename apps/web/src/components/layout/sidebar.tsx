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
  Bot,
  Workflow,
} from "lucide-react";
import { UserMenu } from "./user-menu";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { useOptioChatStore } from "@/hooks/use-optio-chat";

const MAIN_NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
  { href: "/sessions", label: "Sessions", icon: Terminal },
  { href: "/repos", label: "Repos", icon: FolderGit2 },
  { href: "/cluster", label: "Cluster", icon: Server },
  { href: "/costs", label: "Costs", icon: DollarSign },
  { href: "/schedules", label: "Schedules", icon: Clock },
  { href: "/workflows", label: "Workflows", icon: Workflow },
  { href: "/templates", label: "Templates", icon: FileText },
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
  onClick,
}: {
  href: string;
  label: string;
  icon: any;
  active: boolean;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
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

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");

  return (
    <aside
      className={cn(
        "w-60 shrink-0 border-r border-border/50 glass-sidebar flex flex-col",
        "fixed inset-y-0 left-0 z-30 transition-transform duration-200 md:static md:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full",
      )}
    >
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
            <NavLink key={item.href} {...item} active={isActive(item.href)} onClick={onClose} />
          ))}
        </div>
        <div className="my-3 mx-1 gradient-divider" />
        <div className="space-y-0.5">
          {SECONDARY_NAV.map((item) => (
            <NavLink key={item.href} {...item} active={isActive(item.href)} onClick={onClose} />
          ))}
        </div>
      </nav>
      {/* Optio chat button */}
      <div className="px-2.5 py-2 border-t border-border/50">
        <button
          onClick={() => {
            optioChat.toggle();
            onClose?.();
          }}
          className={cn(
            "w-full flex items-center gap-2.5 py-2 px-2.5 rounded-lg text-[13px] font-medium transition-all duration-150",
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
      <div className="border-t border-border/50 px-2.5 py-2.5">
        <UserMenu />
      </div>
      <div className="px-4 py-1.5 text-[10px] text-text-muted/30 tracking-wider">Optio v0.1.0</div>
    </aside>
  );
}
