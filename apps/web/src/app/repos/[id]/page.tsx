"use client";

import { use, useEffect, useState } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PRESET_IMAGES, type PresetImageId } from "@optio/shared";
import {
  Loader2,
  FolderGit2,
  Save,
  Trash2,
  ArrowLeft,
  Lock,
  Globe,
  GitPullRequest,
  ChevronDown,
  ChevronRight,
  Terminal,
  Plus,
  CircleDot,
  Server,
  Sparkles,
  X,
} from "lucide-react";
import { formatRelativeTime, formatDuration } from "@/lib/utils";
import { cn } from "@/lib/utils";
import Link from "next/link";

export default function RepoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [repo, setRepo] = useState<any>(null);
  usePageTitle(repo?.fullName ?? "Repository");
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
  const [maxTurnsCoding, setMaxTurnsCoding] = useState(250);
  const [maxTurnsReview, setMaxTurnsReview] = useState(10);
  const [autoResume, setAutoResume] = useState(false);
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(2);
  const [maxPodInstances, setMaxPodInstances] = useState(1);
  const [maxAgentsPerPod, setMaxAgentsPerPod] = useState(2);
  const [reviewEnabled, setReviewEnabled] = useState(false);
  const [reviewTrigger, setReviewTrigger] = useState("on_ci_pass");
  const [testCommand, setTestCommand] = useState("");
  const [reviewModel, setReviewModel] = useState("sonnet");
  const [reviewPromptTemplate, setReviewPromptTemplate] = useState("");
  const [showReviewPrompt, setShowReviewPrompt] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const [sessionCount, setSessionCount] = useState(0);
  const [creatingSession, setCreatingSession] = useState(false);

  // MCP Servers
  const [mcpServers, setMcpServers] = useState<any[]>([]);
  const [showAddMcp, setShowAddMcp] = useState(false);
  const [newMcpName, setNewMcpName] = useState("");
  const [newMcpCommand, setNewMcpCommand] = useState("");
  const [newMcpArgs, setNewMcpArgs] = useState("");
  const [newMcpEnv, setNewMcpEnv] = useState("");
  const [newMcpInstallCmd, setNewMcpInstallCmd] = useState("");

  // Custom Skills
  const [skills, setSkills] = useState<any[]>([]);
  const [showAddSkill, setShowAddSkill] = useState(false);
  const [newSkillName, setNewSkillName] = useState("");
  const [newSkillDescription, setNewSkillDescription] = useState("");
  const [newSkillPrompt, setNewSkillPrompt] = useState("");

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
        setAutoResume(r.autoResume ?? false);
        setMaxConcurrentTasks(r.maxConcurrentTasks ?? 2);
        setMaxPodInstances(r.maxPodInstances ?? 1);
        setMaxAgentsPerPod(r.maxAgentsPerPod ?? 2);
        setDefaultBranch(r.defaultBranch);
        setClaudeModel(r.claudeModel ?? "opus");
        setClaudeContextWindow(r.claudeContextWindow ?? "1m");
        setClaudeThinking(r.claudeThinking ?? true);
        setClaudeEffort(r.claudeEffort ?? "high");
        setMaxTurnsCoding(r.maxTurnsCoding ?? 250);
        setMaxTurnsReview(r.maxTurnsReview ?? 10);
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

  // Fetch sessions for this repo
  useEffect(() => {
    if (!repo?.repoUrl) return;
    api
      .listSessions({ repoUrl: repo.repoUrl, limit: 5 })
      .then((res) => {
        setSessions(res.sessions);
        setSessionCount(res.activeCount);
      })
      .catch(() => {});
  }, [repo?.repoUrl]);

  // Fetch MCP servers and skills for this repo
  useEffect(() => {
    if (!repo?.id) return;
    api
      .listRepoMcpServers(repo.id)
      .then((res) => setMcpServers(res.servers))
      .catch(() => {});
    api
      .listSkills(repo.repoUrl)
      .then((res) => setSkills(res.skills))
      .catch(() => {});
  }, [repo?.id, repo?.repoUrl]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateRepo(id, {
        imagePreset,
        extraPackages: extraPackages || undefined,
        setupCommands: setupCommands || undefined,
        customDockerfile: customDockerfile || null,
        autoMerge,
        autoResume,
        maxConcurrentTasks,
        maxPodInstances,
        maxAgentsPerPod,
        defaultBranch,
        promptTemplateOverride: useCustomPrompt ? promptOverride : null,
        claudeModel,
        claudeContextWindow,
        claudeThinking,
        claudeEffort,
        maxTurnsCoding,
        maxTurnsReview,
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

  const handleCreateSession = async () => {
    if (!repo?.repoUrl) return;
    setCreatingSession(true);
    try {
      const res = await api.createSession({ repoUrl: repo.repoUrl });
      toast.success("Session created");
      window.location.href = `/sessions/${res.session.id}`;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create session");
    }
    setCreatingSession(false);
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/repos" className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <FolderGit2 className="w-5 h-5 text-text-muted" />
        <h1 className="text-2xl font-semibold tracking-tight">{repo.fullName}</h1>
        {repo.isPrivate ? (
          <Lock className="w-4 h-4 text-text-muted" />
        ) : (
          <Globe className="w-4 h-4 text-text-muted" />
        )}
        <div className="flex-1" />
        <button
          onClick={handleCreateSession}
          disabled={creatingSession}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
        >
          {creatingSession ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Terminal className="w-3.5 h-3.5" />
          )}
          New Session
        </button>
      </div>

      {/* Sessions */}
      {sessions.length > 0 && (
        <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium flex items-center gap-2">
              <Terminal className="w-4 h-4 text-primary" />
              Sessions
              {sessionCount > 0 && (
                <span className="text-xs font-normal text-primary bg-primary/10 px-1.5 py-0.5 rounded-md">
                  {sessionCount} active
                </span>
              )}
            </h2>
            <Link href="/sessions" className="text-xs text-primary hover:underline">
              All sessions &rarr;
            </Link>
          </div>
          <div className="space-y-1.5">
            {sessions.map((session: any) => {
              const isActive = session.state === "active";
              return (
                <Link
                  key={session.id}
                  href={`/sessions/${session.id}`}
                  className="flex items-center gap-3 p-2.5 rounded-lg border border-border hover:border-primary/30 hover:bg-bg-hover transition-colors"
                >
                  <div
                    className={cn(
                      "w-7 h-7 rounded-md flex items-center justify-center shrink-0",
                      isActive ? "bg-primary/10 text-primary" : "bg-bg text-text-muted",
                    )}
                  >
                    <Terminal className="w-3.5 h-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-xs font-medium truncate block">
                      {session.branch ?? `Session ${session.id.slice(0, 8)}`}
                    </span>
                    <div className="flex items-center gap-2 text-[10px] text-text-muted">
                      <span>{formatRelativeTime(session.createdAt)}</span>
                      {isActive && (
                        <span className="text-primary">{formatDuration(session.createdAt)}</span>
                      )}
                    </div>
                  </div>
                  {isActive && (
                    <span className="flex items-center gap-1 px-2 py-1 rounded-md bg-primary/10 text-primary text-[10px] font-medium shrink-0">
                      <CircleDot className="w-2.5 h-2.5" />
                      Connect
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* General */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
        <h2 className="text-sm font-medium">General</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-text-muted mb-1">Default Branch</label>
            <input
              value={defaultBranch}
              onChange={(e) => setDefaultBranch(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Max concurrent tasks</label>
            <input
              type="number"
              min={1}
              max={50}
              value={maxConcurrentTasks}
              onChange={(e) => setMaxConcurrentTasks(parseInt(e.target.value, 10) || 2)}
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            />
          </div>
        </div>

        <h3 className="text-xs font-medium text-text-muted pt-2">Pod Scaling</h3>
        <p className="text-[10px] text-text-muted/60">
          Control how many pod replicas are created for this repo and how many agents run per pod.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-text-muted mb-1">Max pod instances</label>
            <input
              type="number"
              min={1}
              max={20}
              value={maxPodInstances}
              onChange={(e) => setMaxPodInstances(parseInt(e.target.value, 10) || 1)}
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            />
            <p className="text-[10px] text-text-muted/60 mt-1">
              Pod replicas for this repo. Extra pods are created when demand exceeds single-pod
              capacity.
            </p>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Max agents per pod</label>
            <input
              type="number"
              min={1}
              max={50}
              value={maxAgentsPerPod}
              onChange={(e) => setMaxAgentsPerPod(parseInt(e.target.value, 10) || 2)}
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            />
            <p className="text-[10px] text-text-muted/60 mt-1">
              Max concurrent agents (worktrees) in a single pod.
            </p>
          </div>
        </div>
      </section>

      {/* PR Lifecycle */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-0">
        <div className="flex items-center gap-2 mb-1">
          <GitPullRequest className="w-4 h-4 text-text-muted" />
          <h2 className="text-sm font-medium">PR Lifecycle</h2>
        </div>
        <p className="text-xs text-text-muted mb-4">
          Configure what happens after the coding agent opens a pull request.
        </p>

        {/* Stage 1: Code Review */}
        <PipelineStage number={1} enabled={reviewEnabled} label="Code Review">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={reviewEnabled}
              onChange={(e) => {
                setReviewEnabled(e.target.checked);
                if (e.target.checked && !reviewPromptTemplate) {
                  import("@optio/shared")
                    .then((m) => {
                      if (!reviewPromptTemplate)
                        setReviewPromptTemplate(m.DEFAULT_REVIEW_PROMPT_TEMPLATE);
                    })
                    .catch(() => {});
                }
              }}
              className="w-4 h-4 rounded"
            />
            <span className="text-sm">Enable automatic code review</span>
          </label>

          {reviewEnabled && (
            <div className="space-y-3 mt-3 pt-3 border-t border-border/50">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-text-muted mb-1">Trigger</label>
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
                  <label className="block text-xs text-text-muted mb-1">Test command</label>
                  <input
                    value={testCommand}
                    onChange={(e) => setTestCommand(e.target.value)}
                    placeholder="npm test, cargo test, pytest"
                    className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                  />
                  <p className="text-[10px] text-text-muted/60 mt-1">
                    Leave empty if CI handles testing — the reviewer will check CI status instead.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-text-muted mb-1">Review Model</label>
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
                <div>
                  <label className="block text-xs text-text-muted mb-1">Context Window</label>
                  <select
                    value={claudeContextWindow}
                    className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                  >
                    <option value="200k">200K tokens</option>
                    <option value="1m">1M tokens</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-text-muted mb-1">Effort Level</label>
                  <select
                    value={claudeEffort}
                    className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-text-muted mb-1">Max Turns</label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={maxTurnsReview}
                    onChange={(e) => setMaxTurnsReview(parseInt(e.target.value, 10) || 10)}
                    placeholder="10"
                    className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                  />
                </div>
              </div>

              {/* Collapsible review prompt */}
              <div>
                <button
                  onClick={() => setShowReviewPrompt(!showReviewPrompt)}
                  className="flex items-center gap-1 text-xs text-text-muted hover:text-text transition-colors"
                >
                  {showReviewPrompt ? (
                    <ChevronDown className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5" />
                  )}
                  Review prompt template
                </button>
                {showReviewPrompt && (
                  <div className="mt-2 space-y-2">
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-xs text-text-muted">
                        Custom review prompt template
                      </label>
                      <button
                        onClick={() =>
                          import("@optio/shared")
                            .then((m) => setReviewPromptTemplate(m.DEFAULT_REVIEW_PROMPT_TEMPLATE))
                            .catch(() => {})
                        }
                        className="text-xs text-primary hover:underline shrink-0"
                      >
                        Reset to default
                      </button>
                    </div>
                    <textarea
                      value={reviewPromptTemplate}
                      onChange={(e) => setReviewPromptTemplate(e.target.value)}
                      rows={8}
                      className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y leading-relaxed"
                    />
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
                          <span className="text-text-muted">Test command configured above</span>
                        </li>
                      </ul>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </PipelineStage>

        {/* Stage 2: Auto-Resume */}
        <PipelineStage number={2} enabled={autoResume} label="Auto-Resume">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoResume}
              onChange={(e) => setAutoResume(e.target.checked)}
              className="w-4 h-4 rounded"
            />
            <div>
              <span className="text-sm">
                Auto-resume agent on CI failures, merge conflicts, or review changes
              </span>
            </div>
          </label>
        </PipelineStage>

        {/* Stage 3: Auto-merge */}
        <PipelineStage number={3} enabled={autoMerge} last label="Auto-merge">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoMerge}
              onChange={(e) => setAutoMerge(e.target.checked)}
              className="w-4 h-4 rounded"
            />
            <span className="text-sm">Auto-merge PR when checks pass and review completes</span>
          </label>
        </PipelineStage>
      </section>

      {/* Agent Settings */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
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
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
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
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
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
                checked={claudeThinking}
                onChange={(e) => setClaudeThinking(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm">Extended Thinking</span>
            </label>
          </div>
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Max Turns</label>
          <input
            type="number"
            min={1}
            max={1000}
            value={maxTurnsCoding}
            onChange={(e) => setMaxTurnsCoding(parseInt(e.target.value, 10) || 250)}
            placeholder="250"
            className="w-48 px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
          />
        </div>
      </section>

      {/* MCP Servers */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-text-muted" />
            <h2 className="text-sm font-medium">MCP Servers</h2>
          </div>
          <button
            onClick={() => setShowAddMcp(!showAddMcp)}
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Server
          </button>
        </div>
        <p className="text-xs text-text-muted">
          MCP servers give agents access to databases, APIs, and other tools. Servers configured
          here are injected into the agent&apos;s <code className="text-primary">.mcp.json</code> at
          runtime. Use <code className="text-primary">{"${{SECRET_NAME}}"}</code> to reference Optio
          secrets in args or env vars.
        </p>

        {mcpServers.length > 0 && (
          <div className="space-y-2">
            {mcpServers.map((server: any) => (
              <div
                key={server.id}
                className="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{server.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-hover text-text-muted">
                      {server.scope === "global" ? "global" : "repo"}
                    </span>
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
                    setMcpServers((prev) =>
                      prev.map((s) => (s.id === server.id ? { ...s, enabled: !s.enabled } : s)),
                    );
                  }}
                  className="text-xs text-text-muted hover:text-text"
                >
                  {server.enabled ? "Disable" : "Enable"}
                </button>
                {server.scope !== "global" && (
                  <button
                    onClick={async () => {
                      await api.deleteMcpServer(server.id);
                      setMcpServers((prev) => prev.filter((s) => s.id !== server.id));
                      toast.success("MCP server removed");
                    }}
                    className="text-text-muted hover:text-error"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {showAddMcp && (
          <div className="space-y-3 p-3 rounded-lg border border-primary/30 bg-primary/5">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-text-muted mb-1">Name</label>
                <input
                  value={newMcpName}
                  onChange={(e) => setNewMcpName(e.target.value)}
                  placeholder="postgres"
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Command</label>
                <input
                  value={newMcpCommand}
                  onChange={(e) => setNewMcpCommand(e.target.value)}
                  placeholder="npx"
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Args (one per line)</label>
              <textarea
                value={newMcpArgs}
                onChange={(e) => setNewMcpArgs(e.target.value)}
                rows={2}
                placeholder={"-y\n@modelcontextprotocol/server-postgres\n${{POSTGRES_URL}}"}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y"
              />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">
                Env vars (KEY=VALUE, one per line)
              </label>
              <textarea
                value={newMcpEnv}
                onChange={(e) => setNewMcpEnv(e.target.value)}
                rows={2}
                placeholder={"POSTGRES_URL=${{POSTGRES_URL}}"}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y"
              />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">
                Install command (optional)
              </label>
              <input
                value={newMcpInstallCmd}
                onChange={(e) => setNewMcpInstallCmd(e.target.value)}
                placeholder="npm install -g @modelcontextprotocol/server-postgres"
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowAddMcp(false);
                  setNewMcpName("");
                  setNewMcpCommand("");
                  setNewMcpArgs("");
                  setNewMcpEnv("");
                  setNewMcpInstallCmd("");
                }}
                className="px-3 py-1.5 rounded-md text-xs text-text-muted hover:bg-bg-hover"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (!newMcpName || !newMcpCommand) {
                    toast.error("Name and command are required");
                    return;
                  }
                  const args = newMcpArgs
                    .split("\n")
                    .map((a) => a.trim())
                    .filter(Boolean);
                  const env: Record<string, string> = {};
                  for (const line of newMcpEnv.split("\n")) {
                    const idx = line.indexOf("=");
                    if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                  }
                  const res = await api.createRepoMcpServer(id, {
                    name: newMcpName,
                    command: newMcpCommand,
                    args: args.length > 0 ? args : undefined,
                    env: Object.keys(env).length > 0 ? env : undefined,
                    installCommand: newMcpInstallCmd || undefined,
                  });
                  setMcpServers((prev) => [...prev, res.server]);
                  setShowAddMcp(false);
                  setNewMcpName("");
                  setNewMcpCommand("");
                  setNewMcpArgs("");
                  setNewMcpEnv("");
                  setNewMcpInstallCmd("");
                  toast.success("MCP server added");
                }}
                className="px-3 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover"
              >
                Add Server
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Custom Skills */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-text-muted" />
            <h2 className="text-sm font-medium">Custom Skills</h2>
          </div>
          <button
            onClick={() => setShowAddSkill(!showAddSkill)}
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Skill
          </button>
        </div>
        <p className="text-xs text-text-muted">
          Custom skills are reusable prompt commands written to{" "}
          <code className="text-primary">.claude/commands/</code> before the agent starts. The agent
          can invoke them as slash commands.
        </p>

        {skills.filter((s: any) => s.scope === repo.repoUrl || s.scope === "global").length > 0 && (
          <div className="space-y-2">
            {skills
              .filter((s: any) => s.scope === repo.repoUrl || s.scope === "global")
              .map((skill: any) => (
                <div
                  key={skill.id}
                  className="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">/{skill.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-hover text-text-muted">
                        {skill.scope === "global" ? "global" : "repo"}
                      </span>
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
                  {skill.scope !== "global" && (
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
                  )}
                </div>
              ))}
          </div>
        )}

        {showAddSkill && (
          <div className="space-y-3 p-3 rounded-lg border border-primary/30 bg-primary/5">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-text-muted mb-1">Name</label>
                <input
                  value={newSkillName}
                  onChange={(e) => setNewSkillName(e.target.value)}
                  placeholder="run-tests"
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Description</label>
                <input
                  value={newSkillDescription}
                  onChange={(e) => setNewSkillDescription(e.target.value)}
                  placeholder="Run the full test suite"
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Prompt (markdown)</label>
              <textarea
                value={newSkillPrompt}
                onChange={(e) => setNewSkillPrompt(e.target.value)}
                rows={6}
                placeholder="Run the full test suite and analyze any failures..."
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowAddSkill(false);
                  setNewSkillName("");
                  setNewSkillDescription("");
                  setNewSkillPrompt("");
                }}
                className="px-3 py-1.5 rounded-md text-xs text-text-muted hover:bg-bg-hover"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (!newSkillName || !newSkillPrompt) {
                    toast.error("Name and prompt are required");
                    return;
                  }
                  const res = await api.createSkill({
                    name: newSkillName,
                    description: newSkillDescription || undefined,
                    prompt: newSkillPrompt,
                    repoUrl: repo.repoUrl,
                  });
                  setSkills((prev) => [...prev, res.skill]);
                  setShowAddSkill(false);
                  setNewSkillName("");
                  setNewSkillDescription("");
                  setNewSkillPrompt("");
                  toast.success("Skill added");
                }}
                className="px-3 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover"
              >
                Add Skill
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Image */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
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
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
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
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y leading-relaxed"
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
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y leading-relaxed"
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
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
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
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y leading-relaxed"
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

function PipelineStage({
  number,
  enabled,
  disabled,
  last,
  label,
  children,
}: {
  number: number;
  enabled: boolean;
  disabled?: boolean;
  last?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex gap-3", disabled && "opacity-40")}>
      {/* Left rail */}
      <div className="flex flex-col items-center">
        <div
          className={cn(
            "w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium shrink-0",
            enabled ? "bg-primary text-white" : "bg-border text-text-muted",
          )}
        >
          {number}
        </div>
        {!last && <div className="w-px flex-1 my-1 bg-border" />}
      </div>
      {/* Content */}
      <div className={cn("flex-1", last ? "pb-0" : "pb-4")}>
        <div className="text-sm font-medium mb-1.5">{label}</div>
        {children}
      </div>
    </div>
  );
}
