"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Send } from "lucide-react";
import { notifyApi, type TeamChannelView } from "@/lib/notify-api";
import { SectionCard } from "@/components/ui/section-card";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  BTN_TEXT,
  CardFooter,
  Field,
  INPUT,
  Tag,
} from "@/components/settings/settings-ui";
import {
  ChatSelect,
  ChatTestStatus,
  chatHelp,
  formatField,
  formatForUrl,
  type ChatChoice,
} from "@/components/notifications/my-chat-hook";

/**
 * Teams → a team → Team channel (docs/notifications.md "A team's channel"):
 * a chat service's incoming webhook the team's admins (or a workspace
 * admin) set. It hears about the team's own work — the events ticked here —
 * and never a person's or another team's. Shown to those who may change it.
 */
export function TeamChatChannel({ teamId }: { teamId: string }) {
  const [view, setView] = useState<TeamChannelView | null>(null);
  const [format, setFormat] = useState<ChatChoice>("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState<null | "save" | "test" | "remove">(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const adopt = (v: TeamChannelView) => {
    setView(v);
    setFormat(v.channel?.format ?? "");
    setEvents(v.channel?.events ?? v.kinds.filter((k) => k.byDefault).map((k) => k.kind));
    setEnabled(v.channel?.enabled ?? true);
  };

  useEffect(() => {
    notifyApi
      .getTeamChannel(teamId)
      .then(adopt)
      .catch(() => setView(null));
  }, [teamId]);

  if (!view) return null;
  const channel = view.channel;

  const save = async () => {
    if (!channel && !url.trim()) return toast.error("Paste the channel's webhook URL first");
    setBusy("save");
    try {
      adopt(
        await notifyApi.saveTeamChannel(teamId, {
          url: url.trim(),
          ...formatField(format),
          events,
          enabled,
        }),
      );
      setUrl("");
      toast.success("Team channel saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the team channel");
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!channel && !url.trim()) return toast.error("Paste the channel's webhook URL first");
    setBusy("test");
    setResult(null);
    try {
      const r = await notifyApi.testTeamChannel(teamId, {
        url: url.trim() || undefined,
        ...formatField(format),
      });
      setResult(
        r.ok
          ? { ok: true, text: "Sent: look for “Optio can post here” in the channel." }
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
      await notifyApi.deleteTeamChannel(teamId);
      adopt({ ...view, channel: null });
      setResult(null);
      toast.success("Team channel removed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove the team channel");
    } finally {
      setBusy(null);
    }
  };

  const help = chatHelp(format);

  const toggle = (kind: string, on: boolean) =>
    setEvents((cur) => (on ? [...new Set([...cur, kind])] : cur.filter((k) => k !== kind)));

  return (
    <SectionCard
      id="team-channel"
      label="Team channel"
      hint="The team's work, in its own chat channel"
      summary={channel ? (channel.enabled ? "On" : "Off") : "Not set"}
      bodyClassName="p-4 space-y-4"
    >
      <p className="text-xs text-text-muted">
        Optio posts the events you tick about the team&apos;s own work — never a person&apos;s own
        work or another team&apos;s. Everyone in that channel sees them.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-[12rem_minmax(0,1fr)] gap-3">
        <Field label="Chat">
          <ChatSelect label="Team chat" value={format} onChange={setFormat} />
        </Field>
        <Field
          label="Webhook URL"
          help={
            channel
              ? "Saved. Paste a new one to replace it, or leave empty to keep it."
              : help.where
          }
        >
          <input
            aria-label="Team webhook URL"
            value={url}
            autoComplete="off"
            onChange={(e) => {
              setUrl(e.target.value);
              setFormat((f) => formatForUrl(e.target.value, f));
            }}
            placeholder={channel?.urlHint ?? help.example}
            className={INPUT}
          />
        </Field>
      </div>
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium text-text-muted mb-1.5">Post</legend>
        {view.kinds.map((k) => (
          <label key={k.kind} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={events.includes(k.kind)}
              onChange={(e) => toggle(k.kind, e.target.checked)}
            />
            <span>
              {k.label}
              <span className="block text-xs text-text-muted">{k.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Post to the channel
      </label>
      {channel?.lastError && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
          The last post didn&apos;t arrive: {channel.lastError}
        </p>
      )}
      <ChatTestStatus result={result} />
      <CardFooter
        note={
          channel ? (
            <Tag tone={channel.enabled ? "success" : "muted"}>
              {channel.enabled ? "Posting" : "Off"}
            </Tag>
          ) : (
            "Nothing is posted until you save a channel."
          )
        }
      >
        {channel && (
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
