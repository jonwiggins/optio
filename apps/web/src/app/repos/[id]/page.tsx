"use client";

import { use, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PRESET_IMAGES, type PresetImageId } from "@optio/shared";
import { Loader2, FolderGit2, Save, Trash2, ArrowLeft, Lock, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";

export default function RepoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [repo, setRepo] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Editable fields
  const [imagePreset, setImagePreset] = useState("base");
  const [extraPackages, setExtraPackages] = useState("");
  const [setupCommands, setSetupCommands] = useState("");
  const [customDockerfile, setCustomDockerfile] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [autoMerge, setAutoMerge] = useState(false);
  const [promptOverride, setPromptOverride] = useState("");
  const [useCustomPrompt, setUseCustomPrompt] = useState(false);
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [claudeModel, setClaudeModel] = useState("opus");
  const [claudeContextWindow, setClaudeContextWindow] = useState("1m");
  const [claudeThinking, setClaudeThinking] = useState(true);
  const [claudeEffort, setClaudeEffort] = useState("high");
  const [autoResumeOnReview, setAutoResumeOnReview] = useState(false);
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(2);
  const [reviewEnabled, setReviewEnabled] = useState(false);
  const [reviewTrigger, setReviewTrigger] = useState("on_ci_pass");
  const [testCommand, setTestCommand] = useState("");
  const [reviewModel, setReviewModel] = useState("sonnet");
  const [reviewPromptTemplate, setReviewPromptTemplate] = useState("");
  const [showReviewPrompt, setShowReviewPrompt] = useState(false);

  useEffect(() => {
    api
      .getRepo(id)
      .then((res) => {
        const r = res.repo;
        setRepo(r);
        setImagePreset(r.imagePreset ?? "base");
        setExtraPackages(r.extraPackages ?? "");
        setSetupCommands(r.setupCommands ?? "");
        setCustomDockerfile(r.customDockerfile ?? "");
        if (r.setupCommands || r.customDockerfile) setShowAdvanced(true);
        setAutoMerge(r.autoMerge);
        setAutoResumeOnReview(r.autoResumeOnReview ?? false);
        setMaxConcurrentTasks(r.maxConcurrentTasks ?? 2);
        setDefaultBranch(r.defaultBranch);
        setClaudeModel(r.claudeModel ?? "opus");
        setClaudeContextWindow(r.claudeContextWindow ?? "1m");
        setClaudeThinking(r.claudeThinking ?? true);
        setClaudeEffort(r.claudeEffort ?? "high");
        setReviewEnabled(r.reviewEnabled ?? false);
        setReviewTrigger(r.reviewTrigger ?? "on_ci_pass");
        setTestCommand(r.testCommand ?? "");
        setReviewModel(r.reviewModel ?? "sonnet");
        setReviewPromptTemplate(r.reviewPromptTemplate ?? "");
        if (r.reviewPromptTemplate) setShowReviewPrompt(true);
        if (r.promptTemplateOverride) {
          setUseCustomPrompt(true);
          setPromptOverride(r.promptTemplateOverride);
        }
      })
      .catch(() => toast.error("Failed to load repo"))
      .finally(() => setLoading(false));
  }, [id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateRepo(id, {
        imagePreset,
        extraPackages: extraPackages || undefined,
        setupCommands: setupCommands || undefined,
        customDockerfile: customDockerfile || null,
        autoMerge,
        autoResumeOnReview,
        maxConcurrentTasks,
        defaultBranch,
        promptTemplateOverride: useCustomPrompt ? promptOverride : null,
        claudeModel,
        claudeContextWindow,
        claudeThinking,
        claudeEffort,
        reviewEnabled,
        reviewTrigger,
        testCommand,
        reviewModel,
        reviewPromptTemplate: showReviewPrompt ? reviewPromptTemplate : null,
      });
      toast.success("Repo settings saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Remove ${repo?.fullName} from Optio?`)) return;
    try {
      await api.deleteRepo(id);
      toast.success("Repo removed");
      router.push("/repos");
    } catch {
      toast.error("Failed to remove repo");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
      </div>
    );
  }

  if (!repo) {
    return <div className="flex items-center justify-center h-full text-error">Repo not found</div>;
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/repos" className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <FolderGit2 className="w-5 h-5 text-text-muted" />
        <h1 className="text-xl font-bold">{repo.fullName}</h1>
        {repo.isPrivate ? (
          <Lock className="w-4 h-4 text-text-muted" />
        ) : (
          <Globe className="w-4 h-4 text-text-muted" />
        )}
      </div>

      {/* Default branch */}
      <section className="p-4 rounded-lg border border-border bg-bg-card space-y-3">
        <h2 className="text-sm font-medium">General</h2>
        <div>
          <label className="block text-xs text-text-muted mb-1">Default Branch</label>
          <input
            value={defaultBranch}
            onChange={(e) => setDefaultBranch(e.target.value)}
            className="w-48 px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
          />
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={autoMerge}
            onChange={(e) => setAutoMerge(e.target.checked)}
            className="w-4 h-4 rounded"
          />
          <span className="text-sm">Auto-merge PRs when CI passes</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={autoResumeOnReview}
            onChange={(e) => setAutoResumeOnReview(e.target.checked)}
            className="w-4 h-4 rounded"
          />
          <div>
            <span className="text-sm">Auto-resume on review feedback</span>
            <p className="text-xs text-text-muted">
              When a reviewer requests changes, automatically resume the agent with the review
              comments
            </p>
          </div>
        </label>
        <div>
          <label className="block text-xs text-text-muted mb-1">Max concurrent tasks</label>
          <p className="text-[10px] text-text-muted/60 mb-1.5">
            Maximum number of tasks that can run simultaneously on this repo.
          </p>
          <input
            type="number"
            min={1}
            max={50}
            value={maxConcurrentTasks}
            onChange={(e) => setMaxConcurrentTasks(parseInt(e.target.value, 10) || 2)}
            className="w-24 px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
          />
        </div>
      </section>

      {/* Agent Settings */}
      <section className="p-4 rounded-lg border border-border bg-bg-card space-y-3">
        <h2 className="text-sm font-medium">Agent Settings</h2>
        <p className="text-xs text-text-muted">
          Configure the Claude Code model and behavior for this repo.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-text-muted mb-1">Model</label>
            <select
              value={claudeModel}
              onChange={(e) => setClaudeModel(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
            >
              <option value="sonnet">Sonnet 4.6</option>
              <option value="opus">Opus 4.6</option>
              <option value="haiku">Haiku 4.5</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Context Window</label>
            <select
              value={claudeContextWindow}
              onChange={(e) => setClaudeContextWindow(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
            >
              <option value="200k">200K tokens</option>
              <option value="1m">1M tokens</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Effort Level</label>
            <select
              value={claudeEffort}
              onChange={(e) => setClaudeEffort(e.target.value)}
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
                checked={claudeThinking}
                onChange={(e) => setClaudeThinking(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm">Extended Thinking</span>
            </label>
          </div>
        </div>
      </section>

      {/* Code Review */}
      <section className="p-4 rounded-lg border border-border bg-bg-card space-y-3">
        <h2 className="text-sm font-medium">Code Review Agent</h2>
        <p className="text-xs text-text-muted">Automatically review PRs opened by coding agents.</p>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={reviewEnabled}
            onChange={(e) => setReviewEnabled(e.target.checked)}
            className="w-4 h-4 rounded"
          />
          <span className="text-sm">Enable automated code reviews</span>
        </label>

        {reviewEnabled && (
          <div className="space-y-3 pt-2 border-t border-border">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-text-muted mb-1">Trigger</label>
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
                <label className="block text-xs text-text-muted mb-1">Review model</label>
                <select
                  value={reviewModel}
                  onChange={(e) => setReviewModel(e.target.value)}
                  className="w-full px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
                >
                  <option value="sonnet">Sonnet 4.6 (faster, cheaper)</option>
                  <option value="opus">Opus 4.6 (more thorough)</option>
                  <option value="haiku">Haiku 4.5 (fastest)</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs text-text-muted mb-1">Test command</label>
              <p className="text-[10px] text-text-muted/60 mb-1.5">
                The reviewer will run this to verify the PR doesn't break tests.
              </p>
              <input
                value={testCommand}
                onChange={(e) => setTestCommand(e.target.value)}
                placeholder="npm test, cargo test, pytest, etc."
                className="w-full px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
              />
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={showReviewPrompt}
                onChange={(e) => {
                  setShowReviewPrompt(e.target.checked);
                  if (e.target.checked && !reviewPromptTemplate) {
                    setReviewPromptTemplate("");
                  }
                }}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm">Custom review prompt</span>
            </label>

            {showReviewPrompt && (
              <textarea
                value={reviewPromptTemplate}
                onChange={(e) => setReviewPromptTemplate(e.target.value)}
                rows={8}
                placeholder="Custom review prompt template..."
                className="w-full px-3 py-2 rounded-md bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary resize-y leading-relaxed"
              />
            )}
          </div>
        )}
      </section>

      {/* Image */}
      <section className="p-4 rounded-lg border border-border bg-bg-card space-y-3">
        <h2 className="text-sm font-medium">Container Image</h2>
        <p className="text-xs text-text-muted">
          Choose the base image for agent pods working on this repo.
        </p>
        <div className="grid gap-1.5">
          {(
            Object.entries(PRESET_IMAGES) as [
              PresetImageId,
              (typeof PRESET_IMAGES)[PresetImageId],
            ][]
          ).map(([key, img]) => (
            <button
              key={key}
              onClick={() => setImagePreset(key)}
              className={cn(
                "flex items-start gap-3 p-2.5 rounded-md border text-left text-sm transition-colors",
                imagePreset === key
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-text-muted bg-bg",
              )}
            >
              <div
                className={cn(
                  "w-4 h-4 rounded-full border-2 mt-0.5 shrink-0 flex items-center justify-center",
                  imagePreset === key ? "border-primary" : "border-border",
                )}
              >
                {imagePreset === key && <div className="w-2 h-2 rounded-full bg-primary" />}
              </div>
              <div>
                <span className="font-medium">{img.label}</span>
                <p className="text-xs text-text-muted mt-0.5">{img.description}</p>
              </div>
            </button>
          ))}
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">
            Extra apt packages (comma-separated)
          </label>
          <input
            value={extraPackages}
            onChange={(e) => setExtraPackages(e.target.value)}
            placeholder="postgresql-client, redis-tools"
            className="w-full px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
          />
        </div>

        {/* Advanced toggle */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-xs text-primary hover:underline"
        >
          {showAdvanced ? "Hide advanced options" : "Show advanced options"}
        </button>

        {showAdvanced && (
          <div className="space-y-4 pt-2 border-t border-border">
            {/* Setup commands */}
            <div>
              <label className="block text-xs text-text-muted mb-1">Setup commands</label>
              <p className="text-[10px] text-text-muted/60 mb-1.5">
                Shell commands run inside the pod after cloning. Use this to install dependencies,
                build tools, or configure the environment.
              </p>
              <textarea
                value={setupCommands}
                onChange={(e) => setSetupCommands(e.target.value)}
                rows={4}
                placeholder={"npm install\nnpx playwright install --with-deps\ncargo build"}
                className="w-full px-3 py-2 rounded-md bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary resize-y leading-relaxed"
              />
            </div>

            {/* Custom Dockerfile */}
            <div>
              <label className="block text-xs text-text-muted mb-1">Custom Dockerfile</label>
              <p className="text-[10px] text-text-muted/60 mb-1.5">
                Full Dockerfile override. When set, this is used instead of the preset image. Must
                include all tools the agent needs (git, node, claude-code, gh).
              </p>
              <textarea
                value={customDockerfile}
                onChange={(e) => setCustomDockerfile(e.target.value)}
                rows={8}
                placeholder={
                  "FROM ubuntu:24.04\nRUN apt-get update && apt-get install -y git curl nodejs\nRUN npm install -g @anthropic-ai/claude-code\n# Add your custom tools here"
                }
                className="w-full px-3 py-2 rounded-md bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary resize-y leading-relaxed"
              />
              {customDockerfile && (
                <p className="text-[10px] text-warning mt-1">
                  Custom Dockerfile is set — the preset image above will be ignored. You must
                  rebuild the image manually.
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Prompt override */}
      <section className="p-4 rounded-lg border border-border bg-bg-card space-y-3">
        <h2 className="text-sm font-medium">Prompt Template</h2>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={useCustomPrompt}
            onChange={(e) => {
              const checked = e.target.checked;
              setUseCustomPrompt(checked);
              // Auto-populate with global default when enabling
              if (checked && !promptOverride) {
                api
                  .getBuiltinDefault()
                  .then((res) => setPromptOverride(res.template))
                  .catch(() => {});
              }
            }}
            className="w-4 h-4 rounded"
          />
          <span className="text-sm">Override the global prompt template for this repo</span>
        </label>
        {useCustomPrompt && (
          <>
            <div className="flex items-center justify-between">
              <p className="text-xs text-text-muted">
                Custom prompt for this repo. Overrides the global default.
              </p>
              <button
                onClick={() =>
                  api.getBuiltinDefault().then((res) => setPromptOverride(res.template))
                }
                className="text-xs text-primary hover:underline"
              >
                Reset to default
              </button>
            </div>
            <textarea
              value={promptOverride}
              onChange={(e) => setPromptOverride(e.target.value)}
              rows={12}
              className="w-full px-3 py-2 rounded-md bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary resize-y leading-relaxed"
            />
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
          </>
        )}
      </section>

      {/* Actions */}
      <div className="flex items-center justify-between">
        <button
          onClick={handleDelete}
          className="flex items-center gap-2 px-4 py-2 rounded-md text-error text-sm hover:bg-error/10 transition-colors"
        >
          <Trash2 className="w-4 h-4" />
          Remove Repo
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover disabled:opacity-50"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </div>
    </div>
  );
}
