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
  Zap,
  DollarSign,
  Terminal,
  Clock,
  FileText,
} from "lucide-react";
import { UserMenu } from "./user-menu";

const MAIN_NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/tasks", label: "Tasks", icon: ListTodo },
  { href: "/sessions", label: "Sessions", icon: Terminal },
  { href: "/repos", label: "Repos", icon: FolderGit2 },
  { href: "/cluster", label: "Cluster", icon: Server },
  { href: "/costs", label: "Costs", icon: DollarSign },
  { href: "/schedules", label: "Schedules", icon: Clock },
  { href: "/templates", label: "Templates", icon: FileText },
];

const SECONDARY_NAV = [
  { href: "/secrets", label: "Secrets", icon: KeyRound },
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
        "flex items-center gap-3 py-2.5 px-3 rounded-lg text-[13px] font-medium transition-colors",
        active
          ? "bg-primary/10 text-text border-l-2 border-primary -ml-px"
          : "text-text-muted hover:bg-bg-hover hover:text-text",
      )}
    >
      <Icon className="w-4 h-4 shrink-0" />
      {label}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");

  return (
    <aside className="w-60 shrink-0 border-r border-border bg-bg flex flex-col">
      <div className="px-5 py-5 border-b border-border">
        <Link href="/" className="flex items-center gap-2.5 text-primary">
          <Zap className="w-5 h-5" />
          <div>
            <span className="font-semibold text-lg tracking-tight">Optio</span>
            <span className="block text-[10px] text-text-muted font-normal tracking-wide">
              Agent Orchestration
            </span>
          </div>
        </Link>
      </div>
      <nav className="flex-1 px-3 py-4">
        <div className="space-y-1">
          {MAIN_NAV.map((item) => (
            <NavLink key={item.href} {...item} active={isActive(item.href)} />
          ))}
        </div>
        <div className="my-4 mx-3 border-t border-border" />
        <div className="space-y-1">
          {SECONDARY_NAV.map((item) => (
            <NavLink key={item.href} {...item} active={isActive(item.href)} />
          ))}
        </div>
      </nav>
      <div className="border-t border-border px-3 py-3">
        <UserMenu />
      </div>
      <div className="px-5 py-2 text-[11px] text-text-muted/50">Optio v0.1.0</div>
    </aside>
  );
}
