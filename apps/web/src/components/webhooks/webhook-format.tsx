"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CHAT_SERVICES, chatFormatLabel, detectChatFormat, type ChatFormat } from "@optio/shared";
import { api } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import { inputClass } from "@/components/ui/input";

/**
 * How an outbound webhook's body is shaped (docs/notifications.md "Chat
 * services"; the API renders it in services/notify/chat-formats.ts). The
 * empty choice goes by the URL: Slack blocks for a hooks.slack.com URL, a
 * chat service's own body for a URL only that service uses, Optio's JSON
 * otherwise. The chat services are listed alphabetically.
 */
const CHAT_HINTS: Record<ChatFormat, string> = {
  discord: "An embed, for a Discord channel's webhook.",
  googlechat: "A card, for a Google Chat space's incoming webhook.",
  mattermost: "A Markdown message for a Mattermost incoming webhook.",
  msteams: "An Adaptive Card, for a Teams incoming webhook or a Workflows webhook trigger.",
  rocketchat: "A message with attachments, for a Rocket.Chat incoming webhook.",
  slack: "Slack blocks, for a Slack-compatible incoming webhook.",
  webex: "A Markdown message, for a Webex incoming webhook.",
  zulip: "A Markdown message, for Zulip's Slack-compatible incoming webhook.",
};

export const WEBHOOK_FORMATS: Array<{ value: string; label: string; hint: string }> = [
  {
    value: "",
    label: "By the URL",
    hint: "Slack blocks for a hooks.slack.com URL, a chat service's own body for a URL only it uses, Optio's JSON for anything else.",
  },
  {
    value: "generic",
    label: "Optio JSON",
    hint: "{ event, timestamp, data }, for your own receiver.",
  },
  ...CHAT_SERVICES.map((s) => ({ value: s.format, label: s.label, hint: CHAT_HINTS[s.format] })),
];

export function formatLabel(format: string | null | undefined): string | null {
  if (!format) return null;
  return WEBHOOK_FORMATS.find((f) => f.value === format)?.label ?? format;
}

/** What "By the URL" sends to `url`: the chat service it can only be, if any. */
function byTheUrl(url: string | null | undefined): string | null {
  const format = detectChatFormat(url);
  return format ? `${chatFormatLabel(format)}, by this URL. ${CHAT_HINTS[format]}` : null;
}

export function WebhookFormatSelect({
  value,
  onChange,
  disabled,
  url,
}: {
  value: string | null | undefined;
  onChange: (format: string) => void;
  disabled?: boolean;
  /** The webhook's URL, to say what "By the URL" picks for it. */
  url?: string | null;
}) {
  const current = WEBHOOK_FORMATS.find((f) => f.value === (value ?? "")) ?? WEBHOOK_FORMATS[0];
  const hint = (!value && byTheUrl(url)) || current.hint;
  return (
    <div>
      <select
        aria-label="Body format"
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={inputClass()}
      >
        {WEBHOOK_FORMATS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-text-muted mt-1">{hint}</p>
    </div>
  );
}

/** The detail page's card: change an existing webhook's format. */
export function WebhookFormatCard({
  webhook,
  onChanged,
}: {
  webhook: { id: string; format?: string | null; url?: string };
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const change = async (format: string) => {
    setSaving(true);
    try {
      await api.updateWebhook(webhook.id, { format: format || null });
      toast.success("Format saved");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't change the format");
    } finally {
      setSaving(false);
    }
  };
  return (
    <SectionCard label="Body format" summary={formatLabel(webhook.format) ?? "By the URL"}>
      <WebhookFormatSelect
        value={webhook.format}
        onChange={change}
        disabled={saving}
        url={webhook.url}
      />
    </SectionCard>
  );
}
