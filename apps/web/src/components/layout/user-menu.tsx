"use client";

import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api-client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, User, ChevronUp, Sun, Moon, Monitor } from "lucide-react";
import { ADMIN_ITEMS, isNavActive } from "./nav-items";
import { useTheme, type Theme } from "./theme-provider";
import { cn } from "@/lib/utils";

interface UserInfo {
  id: string;
  provider: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export function UserMenu({ onNavigate }: { onNavigate?: () => void } = {}) {
  const pathname = usePathname();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [authDisabled, setAuthDisabled] = useState(false);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    api
      .getCurrentUser()
      .then((res) => {
        setUser(res.user);
        setAuthDisabled(res.authDisabled);
      })
      .catch(() => {});
  }, []);

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

  // Render even before the user fetch resolves (or if it fails): the menu now
  // holds the admin links, so it must never disappear.
  const displayName = user?.displayName ?? "Account";
  const email = user?.email ?? "";

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-left hover:bg-bg-hover transition-colors"
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
        <div className="absolute bottom-full left-0 right-0 mb-1 rounded-lg border border-border bg-bg-card shadow-lg overflow-hidden">
          {authDisabled && (
            <div className="px-3 py-2 text-[10px] text-amber-400 bg-amber-500/5 border-b border-border">
              Authentication is disabled
            </div>
          )}
          {user && (
            <div className="px-3 py-2 border-b border-border">
              <p className="text-xs font-medium">{user.displayName}</p>
              <p className="text-[10px] text-text-muted">{user.email}</p>
              {!authDisabled && (
                <p className="text-[10px] text-text-muted capitalize mt-0.5">via {user.provider}</p>
              )}
            </div>
          )}

          {/* Theme selector */}
          <div className="px-3 py-2 border-b border-border">
            <p className="text-[10px] text-text-muted mb-1.5">Theme</p>
            <div className="flex gap-1">
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => setTheme(value)}
                  className={cn(
                    "flex items-center gap-1 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors flex-1 justify-center whitespace-nowrap",
                    theme === value
                      ? "bg-primary/15 text-primary"
                      : "text-text-muted hover:bg-bg-hover hover:text-text",
                  )}
                >
                  <Icon className="w-3 h-3" />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Admin destinations — kept out of the main nav to save space */}
          <div className="py-1 border-b border-border">
            <p className="px-3 pt-1 pb-0.5 text-[10px] font-semibold tracking-widest uppercase text-text-muted/60">
              Admin
            </p>
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
                    "flex items-center gap-2 w-full px-3 py-1.5 text-xs transition-colors",
                    active
                      ? "text-text bg-primary/10"
                      : "text-text-muted hover:text-text hover:bg-bg-hover",
                  )}
                >
                  <Icon className={cn("w-3.5 h-3.5", active && "text-primary")} />
                  {label}
                </Link>
              );
            })}
          </div>

          {user && !authDisabled && (
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text-muted hover:text-text hover:bg-bg-hover transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign out
            </button>
          )}
          <div className="px-3 py-1.5 text-[10px] text-text-muted/40 tracking-wider">
            Optio v0.1.0
          </div>
        </div>
      )}
    </div>
  );
}
