"use client";

import { use, useEffect, useState } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PRESET_IMAGES, type PresetImageId } from "@optio/shared";
import { NumberInput } from "@/components/number-input";
import {
  Loader2,
  FolderGit2,
  Save,
  Trash2,
  ArrowLeft,
  Lock,
  Globe,
  GitPullRequest,
  Eye,
  Bot,
  ChevronDown,
  ChevronRight,
  Terminal,
  Plus,
  CircleDot,
  Server,
  Sparkles,
  X,
  Plug,
} from "lucide-react";
import { formatRelativeTime, formatDuration } from "@/lib/utils";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { SharedDirectoriesSection } from "@/components/shared-directories-section";

const AGENT_TABS = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "OpenAI Codex" },
  { value: "copilot", label: "GitHub Copilot" },
  { value: "opencode", label: "OpenCode" },
  { value: "gemini", label: "Google Gemini" },
  { value: "openclaw", label: "OpenClaw" },
] as const;

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
  const [cautiousMode, setCautiousMode] = useState(false);
  const [defaultAgentType, setDefaultAgentType] = useState("claude-code");
  const [activeAgentTab, setActiveAgentTab] = useState("claude-code");
  const [promptOverride, setPromptOverride] = useState("");
  const [useCustomPrompt, setUseCustomPrompt] = useState(false);
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [claudeModel, setClaudeModel] = useState("opus");
  const [claudeContextWindow, setClaudeContextWindow] = useState("1m");
  const [claudeThinking, setClaudeThinking] = useState(true);
  const [claudeEffort, setClaudeEffort] = useState("high");
  const [copilotModel, setCopilotModel] = useState("");
  const [copilotEffort, setCopilotEffort] = useState("");
  const [geminiModel, setGeminiModel] = useState("gemini-2.5-pro");
  const [geminiApprovalMode, setGeminiApprovalMode] = useState("yolo");
  const [opencodeModel, setOpencodeModel] = useState("");
  const [opencodeAgent, setOpencodeAgent] = useState("");
  const [opencodeBaseUrl, setOpencodeBaseUrl] = useState("");
  const [openclawModel, setOpenclawModel] = useState("");
  const [maxTurnsCoding, setMaxTurnsCoding] = useState(250);
  const [maxTurnsReview, setMaxTurnsReview] = useState(30);
  const [autoResume, setAutoResume] = useState(false);
  const [planningModeEnabled, setPlanningModeEnabled] = useState(false);
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(2);
  const [maxPodInstances, setMaxPodInstances] = useState(1);
  const [maxAgentsPerPod, setMaxAgentsPerPod] = useState(2);
  const [networkPolicy, setNetworkPolicy] = useState("unrestricted");
  const [secretProxy, setSecretProxy] = useState(false);
  const [offPeakOnly, setOffPeakOnly] = useState(false);
  const [cpuRequest, setCpuRequest] = useState("");
  const [cpuLimit, setCpuLimit] = useState("");
  const [memoryRequest, setMemoryRequest] = useState("");
  const [memoryLimit, setMemoryLimit] = useState("");
  const [dockerInDocker, setDockerInDocker] = useState(false);
  const [reviewEnabled, setReviewEnabled] = useState(false);
  const [reviewTrigger, setReviewTrigger] = useState("on_ci_pass");
  const [testCommand, setTestCommand] = useState("");
  const [reviewModel, setReviewModel] = useState("sonnet");
  const [reviewPromptTemplate, setReviewPromptTemplate] = useState("");
  const [showReviewPrompt, setShowReviewPrompt] = useState(false);
  // External (non-optio-authored) PR auto-review
  const [externalReviewMode, setExternalReviewMode] = useState<
    "off" | "on_request" | "on_pr_hold" | "on_pr_post"
  >("off");
  const [externalReviewWaitForCi, setExternalReviewWaitForCi] = useState(true);
  const [externalReviewSkipDrafts, setExternalReviewSkipDrafts] = useState(true);
  const [externalReviewSkipOptioAuthored, setExternalReviewSkipOptioAuthored] = useState(true);
  const [externalReviewExcludeAuthors, setExternalReviewExcludeAuthors] = useState("");
  const [externalReviewIncludeAuthors, setExternalReviewIncludeAuthors] = useState("");
  const [externalReviewExcludeLabels, setExternalReviewExcludeLabels] = useState("");
  const [externalReviewIncludeLabels, setExternalReviewIncludeLabels] = useState("");
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

  // Connections
  const [repoConnections, setRepoConnections] = useState<any[]>([]);

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
        setCautiousMode(r.cautiousMode ?? false);
        setDefaultAgentType(r.defaultAgentType ?? "claude-code");
        setActiveAgentTab(r.defaultAgentType ?? "claude-code");
        setAutoResume(r.autoResume ?? false);
        setPlanningModeEnabled(r.planningModeEnabled ?? false);
        setMaxConcurrentTasks(r.maxConcurrentTasks ?? 2);
        setMaxPodInstances(r.maxPodInstances ?? 1);
        setMaxAgentsPerPod(r.maxAgentsPerPod ?? 2);
        setNetworkPolicy(r.networkPolicy ?? "unrestricted");
        setSecretProxy(r.secretProxy ?? false);
        setOffPeakOnly(r.offPeakOnly ?? false);
        setCpuRequest(r.cpuRequest ?? "");
        setCpuLimit(r.cpuLimit ?? "");
        setMemoryRequest(r.memoryRequest ?? "");
        setMemoryLimit(r.memoryLimit ?? "");
        setDockerInDocker(r.dockerInDocker ?? false);
        setDefaultBranch(r.defaultBranch);
        setClaudeModel(r.claudeModel ?? "opus");
        setClaudeContextWindow(r.claudeContextWindow ?? "1m");
        setClaudeThinking(r.claudeThinking ?? true);
        setClaudeEffort(r.claudeEffort ?? "high");
        setCopilotModel(r.copilotModel ?? "");
        setCopilotEffort(r.copilotEffort ?? "");
        setGeminiModel(r.geminiModel ?? "gemini-2.5-pro");
        setGeminiApprovalMode(r.geminiApprovalMode ?? "yolo");
        setOpencodeModel(r.opencodeModel ?? "");
        setOpencodeAgent(r.opencodeAgent ?? "");
        setOpencodeBaseUrl(r.opencodeBaseUrl ?? "");
        setOpenclawModel(r.openclawModel ?? "");
        setMaxTurnsCoding(r.maxTurnsCoding ?? 250);
        setMaxTurnsReview(r.maxTurnsReview ?? 30);
        setReviewEnabled(r.reviewEnabled ?? false);
        setReviewTrigger(r.reviewTrigger ?? "on_ci_pass");
        setTestCommand(r.testCommand ?? "");
        setReviewModel(r.reviewModel ?? "sonnet");
        setReviewPromptTemplate(r.reviewPromptTemplate ?? "");
        if (r.reviewPromptTemplate) setShowReviewPrompt(true);
        setExternalReviewMode(r.externalReviewMode ?? "off");
        setExternalReviewWaitForCi(r.externalReviewWaitForCi ?? true);
        const filters = r.externalReviewFilters ?? {};
        setExternalReviewSkipDrafts(filters.skipDrafts ?? true);
        setExternalReviewSkipOptioAuthored(filters.skipOptioAuthored ?? true);
        setExternalReviewIncludeAuthors((filters.includeAuthors ?? []).join(", "));
        setExternalReviewExcludeAuthors((filters.excludeAuthors ?? []).join(", "));
        setExternalReviewIncludeLabels((filters.includeLabels ?? []).join(", "));
        setExternalReviewExcludeLabels((filters.excludeLabels ?? []).join(", "));
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

  // Fetch MCP servers, skills, and connections for this repo
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
    api
      .listRepoConnections(repo.id)
      .then((res) => setRepoConnections(res.connections))
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
        autoMerge: cautiousMode ? false : autoMerge,
        cautiousMode,
        defaultAgentType,
        autoResume,
        planningModeEnabled,
        maxConcurrentTasks,
        maxPodInstances,
        maxAgentsPerPod,
        networkPolicy,
        secretProxy,
        offPeakOnly,
        dockerInDocker,
        defaultBranch,
        promptTemplateOverride: useCustomPrompt ? promptOverride : null,
        claudeModel,
        claudeContextWindow,
        claudeThinking,
        claudeEffort,
        copilotModel: copilotModel || undefined,
        copilotEffort: copilotEffort || undefined,
        geminiModel: geminiModel || undefined,
        geminiApprovalMode: geminiApprovalMode || undefined,
        opencodeModel: opencodeModel || undefined,
        opencodeAgent: opencodeAgent || undefined,
        opencodeBaseUrl: opencodeBaseUrl || null,
        openclawModel: openclawModel || undefined,
        maxTurnsCoding,
        maxTurnsReview,
        reviewEnabled,
        reviewTrigger,
        testCommand,
        reviewModel,
        reviewPromptTemplate: showReviewPrompt ? reviewPromptTemplate : null,
        externalReviewMode,
        externalReviewWaitForCi,
        externalReviewFilters: {
          skipDrafts: externalReviewSkipDrafts,
          skipOptioAuthored: externalReviewSkipOptioAuthored,
          includeAuthors: externalReviewIncludeAuthors
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          excludeAuthors: externalReviewExcludeAuthors
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          includeLabels: externalReviewIncludeLabels
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          excludeLabels: externalReviewExcludeLabels
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        },
        cpuRequest: cpuRequest || null,
        cpuLimit: cpuLimit || null,
        memoryRequest: memoryRequest || null,
        memoryLimit: memoryLimit || null,
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
            <NumberInput
              min={1}
              max={50}
              value={maxConcurrentTasks}
              onChange={(v) => setMaxConcurrentTasks(v)}
              fallback={2}
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
            <NumberInput
              min={1}
              max={20}
              value={maxPodInstances}
              onChange={(v) => setMaxPodInstances(v)}
              fallback={1}
            />
            <p className="text-[10px] text-text-muted/60 mt-1">
              Pod replicas for this repo. Extra pods are created when demand exceeds single-pod
              capacity.
            </p>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Max agents per pod</label>
            <NumberInput
              min={1}
              max={50}
              value={maxAgentsPerPod}
              onChange={(v) => setMaxAgentsPerPod(v)}
              fallback={2}
            />
            <p className="text-[10px] text-text-muted/60 mt-1">
              Max concurrent agents (worktrees) in a single pod.
            </p>
          </div>
        </div>

        <h3 className="text-xs font-medium text-text-muted pt-2">Pod Resources</h3>
        <p className="text-[10px] text-text-muted/60">
          Configure CPU and memory requests/limits for workspace pods. Leave empty to use cluster
          defaults. Changes apply to newly created pods only.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-text-muted mb-1">CPU request</label>
            <input
              value={cpuRequest}
              onChange={(e) => setCpuRequest(e.target.value)}
              placeholder="e.g. 500m"
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            />
            <p className="text-[10px] text-text-muted/60 mt-1">
              Minimum CPU guaranteed. Use millicores (e.g. &quot;500m&quot;) or cores (e.g.
              &quot;2&quot;). Range: 100m–32000m.
            </p>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">CPU limit</label>
            <input
              value={cpuLimit}
              onChange={(e) => setCpuLimit(e.target.value)}
              placeholder="e.g. 2000m"
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            />
            <p className="text-[10px] text-text-muted/60 mt-1">
              Maximum CPU allowed. Must be &ge; CPU request.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-text-muted mb-1">Memory request</label>
            <input
              value={memoryRequest}
              onChange={(e) => setMemoryRequest(e.target.value)}
              placeholder="e.g. 512Mi"
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            />
            <p className="text-[10px] text-text-muted/60 mt-1">
              Minimum memory guaranteed. Use binary units (e.g. &quot;512Mi&quot;, &quot;2Gi&quot;).
              Range: 256Mi–64Gi.
            </p>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Memory limit</label>
            <input
              value={memoryLimit}
              onChange={(e) => setMemoryLimit(e.target.value)}
              placeholder="e.g. 4Gi"
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            />
            <p className="text-[10px] text-text-muted/60 mt-1">
              Maximum memory allowed. Must be &ge; memory request. Pod is OOM-killed if exceeded.
            </p>
          </div>
        </div>

        <h3 className="text-xs font-medium text-text-muted pt-2">Network Egress Policy</h3>
        <p className="text-[10px] text-text-muted/60">
          Control outbound network access from agent pods. Requires a CNI plugin that supports
          NetworkPolicy (Calico, Cilium, etc.).
        </p>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-text-muted mb-1">Egress policy</label>
            <select
              value={networkPolicy}
              onChange={(e) => setNetworkPolicy(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            >
              <option value="unrestricted">Unrestricted (default)</option>
              <option value="restricted">Restricted</option>
            </select>
            <p className="text-[10px] text-text-muted/60 mt-1">
              {networkPolicy === "restricted"
                ? "Egress limited to DNS, AI APIs (Anthropic, OpenAI), GitHub, and the Optio API server."
                : "No network restrictions. Agent pods can reach any endpoint."}
            </p>
          </div>
        </div>
        {networkPolicy === "restricted" && (
          <div className="p-3 rounded-md bg-bg border border-border">
            <p className="text-xs text-text-muted mb-2">Allowed egress destinations:</p>
            <ul className="text-xs space-y-1 text-text-muted">
              <li>DNS (kube-dns, port 53 UDP/TCP)</li>
              <li>HTTPS (port 443) &mdash; api.anthropic.com, api.openai.com, github.com</li>
              <li>Intra-namespace &mdash; Optio API server (callbacks, token refresh)</li>
            </ul>
          </div>
        )}

        <h3 className="text-xs font-medium text-text-muted pt-2">Secret Proxy (Envoy Sidecar)</h3>
        <p className="text-[10px] text-text-muted/60">
          Inject an Envoy sidecar proxy that intercepts outbound API calls and adds authentication
          headers. Agent containers never see raw secrets (GitHub token, Anthropic API key).
        </p>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={secretProxy}
            onChange={(e) => setSecretProxy(e.target.checked)}
            className="w-4 h-4 rounded"
          />
          <div>
            <span className="text-sm">Enable secret proxy</span>
            <p className="text-[10px] text-text-muted/60 mt-0.5">
              Adds an Envoy sidecar to agent pods. Requires &ldquo;Restricted&rdquo; network policy
              to prevent agents from bypassing the proxy.
            </p>
          </div>
        </label>
        {secretProxy && networkPolicy !== "restricted" && (
          <div className="p-3 rounded-md bg-warning/10 border border-warning/30">
            <p className="text-xs text-warning">
              Warning: Secret proxy is most effective with a restricted network policy. Without
              egress restrictions, agents can bypass the proxy and call APIs directly.
            </p>
          </div>
        )}
        {secretProxy && (
          <div className="p-3 rounded-md bg-bg border border-border">
            <p className="text-xs text-text-muted mb-2">Secrets covered by the proxy:</p>
            <ul className="text-xs space-y-1 text-text-muted">
              <li>
                <code className="text-primary">GITHUB_TOKEN</code> &rarr;{" "}
                <code>Authorization: Bearer</code> for github.com, api.github.com
              </li>
              <li>
                <code className="text-primary">ANTHROPIC_API_KEY</code> &rarr;{" "}
                <code>x-api-key</code> for api.anthropic.com
              </li>
            </ul>
            <p className="text-[10px] text-text-muted/60 mt-2">
              Note: <code>CLAUDE_CODE_OAUTH_TOKEN</code> is not covered in v1 &mdash; Claude Code
              reads it from an env var, not via HTTP headers.
            </p>
          </div>
        )}

        <h3 className="text-xs font-medium text-text-muted pt-2">Off-Peak Scheduling</h3>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={offPeakOnly}
            onChange={(e) => setOffPeakOnly(e.target.checked)}
            className="w-4 h-4 rounded"
          />
          <div>
            <span className="text-sm">Off-peak only</span>
            <p className="text-[10px] text-text-muted/60 mt-0.5">
              Hold tasks in queue during peak hours (8 AM &ndash; 2 PM ET, weekdays) and run them
              during off-peak windows when 2x usage limits apply. Individual tasks can be overridden
              with &ldquo;Run Now&rdquo;.
            </p>
          </div>
        </label>

        <h3 className="text-xs font-medium text-text-muted pt-2">Docker-in-Docker</h3>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={dockerInDocker}
            onChange={(e) => setDockerInDocker(e.target.checked)}
            className="w-4 h-4 rounded"
          />
          <div>
            <span className="text-sm">Enable Docker-in-Docker</span>
            <p className="text-[10px] text-text-muted/60 mt-0.5">
              Allow agents to run <code>docker build</code> and <code>docker run</code> inside pods.
              Uses rootless Docker with K8s user namespace isolation (<code>hostUsers: false</code>)
              and minimal capabilities (SYS_CHROOT only) &mdash; no privileged mode needed. Requires
              workspace admin opt-in via <code>allowDockerInDocker</code>.
            </p>
          </div>
        </label>
        {dockerInDocker && (
          <div className="p-3 rounded-md bg-bg border border-border">
            <p className="text-xs text-text-muted mb-2">Node requirements:</p>
            <ul className="text-xs space-y-1 text-text-muted">
              <li>Linux kernel &ge; 6.3</li>
              <li>containerd &ge; 2.0 or CRI-O &ge; 1.25</li>
              <li>Filesystem support for idmap mounts (ext4, xfs, overlay, tmpfs)</li>
            </ul>
            <p className="text-[10px] text-text-muted/60 mt-2">
              Docker Desktop&apos;s Linux VM uses kernel 6.10+ so local dev should work out of the
              box. Cloud clusters may need recent node images.
            </p>
          </div>
        )}
      </section>

      {/* PR Lifecycle */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-0">
        <div className="flex items-center gap-2 mb-1">
          <GitPullRequest className="w-4 h-4 text-text-muted" />
          <h2 className="text-sm font-medium">PR Lifecycle (Optio-opened PRs)</h2>
        </div>
        <p className="text-xs text-text-muted mb-4">
          Configure what happens after an Optio coding task opens a pull request. These settings do
          not apply to PRs opened by humans or other bots — see{" "}
          <span className="text-text">External PR Review</span> below.
        </p>

        {/* Cautious Mode */}
        <div className="flex items-center gap-3 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 mb-4">
          <label className="flex items-center gap-2 cursor-pointer flex-1">
            <input
              type="checkbox"
              checked={cautiousMode}
              onChange={(e) => {
                setCautiousMode(e.target.checked);
                if (e.target.checked) setAutoMerge(false);
              }}
              className="w-4 h-4 rounded"
            />
            <div>
              <span className="text-sm font-medium">Cautious Mode</span>
              <p className="text-xs text-text-muted">
                Opens draft PRs and disables auto-merge. A human must mark PRs ready and merge them
                manually.
              </p>
            </div>
          </label>
        </div>

        {/* Planning Mode */}
        <div className="flex items-center gap-3 p-3 rounded-lg border border-border/50 bg-bg mb-4">
          <label className="flex items-center gap-2 cursor-pointer flex-1">
            <input
              type="checkbox"
              checked={planningModeEnabled}
              onChange={(e) => setPlanningModeEnabled(e.target.checked)}
              className="w-4 h-4 rounded"
            />
            <div>
              <span className="text-sm font-medium">Planning Mode</span>
              <p className="text-xs text-text-muted">
                Agent creates an implementation plan and waits for approval before coding
              </p>
            </div>
          </label>
        </div>

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
            <span className="text-sm">Enable automatic review of Optio-opened PRs</span>
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
                  <NumberInput
                    min={1}
                    max={100}
                    value={maxTurnsReview}
                    onChange={(v) => setMaxTurnsReview(v)}
                    fallback={10}
                    placeholder="10"
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
        <PipelineStage
          number={3}
          enabled={autoMerge}
          disabled={cautiousMode}
          last
          label="Auto-merge"
        >
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoMerge}
              onChange={(e) => setAutoMerge(e.target.checked)}
              disabled={cautiousMode}
              className="w-4 h-4 rounded"
            />
            <span className="text-sm">Auto-merge PR when checks pass and review completes</span>
          </label>
          {cautiousMode && (
            <p className="text-xs text-amber-500 mt-1">
              Disabled by Cautious Mode — PRs are opened as drafts and require manual merge.
            </p>
          )}
        </PipelineStage>
      </section>

      {/* External PR Review */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <Eye className="w-4 h-4 text-text-muted" />
          <h2 className="text-sm font-medium">External PR Review</h2>
        </div>
        <p className="text-xs text-text-muted mb-4">
          Review pull requests opened on this repo by anyone other than an Optio coding task —
          humans, Dependabot, Renovate, etc. Optio polls the platform for open PRs and spawns a
          review agent per the selected mode. Independent of the PR Lifecycle settings above.
        </p>

        <div>
          <label className="block text-xs text-text-muted mb-1">Mode</label>
          <select
            value={externalReviewMode}
            onChange={(e) => setExternalReviewMode(e.target.value as typeof externalReviewMode)}
            className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
          >
            <option value="off">Off</option>
            <option value="on_request">On request only (manual)</option>
            <option value="on_pr_hold">Auto-review on PR open — hold draft in Optio</option>
            <option value="on_pr_post">Auto-review on PR open — post to GitHub/GitLab</option>
          </select>
          <p className="text-[10px] text-text-muted/60 mt-1">
            {externalReviewMode === "off" &&
              "External PRs will not be reviewed automatically or tracked by Optio."}
            {externalReviewMode === "on_request" &&
              "Optio will not auto-generate reviews. You can trigger one manually from the PR view."}
            {externalReviewMode === "on_pr_hold" &&
              "Optio will auto-generate a review and hold it as a draft for you to edit and submit manually — nothing is posted to the platform until you approve."}
            {externalReviewMode === "on_pr_post" &&
              "Optio will auto-generate AND auto-post the review as a comment on the PR."}
          </p>
        </div>

        {(externalReviewMode === "on_pr_hold" || externalReviewMode === "on_pr_post") && (
          <div className="space-y-3 pt-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={externalReviewWaitForCi}
                onChange={(e) => setExternalReviewWaitForCi(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              <span className="text-sm">Wait for CI to finish before starting the review</span>
            </label>

            <div className="grid grid-cols-2 gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={externalReviewSkipDrafts}
                  onChange={(e) => setExternalReviewSkipDrafts(e.target.checked)}
                  className="w-4 h-4 rounded"
                />
                <span className="text-sm">Skip draft PRs</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={externalReviewSkipOptioAuthored}
                  onChange={(e) => setExternalReviewSkipOptioAuthored(e.target.checked)}
                  className="w-4 h-4 rounded"
                />
                <span className="text-sm">Skip PRs from Optio tasks</span>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-text-muted mb-1">
                  Only these authors (comma-separated)
                </label>
                <input
                  value={externalReviewIncludeAuthors}
                  onChange={(e) => setExternalReviewIncludeAuthors(e.target.value)}
                  placeholder="leave empty for all"
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">
                  Skip authors (comma-separated)
                </label>
                <input
                  value={externalReviewExcludeAuthors}
                  onChange={(e) => setExternalReviewExcludeAuthors(e.target.value)}
                  placeholder="dependabot, renovate"
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-text-muted mb-1">Only these labels</label>
                <input
                  value={externalReviewIncludeLabels}
                  onChange={(e) => setExternalReviewIncludeLabels(e.target.value)}
                  placeholder="leave empty for all"
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                />
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Skip these labels</label>
                <input
                  value={externalReviewExcludeLabels}
                  onChange={(e) => setExternalReviewExcludeLabels(e.target.value)}
                  placeholder="wip, skip-review"
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                />
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Agent Configuration */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-4">
        <div className="flex items-center gap-2 mb-1">
          <Bot className="w-4 h-4 text-text-muted" />
          <h2 className="text-sm font-medium">Agent Configuration</h2>
        </div>
        <p className="text-xs text-text-muted">
          Configure each agent&apos;s settings for this repo. Tabs are just for navigation — the
          agent with the <span className="text-text">default</span> pill is the one used for new
          tasks (users can override per-task). All agents&apos; settings are saved together.
        </p>

        {/* Tabs */}
        <div className="flex flex-wrap gap-1 border-b border-border/50">
          {AGENT_TABS.map((agent) => {
            const isActive = activeAgentTab === agent.value;
            const isDefault = defaultAgentType === agent.value;
            return (
              <button
                key={agent.value}
                type="button"
                onClick={() => setActiveAgentTab(agent.value)}
                className={cn(
                  "px-3 py-2 text-sm border-b-2 transition-colors whitespace-nowrap -mb-px",
                  isActive
                    ? "border-primary text-text font-medium"
                    : "border-transparent text-text-muted hover:text-text",
                )}
              >
                {agent.label}
                {isDefault && (
                  <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-normal align-middle">
                    default
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Default indicator / Set as default action */}
        <div className="flex items-center justify-between text-xs">
          {activeAgentTab === defaultAgentType ? (
            <span className="text-text-muted">
              This is the default agent for new tasks on this repo.
            </span>
          ) : (
            <>
              <span className="text-text-muted">Viewing settings — not the current default.</span>
              <button
                type="button"
                onClick={() => setDefaultAgentType(activeAgentTab)}
                className="px-3 py-1 rounded-md border border-border hover:border-primary hover:text-primary transition-colors"
              >
                Set as default
              </button>
            </>
          )}
        </div>

        {/* Claude Code tab */}
        {activeAgentTab === "claude-code" && (
          <div className="space-y-3">
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
              <NumberInput
                min={1}
                max={1000}
                value={maxTurnsCoding}
                onChange={(v) => setMaxTurnsCoding(v)}
                fallback={250}
                placeholder="250"
                className="w-48 px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
            </div>
          </div>
        )}

        {/* Codex tab */}
        {activeAgentTab === "codex" && (
          <p className="text-xs text-text-muted italic py-2">
            OpenAI Codex uses its built-in defaults. No per-repo configuration is required.
          </p>
        )}

        {/* Copilot tab */}
        {activeAgentTab === "copilot" && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-text-muted mb-1">Model</label>
              <select
                value={copilotModel}
                onChange={(e) => setCopilotModel(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              >
                <option value="">Default</option>
                <option value="claude-sonnet-4.5">Claude Sonnet 4.5</option>
                <option value="gpt-5">GPT-5</option>
                <option value="gpt-5.2">GPT-5.2</option>
                <option value="gpt-5.4">GPT-5.4</option>
                <option value="gpt-5.4-mini">GPT-5.4 Mini</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Reasoning Effort</label>
              <select
                value={copilotEffort}
                onChange={(e) => setCopilotEffort(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              >
                <option value="">Default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>
        )}

        {/* OpenCode tab */}
        {activeAgentTab === "opencode" && (
          <div className="space-y-3">
            <p className="text-xs text-text-muted">
              Use a custom base URL to connect to local or self-hosted OpenAI-compatible inference
              servers (vLLM, lightllm, Ollama, etc.).
            </p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-text-muted mb-1">Model</label>
                <input
                  value={opencodeModel}
                  onChange={(e) => setOpencodeModel(e.target.value)}
                  placeholder="Default (auto-detect)"
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                />
                <p className="text-xs text-text-muted mt-1">
                  e.g. anthropic/claude-sonnet-4, openai/gpt-4o, meta-llama/Llama-3.1-70B
                </p>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Agent</label>
                <input
                  value={opencodeAgent}
                  onChange={(e) => setOpencodeAgent(e.target.value)}
                  placeholder="Default"
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Custom Base URL</label>
              <input
                value={opencodeBaseUrl}
                onChange={(e) => setOpencodeBaseUrl(e.target.value)}
                placeholder="https://your-inference-server/v1"
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              />
              <p className="text-xs text-text-muted mt-1">
                OpenAI-compatible endpoint URL. When set, API keys are optional — a placeholder key
                is used if none is configured in Secrets.
              </p>
            </div>
          </div>
        )}

        {/* Gemini tab */}
        {activeAgentTab === "gemini" && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-text-muted mb-1">Model</label>
              <select
                value={geminiModel}
                onChange={(e) => setGeminiModel(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              >
                <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                <option value="gemini-3-pro">Gemini 3 Pro</option>
                <option value="gemini-3-flash">Gemini 3 Flash</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Approval Mode</label>
              <select
                value={geminiApprovalMode}
                onChange={(e) => setGeminiApprovalMode(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
              >
                <option value="yolo">Yolo (skip all approvals)</option>
                <option value="auto_edit">Auto Edit</option>
                <option value="default">Default</option>
              </select>
            </div>
          </div>
        )}

        {/* OpenClaw tab */}
        {activeAgentTab === "openclaw" && (
          <div>
            <label className="block text-xs text-text-muted mb-1">Model</label>
            <input
              value={openclawModel}
              onChange={(e) => setOpenclawModel(e.target.value)}
              placeholder="Default (auto-detect)"
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20"
            />
          </div>
        )}
      </section>

      {/* Cache Directories */}
      {repo && <SharedDirectoriesSection repoId={repo.id} maxPodInstances={repo.maxPodInstances} />}

      {/* Connections */}
      <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Plug className="w-4 h-4 text-text-muted" />
            <h2 className="text-sm font-medium">Connections</h2>
          </div>
          <Link
            href="/connections"
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <Plus className="w-3.5 h-3.5" />
            Manage Connections
          </Link>
        </div>
        <p className="text-xs text-text-muted">
          External services connected to agents running on this repo. Manage connections and add new
          ones from the{" "}
          <Link href="/connections" className="text-primary hover:underline">
            Connections
          </Link>{" "}
          page.
        </p>

        {repoConnections.length > 0 ? (
          <div className="space-y-2">
            {repoConnections.map((conn: any) => (
              <div
                key={conn.id}
                className="flex items-center gap-3 p-3 rounded-lg border border-border bg-bg"
              >
                <span
                  className={cn(
                    "w-2 h-2 rounded-full shrink-0",
                    conn.status === "healthy"
                      ? "bg-green-500"
                      : conn.status === "error"
                        ? "bg-red-500"
                        : "bg-gray-400",
                  )}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{conn.name}</span>
                    {conn.provider && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                        {conn.provider.name}
                      </span>
                    )}
                  </div>
                  {conn.statusMessage && (
                    <p className="text-[11px] text-text-muted mt-0.5 truncate">
                      {conn.statusMessage}
                    </p>
                  )}
                </div>
                <span
                  className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded",
                    conn.enabled ? "bg-green-500/10 text-green-400" : "bg-bg-hover text-text-muted",
                  )}
                >
                  {conn.enabled ? "Active" : "Disabled"}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-text-muted/60 italic">
            No connections assigned to this repo.{" "}
            <Link href="/connections" className="text-primary hover:underline">
              Add one
            </Link>
          </p>
        )}
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
                <li className="flex items-start gap-2">
                  <code className="text-primary shrink-0">{"{{DRAFT_PR}}"}</code>
                  <span className="text-text-muted">
                    Whether Cautious Mode is on (opens draft PRs) — use with{" "}
                    <code className="text-primary">{"{{#if DRAFT_PR}}...{{/if}}"}</code>
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
