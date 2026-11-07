"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, MessageSquare, Send } from "lucide-react";
import { CHAT_SERVICES, detectChatFormat } from "@optio/shared";
import { notifyApi, type ChatHookFormat, type ChatHookView } from "@/lib/notify-api";
import { SectionCard } from "@/components/ui/section-card";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  BTN_TEXT,
  CardFooter,
  Field,
  INPUT,
  Tag,
} from "../settings/settings-ui";

/**
 * Settings → Notifications → Your chat hook (docs/notifications.md): an
 * incoming webhook of any chat service, into the person's own channel. What
 * reaches it is chosen per event in "What reaches you" (its Chat column).
 * The URL is a credential: once saved, only a hint of it comes back. No chat
 * is chosen until the person picks one or pastes a URL only one service
 * uses, which picks its chat.
 */

const WHERE: Record<ChatHookFormat, { where: string; example: string }> = {
  discord: {
    where:
      "Server Settings → Integrations → Webhooks → New Webhook, pick the channel, Copy Webhook URL",
    example: "https://discord.com/api/webhooks/…",
  },
  googlechat: {
    where: "The arrow by the space's name → Apps & integrations → Add webhooks, then ⋮ → Copy link",
    example: "https://chat.googleapis.com/v1/spaces/…/messages?key=…",
  },
  mattermost: {
    where: "Integrations → Incoming Webhooks → Add, then pick your own channel or a direct message",
    example: "https://chat.example.com/hooks/…",
  },
  msteams: {
    where: 'A channel\'s Workflows → "Post to a channel when a webhook request is received"',
    example: "https://….webhook.office.com/… or a Workflows URL",
  },
  rocketchat: {
    where: "Manage → Workspace → Integrations → Incoming → New, with the channel to post to",
    example: "https://chat.example.com/hooks/…/…",
  },
  slack: {
    where: "A Slack app's Incoming Webhooks → Add New Webhook, then pick the channel",
    example: "https://hooks.slack.com/services/…",
  },
  webex: {
    where: "The Incoming Webhooks app on Webex App Hub → Connect, then name it and pick your space",
    example: "https://webexapis.com/v1/webhooks/incoming/…",
  },
  zulip: {
    where:
      "Personal settings → Bots → a bot of type Incoming webhook → its link icon → “Slack-compatible webhook” → Copy URL",
    example: "https://zulip.example.com/api/v1/external/slack_incoming?api_key=…",
  },
};

/** The chat services, alphabetically by name, with where to make a hook in each. */
export const CHAT_FORMATS: Array<{
  value: ChatHookFormat;
  label: string;
  where: string;
  example: string;
}> = CHAT_SERVICES.map((s) => ({ value: s.format, label: s.label, ...WHERE[s.format] }));

/** A chat service's format, or "" while none is chosen. */
export type ChatChoice = ChatHookFormat | "";

/** The chat a pasted URL can only be, else the one chosen (if any). */
export function formatForUrl(url: string, chosen: ChatChoice): ChatChoice {
  return detectChatFormat(url) ?? chosen;
}

/**
 * The format to send: left out while none is chosen, so the API goes by the
 * URL, else the saved hook's, else asks for one.
 */
export const formatField = (format: ChatChoice): { format?: ChatHookFormat } =>
  format ? { format } : {};

/** Under the URL while no chat is chosen. */
const NO_CHAT_HELP =
  "Choose the chat to see where its incoming webhooks are made; a URL only one service uses picks it.";

/** The Chat select: "Choose the chat…" while none is chosen, then each service by name. */
export function ChatSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ChatChoice;
  onChange: (format: ChatHookFormat) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as ChatHookFormat)}
      className={INPUT}
    >
      {value === "" && (
        <option value="" disabled>
          Choose the chat…
        </option>
      )}
      {CHAT_FORMATS.map((f) => (
        <option key={f.value} value={f.value}>
          {f.label}
        </option>
      ))}
    </select>
  );
}

