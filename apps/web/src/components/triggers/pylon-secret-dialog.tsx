"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TriggerIcon } from "@/components/brand-icon";

/** The header a Pylon delivery carries its trigger's secret in. */
export const PYLON_SECRET_HEADER = "X-Optio-Secret";

/** Where Pylon posts to for one trigger: `{origin}/api/hooks/pylon/<trigger id>`. */
export function pylonHookUrl(triggerId: string, origin?: string): string {
  const base = origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/api/hooks/pylon/${triggerId}`;
}

/**
 * A fresh shared secret for a Pylon trigger, made here so the server never
 * has to echo one back after a regenerate: 32 random bytes, base64url.
 */
export function newTriggerSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success(`${label} copied`);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Couldn't copy");
        }
      }}
      className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-text transition-colors shrink-0"
      title={`Copy ${label.toLowerCase()}`}
      aria-label={`Copy ${label.toLowerCase()}`}
    >
      {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

/**
 * Shown once, right after a Pylon trigger is created (or its secret
 * regenerated): the URL Pylon posts to, the header, and the secret — which no
 * later read returns.
 */
export function PylonSecretDialog({
  triggerId,
  secret,
  onDone,
}: {
  triggerId: string;
  secret: string;
  onDone: () => void;
}) {
  const url = pylonHookUrl(triggerId);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pylon-secret-title"
      data-testid="pylon-secret-dialog"
    >
      <div
        className="bg-bg-card border border-border rounded-lg shadow-xl w-full max-w-lg mx-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <TriggerIcon type="pylon" className="w-4 h-4 text-primary" />
          <h2 id="pylon-secret-title" className="text-sm font-medium">
            Pylon is listening
          </h2>
        </div>
        <div className="px-4 py-4 space-y-3 text-sm">
          <p className="text-xs text-text-muted">
            In Pylon → Settings → Triggers, add a webhook action with this URL and header.
          </p>
          <Field label="URL" value={url} copyLabel="URL" />
          <Field label="Header" value={PYLON_SECRET_HEADER} copyLabel="Header name" />
          <Field label="Secret" value={secret} copyLabel="Secret" testId="pylon-secret-value" />
          <p className="text-xs text-warning">This is the only time the secret is shown.</p>
        </div>
        <div className="flex justify-end px-4 py-3 border-t border-border">
          <Button onClick={onDone} data-testid="pylon-secret-done">
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  copyLabel,
  testId,
}: {
  label: string;
  value: string;
  copyLabel: string;
  testId?: string;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-text-muted/70 mb-1">{label}</div>
      <div className="flex items-center gap-1.5">
        <code
          className="flex-1 min-w-0 text-xs font-mono bg-bg border border-border rounded px-2 py-1.5 break-all"
          data-testid={testId}
        >
          {value}
        </code>
        <CopyButton value={value} label={copyLabel} />
      </div>
    </div>
  );
}
