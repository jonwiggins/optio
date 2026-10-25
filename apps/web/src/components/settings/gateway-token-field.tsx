"use client";

import { useState } from "react";
import { Check, Key, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import type { GatewayKeyInfo, GatewayTestResult } from "@/lib/api-client";

/** "Stored" / "No token yet" for a person, a team or the organization. */
export function TokenChip({ hasToken }: { hasToken: boolean }) {
  return (
    <span
      className={cn(
        "px-1.5 py-0.5 rounded text-[10px] font-medium",
        hasToken ? "bg-success/10 text-success" : "bg-warning/10 text-warning",
      )}
    >
      {hasToken ? "Stored" : "No token yet"}
    </span>
  );
}

/** "$12.40 of $100 · resets Nov 1", the gateway's budget for a token, when it reports one. */
export function keyInfoLine(info: GatewayKeyInfo | null | undefined): string | null {
  if (!info) return null;
  const spend = `$${info.spend.toFixed(2)}`;
  const budget = info.maxBudget != null ? ` of $${info.maxBudget.toFixed(2)}` : "";
  const reset = info.budgetResetAt
    ? ` · resets ${new Date(info.budgetResetAt).toLocaleDateString()}`
    : "";
  return `${spend}${budget} spent${reset}`;
}

/** What a test answered, in one line. */
export function testLine(test: Omit<GatewayTestResult, "tokenFrom"> | null): string | null {
  if (!test) return null;
  if (test.ok) return `Works — sees ${test.modelCount} model${test.modelCount === 1 ? "" : "s"}`;
  return `Stored, but the gateway refused it${test.error ? `: ${test.error}` : ""}`;
}

/**
 * A password field and Save for one gateway token: the viewer's own
 * (`PUT /api/gateway/me/token`, which also tries it), a team's or the
 * organization's (`POST /api/secrets` at that scope). `onSave` answers with
 * the test result when the route tried the token; the line under the field
 * says how it went.
 */
export function GatewayTokenField({
  label,
  placeholder = "Paste the token",
  onSave,
  onSaved,
  testId,
}: {
  label?: string;
  placeholder?: string;
  onSave: (token: string) => Promise<Omit<GatewayTestResult, "tokenFrom"> | null | void>;
  /** After a successful save (reload the status). */
  onSaved?: () => void | Promise<void>;
  testId?: string;
}) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<Omit<GatewayTestResult, "tokenFrom"> | null>(null);

  const save = async () => {
    if (!token.trim() || saving) return;
    setSaving(true);
    setResult(null);
    try {
      const test = await onSave(token.trim());
      setResult(test ?? null);
      if (!test || test.ok) toast.success("Token saved");
      else toast.warning("Token saved, but the gateway refused it", { description: test.error });
      setToken("");
      await onSaved?.();
    } catch (err) {
      toast.error("Couldn't save the token", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const line = testLine(result);
  return (
    <div data-testid={testId}>
      {label && <label className="block text-xs text-text-muted mb-1">{label}</label>}
      <div className="flex gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          placeholder={placeholder}
          autoComplete="off"
          aria-label={label ?? "Gateway token"}
          className={inputClass({ size: "sm", className: "flex-1 font-mono" })}
        />
        <Button size="sm" onClick={save} disabled={!token.trim() || saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Key />}
          Save
        </Button>
      </div>
      {line && (
        <p
          className={cn(
            "flex items-center gap-1 text-[11px] mt-1",
            result?.ok ? "text-success" : "text-warning",
          )}
          role="status"
        >
          {result?.ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
          {line}
        </p>
      )}
    </div>
  );
}
