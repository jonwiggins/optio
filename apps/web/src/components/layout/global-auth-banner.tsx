"use client";

import { useEffect, useState, useCallback } from "react";
import { AlertTriangle } from "lucide-react";
import { api } from "@/lib/api-client";
import { useIsTokenRefreshBannerMounted } from "@/components/token-refresh-banner";

/**
 * Global banner shown on all pages when the Claude OAuth token is expired.
 * Listens for auth:failed WebSocket events and periodically checks auth status
 * so the banner appears proactively — before a task is launched and fails.
 */
export function GlobalAuthBanner() {
  const [expired, setExpired] = useState(false);
  const [lastValidated, setLastValidated] = useState<string | null>(null);
  const widgetMounted = useIsTokenRefreshBannerMounted();

  const checkAuth = useCallback(async () => {
    try {
      const res = await api.getAuthStatus();
      setExpired(res.subscription.expired === true);
      setLastValidated((res.subscription as any).lastValidated ?? null);
    } catch {
      // Network error — don't show banner
    }
  }, []);

  useEffect(() => {
    // Initial check
    checkAuth();

    // Poll every 5 minutes (matches the background worker interval)
    const interval = setInterval(checkAuth, 5 * 60 * 1000);

    // Listen for auth:failed events from WebSocket to show banner immediately
    const onAuthFailed = () => {
      setExpired(true);
    };

    // Listen for token updates to dismiss banner immediately
    const onAuthStatusChanged = () => {
      checkAuth();
    };

    window.addEventListener("optio:auth-failed", onAuthFailed);
    window.addEventListener("optio:auth-status-changed", onAuthStatusChanged);

    return () => {
      clearInterval(interval);
      window.removeEventListener("optio:auth-failed", onAuthFailed);
      window.removeEventListener("optio:auth-status-changed", onAuthStatusChanged);
    };
  }, [checkAuth]);

  if (!expired || widgetMounted) return null;

  const validatedAgo = lastValidated ? formatTimeAgo(lastValidated) : null;

  return (
    <div className="shrink-0 bg-warning/10 border-b border-warning/30 px-4 py-2 flex items-center gap-2 text-sm">
      <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
      <span className="text-text-heading font-medium">Claude OAuth token expired</span>
      <span className="text-text-muted">
        — tasks will fail until updated. Run <code>claude setup-token</code> for a long-lived token,
        then replace <code>CLAUDE_CODE_OAUTH_TOKEN</code> in Deployment secrets under{" "}
        <a href="/settings#integrations" className="underline hover:text-text transition-colors">
          Settings → Integrations
        </a>
        .
      </span>
      {validatedAgo && (
        <span className="ml-auto text-xs text-text-muted/60">checked {validatedAgo}</span>
      )}
    </div>
  );
}

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
