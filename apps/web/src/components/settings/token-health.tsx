"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { credentialHealthApi, type CredentialCheck } from "@/lib/credential-health-api";

/**
 * Settings → My tokens → Health (docs/credential-health.md): what the last
 * check found about each token the viewer looks after (their own; for an
 * admin also the workspace's), worst first, and Check now for their own.
 * Optio checks every 15 minutes and emails before a token expires.
 */

const STATUS: Record<CredentialCheck["status"], { label: string; className: string }> = {
  ok: { label: "OK", className: "bg-success/10 text-success" },
  warning: { label: "Warning", className: "bg-warning/10 text-warning" },
  error: { label: "Not working", className: "bg-error/10 text-error" },
  unknown: { label: "Unknown", className: "bg-bg-hover text-text-muted" },
};

/** "expires 2026-11-01" for a row with an expiry. */
export function expiryText(c: Pick<CredentialCheck, "expiresAt">): string | null {
  return c.expiresAt ? `expires ${c.expiresAt.slice(0, 10)}` : null;
}

export function TokenHealth() {
  const [checks, setChecks] = useState<CredentialCheck[] | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    try {
      setChecks((await credentialHealthApi.list()).checks);
    } catch {
      setChecks([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const checkNow = async () => {
    setChecking(true);
    try {
      await credentialHealthApi.checkMine();
      await load();
    } catch (err) {
      toast.error("Couldn't check your tokens", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setChecking(false);
    }
  };

  if (!checks) return null;
  return (
    <div className="space-y-2 pt-3 border-t border-border/50" data-testid="token-health">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Health</span>
        <Button size="sm" variant="ghost" onClick={() => void checkNow()} disabled={checking}>
          {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Check now
        </Button>
      </div>
      {checks.length === 0 ? (
        <p className="text-[11px] text-text-muted">
          Nothing checked yet. Optio checks your gateway and GitLab tokens every 15 minutes and
          emails you before one expires.
        </p>
      ) : (
        <ul className="divide-y divide-border/50 text-xs">
          {checks.map((c) => (
            <li key={c.key} className="py-1.5" data-testid={`health-${c.status}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "px-1.5 py-0.5 rounded text-[10px] font-medium",
                    STATUS[c.status].className,
                  )}
                >
                  {STATUS[c.status].label}
                </span>
                <span className="font-medium">{c.label}</span>
                {c.scope === "organization" && (
                  <span className="text-text-muted">(the organization&apos;s)</span>
                )}
                {expiryText(c) && <span className="text-text-muted">{expiryText(c)}</span>}
              </div>
              {c.reason && <p className="text-[11px] text-text-muted mt-0.5">{c.reason}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
