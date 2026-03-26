"use client";

import { useState, useEffect } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import {
  Loader2,
  Bell,
  RefreshCw,
  Shield,
  CheckCircle2,
  XCircle,
  Server,
  Sparkles,
  Plus,
  X,
} from "lucide-react";

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
      <div className="p-5 rounded-xl border border-border/50 bg-bg-card text-center text-text-muted text-sm">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading...
      </div>
    );
  }

  return (
    <div className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
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
        className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y leading-relaxed"
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
    api
      .getReviewDefault()
      .then((res) => setReviewPrompt(res.template))
      .catch(() => {
        import("@optio/shared")
          .then((m) => setReviewPrompt(m.DEFAULT_REVIEW_PROMPT_TEMPLATE))
          .catch(() => {});
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-5 rounded-xl border border-border/50 bg-bg-card text-center text-text-muted text-sm">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading...
      </div>
    );
  }

  return (
    <div className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
      <p className="text-xs text-text-muted">
        Default review settings applied to all repos unless overridden in repo settings.
      </p>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs text-text-muted mb-1">Default Trigger</label>
          <select
            value={reviewTrigger}
            onChange={(e) => setReviewTrigger(e.target.value)}
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
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
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
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
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
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
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
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
          Command to run tests locally. Leave empty if GitHub Actions handles testing — the reviewer
          will check CI status instead.
        </p>
        <input
          value={reviewTestCommand}
          onChange={(e) => setReviewTestCommand(e.target.value)}
          placeholder="npm test, cargo test, pytest"
          className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
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
        className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y leading-relaxed"
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

function GlobalMcpServers() {
  const [servers, setServers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [installCmd, setInstallCmd] = useState("");

  useEffect(() => {
    api
      .listMcpServers("global")
      .then((res) => setServers(res.servers))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-5 rounded-xl border border-border/50 bg-bg-card text-center text-text-muted text-sm">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading...
      </div>
    );
  }

  return (
    <div className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">
          Global MCP servers are available to all repos. Use{" "}
          <code className="text-primary">{"${{SECRET_NAME}}"}</code> to reference Optio secrets.
        </p>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Plus className="w-3.5 h-3.5" />
          Add
        </button>
      </div>

      {servers.length > 0 && (
        <div className="space-y-2">
          {servers.map((server: any) => (
            <div
              key={server.id}
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{server.name}</span>
                  {!server.enabled && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                      disabled
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-muted mt-0.5 font-mono truncate">
                  {server.command} {(server.args ?? []).join(" ")}
                </p>
              </div>
              <button
                onClick={async () => {
                  await api.updateMcpServer(server.id, { enabled: !server.enabled });
                  setServers((prev) =>
                    prev.map((s) => (s.id === server.id ? { ...s, enabled: !s.enabled } : s)),
                  );
                }}
                className="text-xs text-text-muted hover:text-text"
              >
                {server.enabled ? "Disable" : "Enable"}
              </button>
              <button
                onClick={async () => {
                  await api.deleteMcpServer(server.id);
                  setServers((prev) => prev.filter((s) => s.id !== server.id));
                  toast.success("MCP server removed");
                }}
                className="text-text-muted hover:text-error"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {servers.length === 0 && !showAdd && (
        <p className="text-xs text-text-muted/60 text-center py-2">
          No global MCP servers configured.
        </p>
      )}

      {showAdd && (
        <div className="space-y-3 p-3 rounded-lg border border-primary/30 bg-primary/5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="postgres"
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Command</label>
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Args (one per line)</label>
            <textarea
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              rows={2}
              placeholder={"-y\n@modelcontextprotocol/server-postgres"}
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y"
            />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">
              Env vars (KEY=VALUE, one per line)
            </label>
            <textarea
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              rows={2}
              placeholder={"POSTGRES_URL=${{POSTGRES_URL}}"}
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y"
            />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Install command (optional)</label>
            <input
              value={installCmd}
              onChange={(e) => setInstallCmd(e.target.value)}
              placeholder="npm install -g @modelcontextprotocol/server-postgres"
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setShowAdd(false);
                setName("");
                setCommand("");
                setArgs("");
                setEnv("");
                setInstallCmd("");
              }}
              className="px-3 py-1.5 rounded-md text-xs text-text-muted hover:bg-bg-hover"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                if (!name || !command) {
                  toast.error("Name and command are required");
                  return;
                }
                const parsedArgs = args
                  .split("\n")
                  .map((a) => a.trim())
                  .filter(Boolean);
                const parsedEnv: Record<string, string> = {};
                for (const line of env.split("\n")) {
                  const idx = line.indexOf("=");
                  if (idx > 0) parsedEnv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                }
                const res = await api.createMcpServer({
                  name,
                  command,
                  args: parsedArgs.length > 0 ? parsedArgs : undefined,
                  env: Object.keys(parsedEnv).length > 0 ? parsedEnv : undefined,
                  installCommand: installCmd || undefined,
                });
                setServers((prev) => [...prev, res.server]);
                setShowAdd(false);
                setName("");
                setCommand("");
                setArgs("");
                setEnv("");
                setInstallCmd("");
                toast.success("MCP server added");
              }}
              className="px-3 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover"
            >
              Add Server
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function GlobalSkills() {
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    api
      .listSkills("global")
      .then((res) => setSkills(res.skills))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-5 rounded-xl border border-border/50 bg-bg-card text-center text-text-muted text-sm">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading...
      </div>
    );
  }

  return (
    <div className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">
          Global skills are available as slash commands to agents in all repos. Written to{" "}
          <code className="text-primary">.claude/commands/</code> before the agent starts.
        </p>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Plus className="w-3.5 h-3.5" />
          Add
        </button>
      </div>

      {skills.length > 0 && (
        <div className="space-y-2">
          {skills.map((skill: any) => (
            <div
              key={skill.id}
              className="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">/{skill.name}</span>
                  {!skill.enabled && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                      disabled
                    </span>
                  )}
                </div>
                {skill.description && (
                  <p className="text-xs text-text-muted mt-0.5 truncate">{skill.description}</p>
                )}
              </div>
              <button
                onClick={async () => {
                  await api.updateSkill(skill.id, { enabled: !skill.enabled });
                  setSkills((prev) =>
                    prev.map((s) => (s.id === skill.id ? { ...s, enabled: !s.enabled } : s)),
                  );
                }}
                className="text-xs text-text-muted hover:text-text"
              >
                {skill.enabled ? "Disable" : "Enable"}
              </button>
              <button
                onClick={async () => {
                  await api.deleteSkill(skill.id);
                  setSkills((prev) => prev.filter((s) => s.id !== skill.id));
                  toast.success("Skill removed");
                }}
                className="text-text-muted hover:text-error"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {skills.length === 0 && !showAdd && (
        <p className="text-xs text-text-muted/60 text-center py-2">No global skills configured.</p>
      )}

      {showAdd && (
        <div className="space-y-3 p-3 rounded-lg border border-primary/30 bg-primary/5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="run-tests"
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Description</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Run the full test suite"
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Prompt (markdown)</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              placeholder="Run the full test suite and analyze any failures..."
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setShowAdd(false);
                setName("");
                setDescription("");
                setPrompt("");
              }}
              className="px-3 py-1.5 rounded-md text-xs text-text-muted hover:bg-bg-hover"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                if (!name || !prompt) {
                  toast.error("Name and prompt are required");
                  return;
                }
                const res = await api.createSkill({
                  name,
                  description: description || undefined,
                  prompt,
                });
                setSkills((prev) => [...prev, res.skill]);
                setShowAdd(false);
                setName("");
                setDescription("");
                setPrompt("");
                toast.success("Skill added");
              }}
              className="px-3 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover"
            >
              Add Skill
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AuthenticationSettings() {
  const [providers, setProviders] = useState<Array<{ name: string; displayName: string }>>([]);
  const [authDisabled, setAuthDisabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getAuthProviders()
      .then((res) => {
        setProviders(res.providers);
        setAuthDisabled(res.authDisabled);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-5 rounded-xl border border-border/50 bg-bg-card text-center text-text-muted text-sm">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Loading...
      </div>
    );
  }

  return (
    <div className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-4">
      {authDisabled && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs">
          <Shield className="w-4 h-4 shrink-0" />
          <div>
            <p className="font-medium">Authentication is disabled</p>
            <p className="text-amber-400/70 mt-0.5">
              Set{" "}
              <code className="px-1 py-0.5 bg-amber-500/10 rounded">OPTIO_AUTH_DISABLED=false</code>{" "}
              and configure OAuth providers to enable authentication.
            </p>
          </div>
        </div>
      )}

      <div>
        <p className="text-xs text-text-muted mb-3">
          OAuth providers are auto-detected from environment variables. Configure the client ID and
          secret for each provider you want to enable.
        </p>

        <div className="space-y-2">
          {(["github", "google", "gitlab"] as const).map((name) => {
            const enabled = providers.some((p) => p.name === name);
            const displayName =
              name === "github" ? "GitHub" : name === "google" ? "Google" : "GitLab";
            const envPrefix = name.toUpperCase();
            return (
              <div
                key={name}
                className="flex items-center justify-between p-3 rounded-lg border border-border"
              >
                <div className="flex items-center gap-3">
                  {enabled ? (
                    <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
                  ) : (
                    <XCircle className="w-4 h-4 text-text-muted/40 shrink-0" />
                  )}
                  <div>
                    <p className="text-sm font-medium">{displayName}</p>
                    <p className="text-[10px] text-text-muted">
                      {`${envPrefix}_OAUTH_CLIENT_ID`} / {`${envPrefix}_OAUTH_CLIENT_SECRET`}
                    </p>
                  </div>
                </div>
                <span
                  className={`text-[10px] px-2 py-0.5 rounded-full ${
                    enabled ? "bg-success/10 text-success" : "bg-text-muted/10 text-text-muted"
                  }`}
                >
                  {enabled ? "Configured" : "Not configured"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  usePageTitle("Settings");
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
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      {/* Authentication */}
      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Authentication</h2>
        <AuthenticationSettings />
      </section>

      {/* Notifications */}
      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3">Notifications</h2>
        <div className="p-5 rounded-xl border border-border/50 bg-bg-card">
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
        <div className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
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

      {/* MCP Servers */}
      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3 flex items-center gap-2">
          <Server className="w-4 h-4" />
          Global MCP Servers
        </h2>
        <GlobalMcpServers />
      </section>

      {/* Custom Skills */}
      <section>
        <h2 className="text-sm font-medium text-text-muted mb-3 flex items-center gap-2">
          <Sparkles className="w-4 h-4" />
          Global Custom Skills
        </h2>
        <GlobalSkills />
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
