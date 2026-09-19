import { Building2, KeyRound, Settings, Webhook, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Rarely-visited admin destinations live in the user menu rather than the
 * main nav so the nav fits above the fold on a laptop.
 */
export const ADMIN_ITEMS: NavItem[] = [
  { href: "/secrets", label: "Secrets", icon: KeyRound },
  { href: "/webhooks", label: "Webhooks", icon: Webhook },
  { href: "/workspace-settings", label: "Workspace", icon: Building2 },
  { href: "/settings", label: "Settings", icon: Settings },
];

/** Pages that no longer have their own nav entry: they're all sessions now. */
const SESSION_ROUTES = ["/tasks", "/jobs", "/agents", "/local"];

export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (pathname === href || pathname.startsWith(href + "/")) return true;
  return (
    href === "/sessions" &&
    SESSION_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"))
  );
}
