"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import {
  DATADOG_PAYLOAD_TEMPLATE,
  TRIGGER_SECRET_HEADER,
  isSelfSecretTriggerType,
  type SelfSecretTriggerType,
} from "@optio/shared";
import { Button } from "@/components/ui/button";
import { TriggerIcon } from "@/components/brand-icon";

/**
 * The self-secret triggers: Pylon, Alertmanager (Grafana) and Datadog can't
 * sign what they send, so each of their triggers carries its own shared
 * secret — minted when the trigger is created, shown once — and listens at
 * its own URL. This file started as the Pylon dialog; the `Pylon*` names
 * stay as aliases.
 */
export type { SelfSecretTriggerType };
export { isSelfSecretTriggerType };

/** The header a delivery carries its trigger's secret in. */
export const SECRET_HEADER = TRIGGER_SECRET_HEADER;
export const PYLON_SECRET_HEADER = SECRET_HEADER;

/** Where a provider posts to for one trigger: `{origin}/api/hooks/<type>/<trigger id>`. */
export function hookUrl(type: SelfSecretTriggerType, triggerId: string, origin?: string): string {
  const base = origin ?? (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}/api/hooks/${type}/${triggerId}`;
}

export function pylonHookUrl(triggerId: string, origin?: string): string {
  return hookUrl("pylon", triggerId, origin);
}

/** What the dialog says per provider. */
export const SECRET_COPY: Record<
  SelfSecretTriggerType,
  { title: string; where: string; headerHint?: string; payloadTemplate?: string }
> = {
  pylon: {
    title: "Pylon is listening",
    where: "In Pylon → Settings → Triggers, add a webhook action with this URL and header.",
  },
  alertmanager: {
    title: "Alertmanager is listening",
    where:
      "In Alertmanager, add a webhook_config with this URL and `authorization: credentials: <secret>` (or basic auth with any user and the secret as the password). In Grafana, a Webhook contact point with the Authorization header `Bearer <secret>`.",
    headerHint: "or Authorization: Bearer <secret>",
  },
  datadog: {
    title: "Datadog is listening",
    where:
      "In Datadog → Integrations → Webhooks, add a webhook with this URL, a custom header carrying the secret, and the payload template below; then @webhook-<name> in the monitor's message.",
    payloadTemplate: DATADOG_PAYLOAD_TEMPLATE,
  },
};

/**
 * A fresh shared secret for a self-secret trigger, made here so the server
 * never has to echo one back after a regenerate: 32 random bytes, base64url.
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
 * Shown once, right after a self-secret trigger is created (or its secret
 * regenerated): the URL the provider posts to, the header, and the secret —
 * which no later read returns. Test ids are `<type>-secret-dialog`,
 * `<type>-secret-value`, `<type>-secret-done`.
 */
export function TriggerSecretDialog({
  type,
  triggerId,
  secret,
  onDone,
}: {
  type: SelfSecretTriggerType;
  triggerId: string;
  secret: string;
  onDone: () => void;
}) {
  const url = hookUrl(type, triggerId);
  const copy = SECRET_COPY[type];
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${type}-secret-title`}
      data-testid={`${type}-secret-dialog`}
    >
      <div
        className="bg-bg-card border border-border rounded-lg shadow-xl w-full max-w-lg mx-4 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <TriggerIcon type={type} className="w-4 h-4 text-primary" />
          <h2 id={`${type}-secret-title`} className="text-sm font-medium">
            {copy.title}
          </h2>
        </div>
        <div className="px-4 py-4 space-y-3 text-sm">
          <p className="text-xs text-text-muted">{copy.where}</p>
          <Field label="URL" value={url} copyLabel="URL" />
          <Field
            label={copy.headerHint ? `Header (${copy.headerHint})` : "Header"}
            value={SECRET_HEADER}
            copyLabel="Header name"
          />
          <Field label="Secret" value={secret} copyLabel="Secret" testId={`${type}-secret-value`} />
          {copy.payloadTemplate && (
            <Field
              label="Payload template"
              value={copy.payloadTemplate}
              copyLabel="Payload template"
              testId={`${type}-payload-template`}
            />
          )}
          <p className="text-xs text-warning">This is the only time the secret is shown.</p>
        </div>
        <div className="flex justify-end px-4 py-3 border-t border-border">
          <Button onClick={onDone} data-testid={`${type}-secret-done`}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The Pylon dialog, as it was: `TriggerSecretDialog` with `type="pylon"`. */
export function PylonSecretDialog(props: {
  triggerId: string;
  secret: string;
  onDone: () => void;
}) {
  return <TriggerSecretDialog type="pylon" {...props} />;
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