/** Where to make the chosen chat's hook, and an example of its URL. */
export function chatHelp(format: ChatChoice): { where: string; example: string } {
  const chosen = CHAT_FORMATS.find((f) => f.value === format);
  return chosen
    ? { where: chosen.where, example: chosen.example }
    : { where: NO_CHAT_HELP, example: "The incoming webhook's URL" };
}

export function ChatTestStatus({ result }: { result: { ok: boolean; text: string } | null }) {
  if (!result) return null;
  return (
    <p role="status" className={`text-xs ${result.ok ? "text-success" : "text-error"} break-words`}>
      {result.text}
    </p>
  );
}

export function MyChatHook({
  hook,
  onChanged,
}: {
  hook: ChatHookView | null;
  onChanged: (hook: ChatHookView | null) => void;
}) {
  const [format, setFormat] = useState<ChatChoice>(hook?.format ?? "");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<null | "save" | "test" | "remove">(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    if (!hook && !url.trim()) return toast.error("Paste the hook's URL first");
    setBusy("save");
    try {
      const { hook: saved } = await notifyApi.saveMyChatHook({
        url: url.trim(),
        ...formatField(format),
      });
      setUrl("");
      onChanged(saved);
      toast.success("Chat hook saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the chat hook");
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!hook && !url.trim()) return toast.error("Paste the hook's URL first");
    setBusy("test");
    setResult(null);
    try {
      const r = await notifyApi.testMyChatHook({
        url: url.trim() || undefined,
        ...formatField(format),
      });
      setResult(
        r.ok
          ? { ok: true, text: "Sent: look for “Optio can post here” in your channel." }
          : { ok: false, text: `Not sent: ${r.error}` },
      );
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : "Test failed" });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    try {
      await notifyApi.deleteMyChatHook();
      onChanged(null);
      setResult(null);
      toast.success("Chat hook removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove the chat hook");
    } finally {
      setBusy(null);
    }
  };

  const help = chatHelp(format);

  return (
    <SectionCard
      id="my-chat-hook"
      label="Your chat hook"
      hint="An incoming webhook into your own channel"
      summary={
        hook ? (CHAT_FORMATS.find((f) => f.value === hook.format)?.label ?? "Set") : "Not set"
      }
      bodyClassName="p-4 space-y-4"
    >
      <p className="text-xs text-text-muted flex items-start gap-2">
        <MessageSquare className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          Optio posts what you choose under <strong className="text-text">What reaches you</strong>{" "}
          (its Chat column) to an incoming webhook of your own. Only you and the people in that
          channel see it.
        </span>
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-[12rem_minmax(0,1fr)] gap-3">
        <Field label="Chat">
          <ChatSelect label="Chat" value={format} onChange={setFormat} />
        </Field>
        <Field
          label="Webhook URL"
          help={
            hook ? "Saved. Paste a new one to replace it, or leave empty to keep it." : help.where
          }
        >
          <input
            aria-label="Webhook URL"
            value={url}
            autoComplete="off"
            onChange={(e) => {
              setUrl(e.target.value);
              setFormat((f) => formatForUrl(e.target.value, f));
            }}
            placeholder={hook?.urlHint ?? help.example}
            className={INPUT}
          />
        </Field>
      </div>
      {hook?.lastError && (
        <p className="flex items-start gap-1.5 text-xs text-warning" data-testid="chat-hook-error">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          The last post didn&apos;t arrive: {hook.lastError}
        </p>
      )}
      <ChatTestStatus result={result} />
      <CardFooter
        note={
          hook ? (
            <Tag tone={hook.enabled ? "success" : "muted"}>{hook.enabled ? "On" : "Off"}</Tag>
          ) : (
            "Nothing is posted until you save a hook."
          )
        }
      >
        {hook && (
          <button type="button" onClick={remove} disabled={busy !== null} className={BTN_TEXT}>
            Remove
          </button>
        )}
        <button type="button" onClick={test} disabled={busy !== null} className={BTN_SECONDARY}>
          <Send className="w-3.5 h-3.5" />
          {busy === "test" ? "Sending…" : "Send test"}
        </button>
        <button type="button" onClick={save} disabled={busy !== null} className={BTN_PRIMARY}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
      </CardFooter>
    </SectionCard>
  );
}
