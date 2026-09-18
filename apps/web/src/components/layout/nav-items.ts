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

export function isNavActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/");
}
