"use client";

import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api-client";
import { LogOut, User, ChevronUp, Sun, Moon, Monitor } from "lucide-react";
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

export function UserMenu() {
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

  if (!user) return null;

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-3 w-full px-3 py-2.5 rounded-lg text-left hover:bg-bg-hover transition-colors"
      >
        {user.avatarUrl ? (
          <img src={user.avatarUrl} alt="" className="w-7 h-7 rounded-full shrink-0" />
        ) : (
          <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
            <User className="w-3.5 h-3.5 text-primary" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate">{user.displayName}</p>
          <p className="text-[10px] text-text-muted truncate">{user.email}</p>
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
          <div className="px-3 py-2 border-b border-border">
            <p className="text-xs font-medium">{user.displayName}</p>
            <p className="text-[10px] text-text-muted">{user.email}</p>
            {!authDisabled && (
              <p className="text-[10px] text-text-muted capitalize mt-0.5">via {user.provider}</p>
            )}
          </div>

          {/* Theme selector */}
          <div className="px-3 py-2 border-b border-border">
            <p className="text-[10px] text-text-muted mb-1.5">Theme</p>
            <div className="flex gap-1">
              {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => setTheme(value)}
                  className={cn(
                    "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors flex-1 justify-center",
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

          {!authDisabled && (
            <button
              onClick={handleLogout}
              className="flex items-center gap-2 w-full px-3 py-2 text-xs text-text-muted hover:text-text hover:bg-bg-hover transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              Sign out
            </button>
          )}
        </div>
      )}
    </div>
  );
}
