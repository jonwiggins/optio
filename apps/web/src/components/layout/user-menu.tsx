"use client";

import { useState, useEffect, useRef, useId, type ReactNode } from "react";
import { api } from "@/lib/api-client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, User, ChevronUp, ChevronRight, Sun, Moon, Monitor } from "lucide-react";
import { useCurrentUser } from "@/hooks/use-current-user";
import { ADMIN_ITEMS, isNavActive } from "./nav-items";
import { HelpMenu } from "./help-menu";
import { useTheme, type Theme } from "./theme-provider";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export function UserMenu({
  onNavigate,
  children,
}: { onNavigate?: () => void; children?: ReactNode } = {}) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();
  const { user, authDisabled, isAdmin, isDeploymentAdmin } = useCurrentUser();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      // best-effort
    }
    window.location.href = "/login";
  };

  // Render even before the user fetch resolves (or if it fails): the menu
  // holds the theme switch and sign-out, so it must never disappear.
  const displayName = user?.displayName ?? "Account";
  const email = user?.email ?? "";

  return (
    <div
      ref={menuRef}
      className="relative"
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
        aria-label="Account menu"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-left transition-colors focus-visible:outline-2 focus-visible:outline-primary",
          open ? "bg-bg-hover text-text-heading" : "hover:bg-bg-hover",
        )}
      >
        {user?.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="w-7 h-7 rounded-full shrink-0" />
        ) : (
          <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
            <User className="w-3.5 h-3.5 text-primary" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate">{displayName}</p>
          {email && <p className="text-[10px] text-text-muted truncate">{email}</p>}
        </div>
        <ChevronUp
          className={`w-3.5 h-3.5 text-text-muted transition-transform ${open ? "" : "rotate-180"}`}
        />
      </button>

      {open && (
        <div
          id={menuId}
          role="region"
          aria-label="Account settings"
          className="absolute z-[60] bottom-full left-0 mb-2 w-72 max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-5rem)] overflow-y-auto overscroll-contain rounded-xl border border-border bg-bg-card shadow-xl"
        >
          <div className="flex items-center gap-3 border-b border-border bg-bg-subtle/70 px-4 py-3">
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-xl" />
            ) : (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <User className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-text-heading">{displayName}</p>
              <p className="truncate text-xs text-text-muted">{email || "Account preferences"}</p>
            </div>
          </div>

          <div className="space-y-2.5 border-b border-border p-3">
            <div className="flex items-center justify-between gap-2 px-1">
              <span className="text-xs font-medium text-text-muted">Appearance</span>
              {authDisabled && (
                <span
                  title="Authentication is disabled"
                  className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-text-muted"
                >
                  Local mode
                </span>
              )}
            </div>
            <Segmented
              aria-label="Theme"
              value={theme}
              onChange={setTheme}
              className="w-full [&>button]:flex-1 [&>button]:justify-center [&>button]:px-2"
              options={THEME_OPTIONS.map(({ value, label, icon: Icon }) => ({
                value,
                label,
                icon: <Icon className="h-3.5 w-3.5" />,
              }))}
            />
          </div>

          {/* The guide and the getting-started checklist, when an admin turns them on. */}
          <HelpMenu
            onNavigate={() => {
              setOpen(false);
              onNavigate?.();
            }}
          />

          {(isAdmin || isDeploymentAdmin) && (
            <nav aria-label="Account administration" className="space-y-1 p-2">
              {ADMIN_ITEMS.map(({ href, label, icon: Icon }) => {
                const active = isNavActive(pathname, href);
                return (
                  <Link
                    key={href}
                    href={href}
                    aria-current={active ? "page" : undefined}
                    onClick={() => {
                      setOpen(false);
                      onNavigate?.();
                    }}
                    className={cn(
                      "group flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-primary",
                      active ? "bg-primary/10 text-primary" : "text-text hover:bg-bg-hover",
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-md border",
                        active
                          ? "border-primary/20 bg-primary/5"
                          : "border-border bg-bg text-text-muted",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="flex-1">{label}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-text-muted/60" />
                  </Link>
                );
              })}
            </nav>
          )}

          {children}

          {user && !authDisabled && (
            <div className="border-t border-border p-2">
              <button
                type="button"
                onClick={handleLogout}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-muted transition-colors hover:bg-error/5 hover:text-error focus-visible:outline-2 focus-visible:outline-primary"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
