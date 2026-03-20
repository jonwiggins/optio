"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { Loader2, Bell, RefreshCw } from "lucide-react";

function PromptTemplateEditor() {
  const [template, setTemplate] = useState("");
  const [autoMerge, setAutoMerge] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getEffectiveTemplate()
      .then((res) => {
        setTemplate(res.template);
        setAutoMerge(res.autoMerge);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.savePromptTemplate({ template, autoMerge });
      toast.success("Prompt template saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    const res = await api.getBuiltinDefault();
    setTemplate(res.template);
  };

  if (loading) {
    return (
      <div className="p-4 rounded-lg border border-border bg-bg-card text-center text-text-muted text-sm">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading...
      </div>
    );
  }

  return (
    <div className="p-4 rounded-lg border border-border bg-bg-card space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">
          Default prompt used for all repos unless overridden in repo settings.
        </p>
        <button onClick={handleReset} className="text-xs text-primary hover:underline">
          Reset to default
        </button>
      </div>
      <div className="p-3 rounded-md bg-bg border border-border">
        <p className="text-xs text-text-muted mb-2">Available template variables:</p>
        <ul className="text-xs space-y-1.5">
          <li className="flex items-start gap-2">
            <code className="text-primary shrink-0">{"{{TASK_FILE}}"}</code>
            <span className="text-text-muted">
              Path to the task markdown file written into the worktree
            </span>
          </li>
          <li className="flex items-start gap-2">
            <code className="text-primary shrink-0">{"{{BRANCH_NAME}}"}</code>
            <span className="text-text-muted">Git branch name the agent is working on</span>
          </li>
          <li className="flex items-start gap-2">
            <code className="text-primary shrink-0">{"{{TASK_ID}}"}</code>
            <span className="text-text-muted">Unique task identifier</span>
          </li>
          <li className="flex items-start gap-2">
            <code className="text-primary shrink-0">{"{{TASK_TITLE}}"}</code>
            <span className="text-text-muted">Short title of the task</span>
          </li>
          <li className="flex items-start gap-2">
            <code className="text-primary shrink-0">{"{{REPO_NAME}}"}</code>
            <span className="text-text-muted">Repository name (e.g. owner/repo)</span>
          </li>
          <li className="flex items-start gap-2">
            <code className="text-primary shrink-0">{"{{AUTO_MERGE}}"}</code>
            <span className="text-text-muted">
              Whether auto-merge is enabled — use with{" "}
              <code className="text-primary">{"{{#if AUTO_MERGE}}...{{/if}}"}</code>
            </span>
          </li>
        </ul>
      </div>
      <textarea
        value={template}
        onChange={(e) => setTemplate(e.target.value)}
        rows={12}
        className="w-full px-3 py-2 rounded-md bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary resize-y leading-relaxed"
      />
      <div className="flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={autoMerge}
            onChange={(e) => setAutoMerge(e.target.checked)}
            className="w-4 h-4 rounded"
          />
          Auto-merge PRs
        </label>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-1.5 rounded-md bg-primary text-white text-xs hover:bg-primary-hover disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

function DefaultReviewEditor() {
  const [reviewPrompt, setReviewPrompt] = useState("");
  const [reviewModel, setReviewModel] = useState("sonnet");
  const [reviewTrigger, setReviewTrigger] = useState("on_ci_pass");
  const [reviewContextWindow, setReviewContextWindow] = useState("200k");
  const [reviewEffort, setReviewEffort] = useState("medium");
  const [reviewThinking, setReviewThinking] = useState(true);
  const [reviewTestCommand, setReviewTestCommand] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getReviewDefault()
      .then((res) => setReviewPrompt(res.template))
      .catch(() => {
        import("@optio/shared").then((m) => setReviewPrompt(m.DEFAULT_REVIEW_PROMPT_TEMPLATE)).catch(() => {});
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-4 rounded-lg border border-border bg-bg-card text-center text-text-muted text-sm">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading...
      </div>
    );
  }

  return (
    <div className="p-4 rounded-lg border border-border bg-bg-card space-y-3">
      <p className="text-xs text-text-muted">
        Default review settings applied to all repos unless overridden in repo settings.
      </p>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-text-muted mb-1">Default Trigger</label>
          <select
            value={reviewTrigger}
            onChange={(e) => setReviewTrigger(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
          >
            <option value="on_ci_pass">After CI passes</option>
            <option value="on_pr">Immediately on PR open</option>
            <option value="manual">Manual only</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Default Review Model</label>
          <select
            value={reviewModel}
            onChange={(e) => setReviewModel(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
          >
            <option value="sonnet">Sonnet 4.6</option>
            <option value="opus">Opus 4.6</option>
            <option value="haiku">Haiku 4.5</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-xs text-text-muted mb-1">Context Window</label>
          <select
            value={reviewContextWindow}
            onChange={(e) => setReviewContextWindow(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
          >
            <option value="200k">200K tokens</option>
            <option value="1m">1M tokens</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Effort Level</label>
          <select
            value={reviewEffort}
            onChange={(e) => setReviewEffort(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={reviewThinking}
              onChange={(e) => setReviewThinking(e.target.checked)}
              className="w-4 h-4 rounded"
            />
            <span className="text-sm">Thinking</span>
          </label>
        </div>
      </div>

      <div>
        <label className="block text-xs text-text-muted mb-1">Default Test Command</label>
        <p className="text-[10px] text-text-muted/60 mb-1.5">
          Command to run tests locally. Leave empty if GitHub Actions handles testing — the reviewer will check CI status instead.
        </p>
        <input
          value={reviewTestCommand}
          onChange={(e) => setReviewTestCommand(e.target.value)}
          placeholder="npm test, cargo test, pytest"
          className="w-full px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
        />
      </div>

      <div className="p-3 rounded-md bg-bg border border-border">
        <p className="text-xs text-text-muted mb-2">Available template variables:</p>
        <ul className="text-xs space-y-1.5">
          <li className="flex items-start gap-2">
            <code className="text-primary shrink-0">{"{{PR_NUMBER}}"}</code>
            <span className="text-text-muted">Pull request number</span>
          </li>
          <li className="flex items-start gap-2">
            <code className="text-primary shrink-0">{"{{TASK_FILE}}"}</code>
            <span className="text-text-muted">Path to the review context file</span>
          </li>
          <li className="flex items-start gap-2">
            <code className="text-primary shrink-0">{"{{REPO_NAME}}"}</code>
            <span className="text-text-muted">Repository name (e.g. owner/repo)</span>
          </li>
          <li className="flex items-start gap-2">
            <code className="text-primary shrink-0">{"{{TASK_TITLE}}"}</code>
            <span className="text-text-muted">Original task title</span>
          </li>
          <li className="flex items-start gap-2">
            <code className="text-primary shrink-0">{"{{TEST_COMMAND}}"}</code>
            <span className="text-text-muted">Test command from repo settings</span>
          </li>
        </ul>
      </div>

      <textarea
        value={reviewPrompt}
        onChange={(e) => setReviewPrompt(e.target.value)}
        rows={10}
        className="w-full px-3 py-2 rounded-md bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary resize-y leading-relaxed"
      />

      <div className="flex items-center justify-between">
        <button
          onClick={() =>
            import("@optio/shared").then((m) => setReviewPrompt(m.DEFAULT_REVIEW_PROMPT_TEMPLATE))
          }
          className="text-xs text-primary hover:underline"
        >
          Reset to default
        </button>
        <button
          onClick={async () => {
            setSaving(true);
            try {
              await api.saveReviewDefault(reviewPrompt);
              toast.success("Review defaults saved");
            } catch {
              toast.error("Failed to save");
            } finally {
              setSaving(false);
            }
          }}
          disabled={saving}
          className="px-4 py-1.5 rounded-md bg-primary text-white text-xs hover:bg-primary-hover disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [providers, setProviders] = useState<any[]>([]);

  useEffect(() => {
    if (typeof Notification !== "undefined") {
      setNotificationsEnabled(Notification.permission === "granted");
    }
    api
      .listTicketProviders()
      .then((res) => setProviders(res.providers))
      .catch(() => {});
  }, []);

  const requestNotifications = async () => {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setNotificationsEnabled(result === "granted");
    if (result === "granted") {
      toast.success("Notifications enabled");
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await api.syncTickets();
      toast.success(`Synced ${res.synced} tickets`);
    } catch (err) {
      toast.error("Sync failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8">
      <h1 className="text-xl font-bold">Settings</h1>

      {/* Notifications */}
      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Notifications</h2>
        <div className="p-4 rounded-lg border border-border bg-bg-card">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Bell className="w-5 h-5 text-text-muted" />
              <div>
                <p className="text-sm">Browser Notifications</p>
                <p className="text-xs text-text-muted">
                  Get notified when tasks complete or need attention
                </p>
              </div>
            </div>
            <button
              onClick={requestNotifications}
              disabled={notificationsEnabled}
              className={`px-3 py-1.5 rounded-md text-xs ${
                notificationsEnabled
                  ? "bg-success/10 text-success"
                  : "bg-primary text-white hover:bg-primary-hover"
              }`}
            >
              {notificationsEnabled ? "Enabled" : "Enable"}
            </button>
          </div>
        </div>
      </section>

      {/* Ticket Sync */}
      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Ticket Integration</h2>
        <div className="p-4 rounded-lg border border-border bg-bg-card space-y-3">
          <p className="text-xs text-text-muted">
            Sync issues labeled with{" "}
            <code className="px-1 py-0.5 bg-bg rounded text-primary">optio</code> from your
            configured ticket providers.
          </p>
          {providers.length > 0 ? (
            <div className="space-y-2">
              {providers.map((p: any) => (
                <div key={p.id} className="flex items-center gap-2 text-sm">
                  <span
                    className={`w-2 h-2 rounded-full ${p.enabled ? "bg-success" : "bg-text-muted"}`}
                  />
                  <span className="capitalize">{p.source}</span>
                  <span className="text-xs text-text-muted">
                    {p.source === "github" &&
                      p.config?.owner &&
                      `${p.config.owner}/${p.config.repo}`}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-text-muted">No ticket providers configured.</p>
          )}
          <button
            onClick={handleSync}
            disabled={syncing}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary/10 text-primary text-xs hover:bg-primary/20 transition-colors disabled:opacity-50"
          >
            {syncing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Sync Now
          </button>
        </div>
      </section>

      {/* Prompt Template */}
      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Default Agent Prompt Template</h2>
        <PromptTemplateEditor />
      </section>

      {/* Default Code Review */}
      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Default Code Review Agent</h2>
        <DefaultReviewEditor />
      </section>
    </div>
  );
}
