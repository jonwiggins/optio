"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, AtSign } from "lucide-react";
import {
  githubBotApi,
  gitlabBotApi,
  type BotPlatform,
  type GitLabBotView,
} from "@/lib/gitlab-bot-api";
import { SectionCard } from "@/components/ui/section-card";
import { BTN_PRIMARY, BTN_TEXT, Field, INPUT } from "./settings-ui";

/**
 * Settings → Integrations → GitLab bot / GitHub bot (docs/gitlab-bot.md).
 * Anyone sees whom to mention: on each GitLab host the organization GitLab
 * token's own user, on GitHub the GitHub App's, unless a deployment admin
 * named another. A deployment admin turns the bot on or off, names it, and
 * sets how many requests one merge (pull) request or issue may make in ten
 * minutes. A value saved here wins over the deployment's own (chart
 * `gitlab.bot.*`, `github.bot.*`); "Follow the deployment" removes it.
 */

const sourceHelp = (source: string, envText: string) =>
  source === "app" ? "Saved here" : `From the deployment (${envText})`;

export function GitLabBotSettings({ platform = "gitlab" }: { platform?: BotPlatform } = {}) {
  const github = platform === "github";
  const api = github ? githubBotApi : gitlabBotApi;
  const P = github ? "GitHub" : "GitLab";
  const [view, setView] = useState<GitLabBotView | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [name, setName] = useState("");
  const [rate, setRate] = useState(5);
  const [saving, setSaving] = useState(false);

  const load = (v: GitLabBotView) => {
    setView(v);
    setEnabled(v.enabled);
    setName(v.source.username === "app" ? (v.username ?? "") : "");
    setRate(v.rateLimit);
  };

  useEffect(() => {
    api
      .get()
      .then(load)
      .catch(() => {});
  }, [platform]);

  if (!view) return null;
  const mentionable = view.hosts.filter((h) => h.username);
  const summary = !view.enabled
    ? "Off"
    : mentionable.length
      ? `@${mentionable[0].username}`
      : view.username
        ? `@${view.username}`
        : "Unknown";

  const save = async (body: Parameters<typeof api.update>[0]) => {
    setSaving(true);
    try {
      load(await api.update(body));
      toast.success("Saved");
    } catch (err) {
      toast.error("Couldn't save", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const changed = {
    ...(enabled !== view.enabled ? { enabled } : {}),
    ...(name.trim() && name.trim().replace(/^@/, "") !== (view.username ?? "")
      ? { username: name.trim() }
      : {}),
    ...(rate !== view.rateLimit ? { rateLimit: rate } : {}),
  };
  const dirty = Object.keys(changed).length > 0;

  return (
    <SectionCard
      id={`${platform}-bot`}
      label={`${P} bot`}
      hint={`@-mentions in ${P} comments`}
      summary={summary}
      bodyClassName="p-4 space-y-4"
    >
      {github ? (
        <p className="text-xs text-text-muted">
          Mention Optio&apos;s GitHub bot (the GitHub App&apos;s, or the machine user named here) in
          a comment and it works for you, as you: on an issue it starts work from the issue; on a
          pull request it opened it makes the change on it; on anyone else&apos;s it opens a pull
          request into its branch; <code>fix pipeline</code> fixes failed checks from their
          jobs&apos; logs. It answers in the conversation with a link to the run and again with the
          result. People need an Optio account (the one they sign in to with GitHub, else the email
          or username GitHub shows), write access to the repository and their gateway token.
        </p>
      ) : (
        <p className="text-xs text-text-muted">
          Mention Optio&apos;s GitLab user in a comment and it works for you, as you: on an issue it
          starts work from the issue; on a merge request it opened it makes the change on it; on
          anyone else&apos;s it opens a merge request into its branch; <code>fix pipeline</code>{" "}
          fixes a failed pipeline from its jobs&apos; logs. It answers in the thread with a link to
          the run and again with the result. People need an Optio account with the email their
          GitLab profile gives (or, when GitLab shows none, the same username), the Developer role
          on the project and their gateway token.
        </p>
      )}

      <ul className="space-y-1 text-sm" data-testid={`${platform}-bot-hosts`}>
        {view.hosts.length === 0 && (
          <li className="text-xs text-text-muted">
            No GitLab host is named yet: the bot answers on the hosts in the chart&apos;s{" "}
            <code>gitlab.hosts</code> or the setup wizard&apos;s GitLab step.
          </li>
        )}
        {view.hosts.map((h) => (
          <li key={h.host} className="flex flex-wrap items-center gap-2">
            <AtSign className="w-3.5 h-3.5 text-text-muted shrink-0" />
            {h.username ? (
              <span>
                On <span className="font-mono">{h.host}</span>, mention{" "}
                <span className="font-mono font-medium">@{h.username}</span>
              </span>
            ) : (
              <span className="inline-flex items-start gap-1.5 text-warning">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span>
                  <span className="font-mono">{h.host}</span>: Optio couldn&apos;t tell who its {P}{" "}
                  user is{h.error ? ` (${h.error})` : ""}.{" "}
                  {github
                    ? "Configure a GitHub App, or name the bot below."
                    : "Check the organization's GitLab token, or name the bot below."}
                </span>
              </span>
            )}
          </li>
        ))}
      </ul>

      {view.canEdit && (
        <div className="space-y-3 pt-3 border-t border-border/60">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field
              label="Answer mentions"
              help={sourceHelp(view.source.enabled, view.environment.enabled ? "on" : "off")}
            >
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label="Answer mentions"
                  checked={enabled}
                  disabled={saving}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                On
              </label>
            </Field>
            <Field
              label={`Bot's ${P} username`}
              help={
                view.source.username === "app"
                  ? "Saved here"
                  : view.source.username === "environment"
                    ? `From the deployment (@${view.environment.username})`
                    : github
                      ? "The GitHub App's"
                      : "The organization token's own user"
              }
            >
              <input
                aria-label={`Bot's ${P} username`}
                value={name}
                placeholder={view.username ?? mentionable[0]?.username ?? "optio-bot"}
                disabled={saving}
                onChange={(e) => setName(e.target.value)}
                className={INPUT}
              />
            </Field>
            <Field
              label={`Requests per person per MR or issue in ${view.rateWindowMinutes} min`}
              help={sourceHelp(view.source.rateLimit, String(view.environment.rateLimit))}
            >
              <input
                type="number"
                aria-label="Requests per person per merge request or issue"
                min={1}
                max={view.maxRateLimit}
                value={rate}
                disabled={saving}
                onChange={(e) => setRate(Math.max(1, Number(e.target.value) || 1))}
                className={INPUT}
              />
            </Field>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {(view.source.enabled === "app" ||
              view.source.username === "app" ||
              view.source.rateLimit === "app") && (
              <button
                type="button"
                className={BTN_TEXT}
                disabled={saving}
                onClick={() => void save({ enabled: null, username: null, rateLimit: null })}
              >
                Follow the deployment
              </button>
            )}
            {view.source.username !== "token" && (
              <button
                type="button"
                className={BTN_TEXT}
                disabled={saving}
                onClick={() => void save({ useToken: true })}
              >
                {github ? "Use the GitHub App's" : "Use the token's user"}
              </button>
            )}
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={saving || !dirty}
              onClick={() => void save(changed)}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
