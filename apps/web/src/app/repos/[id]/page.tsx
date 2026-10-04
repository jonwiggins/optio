"use client";

import { use, useEffect, useState } from "react";
import { FORM_WIDTH } from "@/components/ui/page";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PRESET_IMAGES, type PresetImageId } from "@optio/shared";
import { NumberInput } from "@/components/number-input";
import {
  Loader2,
  Trash2,
  ArrowLeft,
  Lock,
  Globe,
  GitBranch,
  GitPullRequest,
  Eye,
  Terminal,
  Plus,
  CircleDot,
  X,
  Save,
} from "lucide-react";
import { formatRelativeTime, formatDuration } from "@/lib/utils";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { SharedDirectoriesSection } from "@/components/shared-directories-section";
import type { AgentOptionsValues } from "@/components/agent-options-picker";
import type { AgentType } from "@optio/shared";
import { DetailHeader } from "@/components/detail-header";
import { AgentIcon } from "@/components/brand-icon";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import { Disclosure } from "@/components/ui/disclosure";
import { AgentChoice, ReviewAgentChoice } from "@/components/agent-choice";
import {
  NO_REPO_SETTINGS,
  agentSummary,
  repoAgentPatch,
  repoAgentValues,
  runtimeLabel,
} from "@/components/agent-choice-model";
import { ManagedBanner } from "@/components/ui/managed-banner";
import { ManagedChip } from "@/components/ui/managed-chip";

const INPUT = inputClass();

const EGRESS_POLICIES = [
  { value: "unrestricted", label: "Unrestricted" },
  { value: "restricted", label: "Restricted" },
];

const REVIEW_TRIGGERS = [
  { value: "on_ci_pass", label: "After CI passes" },
  { value: "on_pr", label: "On PR open" },
  { value: "manual", label: "Manual only" },
];

const EXTERNAL_REVIEW_MODES: Array<{
  value: "off" | "on_request" | "on_pr_hold" | "on_pr_post";
  label: string;
}> = [
  { value: "off", label: "Off" },
  { value: "on_request", label: "On request" },
  { value: "on_pr_hold", label: "Auto · hold draft" },
  { value: "on_pr_post", label: "Auto · post" },
];

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
  const [showScaling, setShowScaling] = useState(false);
  const [showResources, setShowResources] = useState(false);
  const [showEgress, setShowEgress] = useState(false);
  const [autoMerge, setAutoMerge] = useState(false);
  const [cautiousMode, setCautiousMode] = useState(false);
  const [defaultAgentType, setDefaultAgentType] = useState("claude-code");
  const [promptOverride, setPromptOverride] = useState("");
  const [useCustomPrompt, setUseCustomPrompt] = useState(false);
  const [defaultBranch, setDefaultBranch] = useState("main");
  // Every agent column (claudeModel, copilotEffort, …) in one picker map.
  const [agentValues, setAgentValues] = useState<AgentOptionsValues>({});
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
  // null = inherit from repo's defaultAgentType / global setting.
  const [reviewAgentType, setReviewAgentType] = useState<AgentType | null>(null);
  const [reviewModel, setReviewModel] = useState("");
  const [effectiveReviewAgentType, setEffectiveReviewAgentType] = useState<string | null>(null);
  const [effectiveReviewModel, setEffectiveReviewModel] = useState<string | null>(null);
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
        setAutoResume(r.autoResume ?? false);
        setPlanningModeEnabled(r.planningModeEnabled ?? false);
        setMaxConcurrentTasks(r.maxConcurrentTasks ?? 2);
        setMaxPodInstances(r.maxPodInstances ?? 1);
        setMaxAgentsPerPod(r.maxAgentsPerPod ?? 2);
        setNetworkPolicy(r.networkPolicy ?? "unrestricted");
        setSecretProxy(r.secretProxy ?? false);
        // Sub-groups someone has set start open.
        setShowScaling((r.maxPodInstances ?? 1) > 1 || (r.maxAgentsPerPod ?? 2) !== 2);
        setShowResources(!!(r.cpuRequest || r.cpuLimit || r.memoryRequest || r.memoryLimit));
        setShowEgress(r.networkPolicy === "restricted" || !!r.secretProxy);
        setOffPeakOnly(r.offPeakOnly ?? false);
        setCpuRequest(r.cpuRequest ?? "");
        setCpuLimit(r.cpuLimit ?? "");
        setMemoryRequest(r.memoryRequest ?? "");
        setMemoryLimit(r.memoryLimit ?? "");
        setDockerInDocker(r.dockerInDocker ?? false);
        setDefaultBranch(r.defaultBranch);
        setAgentValues(repoAgentValues(r));
        setMaxTurnsCoding(r.maxTurnsCoding ?? 250);
        setMaxTurnsReview(r.maxTurnsReview ?? 30);
        setReviewEnabled(r.reviewEnabled ?? false);
        setReviewTrigger(r.reviewTrigger ?? "on_ci_pass");
        setTestCommand(r.testCommand ?? "");
        setReviewAgentType((r.reviewAgentType as AgentType | null) ?? null);
        setReviewModel(r.reviewModel ?? "");
        setEffectiveReviewAgentType(r.effectiveReviewAgentType ?? null);
        setEffectiveReviewModel(r.effectiveReviewModel ?? null);
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
        ...repoAgentPatch(defaultAgentType, agentValues),
        maxTurnsCoding,
        maxTurnsReview,
        reviewEnabled,
        reviewTrigger,
        testCommand,
        reviewAgentType,
        reviewModel: reviewModel || undefined,
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

  const agentLine = agentSummary(defaultAgentType, agentValues);
  const podsLine = [
    `${maxPodInstances} ${maxPodInstances === 1 ? "pod" : "pods"}`,
    `${maxAgentsPerPod} agents each`,
    cpuLimit || cpuRequest ? `${cpuLimit || cpuRequest} CPU` : null,
    memoryLimit || memoryRequest ? `${memoryLimit || memoryRequest} memory` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lifecycleLine = cautiousMode
    ? "cautious · draft PRs"
    : [
        reviewEnabled ? "review" : null,
        autoResume ? "auto-resume" : null,
        autoMerge ? "auto-merge" : null,
      ]
        .filter(Boolean)
        .join(" · ") || "opens the PR, then waits";
  const visibleSkills = skills.filter((s: any) => s.scope === repo.repoUrl || s.scope === "global");

  return (
    <>
      <DetailHeader
        title={repo.fullName}
        subtitle={
          <Link href="/repos" className="inline-flex items-center gap-1 hover:text-primary">
            <ArrowLeft className="w-3 h-3" />
            Repos
          </Link>
        }
        extraBadges={
          <>
            <span className="inline-flex items-center gap-1 text-xs text-text-muted">
              {repo.isPrivate ? (
                <Lock className="w-3.5 h-3.5" />
              ) : (
                <Globe className="w-3.5 h-3.5" />
              )}
              {repo.isPrivate ? "Private" : "Public"}
            </span>
            <ManagedChip managedBy={repo.managedBy} size="sm" />
          </>
        }
        metaItems={[
          <>
            <GitBranch className="w-3 h-3" />
            {defaultBranch}
          </>,
          <>
            <AgentIcon runtime={defaultAgentType} className="w-3 h-3" />
            {agentLine}
          </>,
        ]}
        rightSlot={
          <Button size="sm" onClick={handleCreateSession} disabled={creatingSession}>
            {creatingSession ? <Loader2 className="animate-spin" /> : <Terminal />}
            New Session
          </Button>
        }
      />
      <div className="page-column py-6">
        <div className={`${FORM_WIDTH} space-y-5`}>
          {repo.managedBy && <ManagedBanner managedBy={repo.managedBy} resourceId={repo.id} />}
          {sessions.length > 0 && (
            <SectionCard
              label="Sessions"
              hint="Interactive workspaces on this repo"
              summary={sessionCount > 0 ? `${sessionCount} active` : undefined}
              actions={
                <Link href="/work" className="text-xs text-primary hover:underline">
                  All work &rarr;
                </Link>
              }
            >
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
                            <span className="text-primary">
                              {formatDuration(session.createdAt)}
                            </span>
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
            </SectionCard>
          )}

          <SectionCard
            label="General"
            hint="Branch and how much runs at once"
            summary={`${defaultBranch} · ${maxConcurrentTasks} at a time`}
            bodyClassName="p-4 space-y-4"
          >
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-text-muted mb-1">Default Branch</label>
                <input
                  value={defaultBranch}
                  onChange={(e) => setDefaultBranch(e.target.value)}
                  className={INPUT}
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
            <div className="pt-3 border-t border-border">
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
                    Hold tasks in queue during peak hours (8 AM &ndash; 2 PM ET, weekdays) and run
                    them during off-peak windows when 2x usage limits apply. Individual tasks can be
                    overridden with &ldquo;Run Now&rdquo;.
                  </p>
                </div>
              </label>
            </div>
          </SectionCard>

          <SectionCard
            label="Pods"
            hint="Where this repo's agents run"
            summary={podsLine}
            bodyClassName="p-4 space-y-4"
          >
            <Disclosure
              open={showScaling}
              onToggle={() => setShowScaling(!showScaling)}
              label="Pod scaling"
            >
              <p className="text-[10px] text-text-muted/60 mb-3">
                Control how many pod replicas are created for this repo and how many agents run per
                pod.
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
                    Pod replicas for this repo. Extra pods are created when demand exceeds
                    single-pod capacity.
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
            </Disclosure>
            <Disclosure
              open={showResources}
              onToggle={() => setShowResources(!showResources)}
              label="Resources"
            >
              <div className="space-y-4">
                <p className="text-[10px] text-text-muted/60">
                  CPU and memory requests/limits for workspace pods. Leave empty to use cluster
                  defaults. Changes apply to newly created pods only.
                </p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-text-muted mb-1">CPU request</label>
                    <input
                      value={cpuRequest}
                      onChange={(e) => setCpuRequest(e.target.value)}
                      placeholder="e.g. 500m"
                      className={inputClass()}
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
                      className={inputClass()}
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
                      className={inputClass()}
                    />
                    <p className="text-[10px] text-text-muted/60 mt-1">
                      Minimum memory guaranteed. Use binary units (e.g. &quot;512Mi&quot;,
                      &quot;2Gi&quot;). Range: 256Mi–64Gi.
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs text-text-muted mb-1">Memory limit</label>
                    <input
                      value={memoryLimit}
                      onChange={(e) => setMemoryLimit(e.target.value)}
                      placeholder="e.g. 4Gi"
                      className={inputClass()}
                    />
                    <p className="text-[10px] text-text-muted/60 mt-1">
                      Maximum memory allowed. Must be &ge; memory request. Pod is OOM-killed if
                      exceeded.
                    </p>
                  </div>
                </div>
              </div>
            </Disclosure>
            <Disclosure
              open={showEgress}
              onToggle={() => setShowEgress(!showEgress)}
              label="Network egress and secret proxy"
            >
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-text-muted mb-1">Egress policy</label>
                  <Segmented
                    value={networkPolicy}
                    onChange={setNetworkPolicy}
                    options={EGRESS_POLICIES}
                  />
                  <p className="text-[10px] text-text-muted/60 mt-1.5">
                    {networkPolicy === "restricted"
                      ? "Egress limited to DNS, AI APIs (Anthropic, OpenAI), GitHub, and the Optio API server."
                      : "No network restrictions. Agent pods can reach any endpoint."}{" "}
                    Requires a CNI plugin that supports NetworkPolicy (Calico, Cilium, etc.).
                  </p>
                </div>
                {networkPolicy === "restricted" && (
                  <div className="p-3 rounded-md bg-bg border border-border">
                    <p className="text-xs text-text-muted mb-2">Allowed egress destinations:</p>
                    <ul className="text-xs space-y-1 text-text-muted">
                      <li>DNS (kube-dns, port 53 UDP/TCP)</li>
                      <li>
                        HTTPS (port 443) &mdash; api.anthropic.com, api.openai.com, github.com
                      </li>
                      <li>Intra-namespace &mdash; Optio API server (callbacks, token refresh)</li>
                    </ul>
                  </div>
                )}

                <p className="text-[10px] text-text-muted/60 pt-1">
                  Secret proxy: an Envoy sidecar intercepts outbound API calls and adds
                  authentication headers, so agent containers never see raw secrets (GitHub token,
                  Anthropic API key).
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
                      Adds an Envoy sidecar to agent pods. Requires &ldquo;Restricted&rdquo; network
                      policy to prevent agents from bypassing the proxy.
                    </p>
                  </div>
                </label>
                {secretProxy && networkPolicy !== "restricted" && (
                  <div className="p-3 rounded-md bg-warning/10 border border-warning/30">
                    <p className="text-xs text-warning">
                      Warning: Secret proxy is most effective with a restricted network policy.
                      Without egress restrictions, agents can bypass the proxy and call APIs
                      directly.
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
                      Note: <code>CLAUDE_CODE_OAUTH_TOKEN</code> is not covered in v1 &mdash; Claude
                      Code reads it from an env var, not via HTTP headers.
                    </p>
                  </div>
                )}
              </div>
            </Disclosure>
            <div className="pt-3 border-t border-border">
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
                    Allow agents to run <code>docker build</code> and <code>docker run</code> inside
                    pods. Uses rootless Docker with K8s user namespace isolation (
                    <code>hostUsers: false</code>) and minimal capabilities (SYS_CHROOT only)
                    &mdash; no privileged mode needed. Requires workspace admin opt-in via{" "}
                    <code>allowDockerInDocker</code>.
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
                    Docker Desktop&apos;s Linux VM uses kernel 6.10+ so local dev should work out of
                    the box. Cloud clusters may need recent node images.
                  </p>
                </div>
              )}
            </div>
          </SectionCard>

          <SectionCard
            label="Coding agent"
            hint="New work on this repo starts from these"
            summary={agentLine}
            summaryIcon={<AgentIcon runtime={defaultAgentType} className="w-3 h-3" />}
          >
            <AgentChoice
              aria-label="Default agent"
              runtime={defaultAgentType}
              agentOptions={agentValues}
              onRuntimeChange={setDefaultAgentType}
              onOptionsChange={setAgentValues}
              note="The default for new work with this repo — anyone can change it per run."
              paramsHint="Saved as this repo's defaults"
              paramsNote={
                NO_REPO_SETTINGS.has(defaultAgentType)
                  ? `${runtimeLabel(defaultAgentType)} uses its built-in defaults. No per-repo configuration is required.`
                  : undefined
              }
              footer={
                defaultAgentType === "claude-code" ? (
                  <div className="mt-3">
                    <label className="block text-xs text-text-muted mb-1">Max Turns</label>
                    <NumberInput
                      min={1}
                      max={1000}
                      value={maxTurnsCoding}
                      onChange={(v) => setMaxTurnsCoding(v)}
                      fallback={250}
                      placeholder="250"
                      className={inputClass({ className: "w-48" })}
                    />
                  </div>
                ) : null
              }
            />
          </SectionCard>

          <SectionCard
            label="PR lifecycle"
            hint="Optio-opened PRs"
            summary={lifecycleLine}
            summaryIcon={<GitPullRequest className="w-3 h-3" />}
          >
            <p className="text-xs text-text-muted mb-4">
              What happens after an Optio coding task opens a pull request. PRs opened by humans or
              other bots follow <span className="text-text">External PR review</span> below.
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
                    Opens draft PRs and disables auto-merge. A human must mark PRs ready and merge
                    them manually.
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
                      <Segmented
                        value={reviewTrigger}
                        onChange={setReviewTrigger}
                        options={REVIEW_TRIGGERS}
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Test command</label>
                      <input
                        value={testCommand}
                        onChange={(e) => setTestCommand(e.target.value)}
                        placeholder="npm test, cargo test, pytest"
                        className={inputClass()}
                      />
                      <p className="text-[10px] text-text-muted/60 mt-1">
                        Leave empty if CI handles testing — the reviewer will check CI status
                        instead.
                      </p>
                    </div>
                  </div>

                  <ReviewAgentChoice
                    agentType={reviewAgentType}
                    model={reviewModel}
                    onChange={(agentType, model) => {
                      setReviewAgentType(agentType);
                      setReviewModel(model);
                    }}
                    inheritedHint={
                      effectiveReviewAgentType
                        ? `Reviews will run with: ${effectiveReviewAgentType}${
                            effectiveReviewModel ? ` · ${effectiveReviewModel}` : ""
                          }`
                        : "Reviews run with the repo's coding agent."
                    }
                  />

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

                  <Disclosure
                    open={showReviewPrompt}
                    onToggle={() => setShowReviewPrompt(!showReviewPrompt)}
                    label="Review prompt template"
                  >
                    <div className="space-y-2">
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs text-text-muted">
                          Custom review prompt template
                        </label>
                        <button
                          onClick={() =>
                            import("@optio/shared")
                              .then((m) =>
                                setReviewPromptTemplate(m.DEFAULT_REVIEW_PROMPT_TEMPLATE),
                              )
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
                        className={inputClass({
                          className: "text-xs font-mono resize-y leading-relaxed",
                        })}
                      />
                      <div className="p-3 rounded-md bg-bg border border-border">
                        <p className="text-xs text-text-muted mb-2">
                          Available template variables:
                        </p>
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
                            <span className="text-text-muted">
                              Repository name (e.g. owner/repo)
                            </span>
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
                  </Disclosure>
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
          </SectionCard>

          <SectionCard
            label="External PR review"
            hint="PRs from humans and other bots"
            summary={EXTERNAL_REVIEW_MODES.find((m) => m.value === externalReviewMode)?.label}
            summaryIcon={<Eye className="w-3 h-3" />}
            bodyClassName="p-4 space-y-3"
          >
            <p className="text-xs text-text-muted">
              Optio polls the platform for open PRs on this repo that no Optio coding task opened
              (humans, Dependabot, Renovate, …) and spawns a review agent per the selected mode.
            </p>
            <div>
              <label className="block text-xs text-text-muted mb-1">Mode</label>
              <Segmented
                value={externalReviewMode}
                onChange={setExternalReviewMode}
                options={EXTERNAL_REVIEW_MODES}
              />
              <p className="text-[10px] text-text-muted/60 mt-1.5">
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
                      className={inputClass()}
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
                      className={inputClass()}
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
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-text-muted mb-1">Skip these labels</label>
                    <input
                      value={externalReviewExcludeLabels}
                      onChange={(e) => setExternalReviewExcludeLabels(e.target.value)}
                      placeholder="wip, skip-review"
                      className={inputClass()}
                    />
                  </div>
                </div>
              </div>
            )}
          </SectionCard>

          {repo && (
            <SharedDirectoriesSection repoId={repo.id} maxPodInstances={repo.maxPodInstances} />
          )}

          <SectionCard
            label="Connections"
            hint="External services for agents on this repo"
            summary={repoConnections.length > 0 ? `${repoConnections.length} assigned` : "none"}
            actions={
              <Link
                href="/connections"
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Plus className="w-3.5 h-3.5" />
                Manage Connections
              </Link>
            }
            bodyClassName="p-4 space-y-3"
          >
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
                        conn.enabled
                          ? "bg-green-500/10 text-green-400"
                          : "bg-bg-hover text-text-muted",
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
          </SectionCard>

          <SectionCard
            label="MCP servers"
            hint="Injected into the agent's .mcp.json"
            summary={mcpServers.length > 0 ? `${mcpServers.length} configured` : "none"}
            actions={
              <button
                onClick={() => setShowAddMcp(!showAddMcp)}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Server
              </button>
            }
            bodyClassName="p-4 space-y-3"
          >
            <p className="text-xs text-text-muted">
              MCP servers give agents access to databases, APIs, and other tools. Use{" "}
              <code className="text-primary">{"${{SECRET_NAME}}"}</code> to reference Optio secrets
              in args or env vars.
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
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        await api.updateMcpServer(server.id, { enabled: !server.enabled });
                        setMcpServers((prev) =>
                          prev.map((s) => (s.id === server.id ? { ...s, enabled: !s.enabled } : s)),
                        );
                      }}
                    >
                      {server.enabled ? "Disable" : "Enable"}
                    </Button>
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
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-text-muted mb-1">Command</label>
                    <input
                      value={newMcpCommand}
                      onChange={(e) => setNewMcpCommand(e.target.value)}
                      placeholder="npx"
                      className={inputClass()}
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
                    className={inputClass({ className: "text-xs font-mono resize-y" })}
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
                    className={inputClass({ className: "text-xs font-mono resize-y" })}
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
                    className={inputClass()}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowAddMcp(false);
                      setNewMcpName("");
                      setNewMcpCommand("");
                      setNewMcpArgs("");
                      setNewMcpEnv("");
                      setNewMcpInstallCmd("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
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
                  >
                    Add Server
                  </Button>
                </div>
              </div>
            )}
          </SectionCard>

          <SectionCard
            label="Custom skills"
            hint="Slash commands in .claude/commands/"
            summary={visibleSkills.length > 0 ? `${visibleSkills.length} skills` : "none"}
            actions={
              <button
                onClick={() => setShowAddSkill(!showAddSkill)}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Skill
              </button>
            }
            bodyClassName="p-4 space-y-3"
          >
            <p className="text-xs text-text-muted">
              Reusable prompt commands written before the agent starts; the agent can invoke them as
              slash commands.
            </p>
            {skills.filter((s: any) => s.scope === repo.repoUrl || s.scope === "global").length >
              0 && (
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
                          <p className="text-xs text-text-muted mt-0.5 truncate">
                            {skill.description}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          await api.updateSkill(skill.id, { enabled: !skill.enabled });
                          setSkills((prev) =>
                            prev.map((s) =>
                              s.id === skill.id ? { ...s, enabled: !s.enabled } : s,
                            ),
                          );
                        }}
                      >
                        {skill.enabled ? "Disable" : "Enable"}
                      </Button>
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
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-text-muted mb-1">Description</label>
                    <input
                      value={newSkillDescription}
                      onChange={(e) => setNewSkillDescription(e.target.value)}
                      placeholder="Run the full test suite"
                      className={inputClass()}
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
                    className={inputClass({ className: "text-xs font-mono resize-y" })}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowAddSkill(false);
                      setNewSkillName("");
                      setNewSkillDescription("");
                      setNewSkillPrompt("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
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
                  >
                    Add Skill
                  </Button>
                </div>
              </div>
            )}
          </SectionCard>

          <SectionCard
            label="Container image"
            hint="The base image for agent pods"
            summary={
              customDockerfile
                ? "custom Dockerfile"
                : (PRESET_IMAGES[imagePreset as PresetImageId]?.label ?? imagePreset)
            }
            bodyClassName="p-4 space-y-3"
          >
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
                className={inputClass()}
              />
            </div>

            <Disclosure
              open={showAdvanced}
              onToggle={() => setShowAdvanced(!showAdvanced)}
              label="Setup commands and custom Dockerfile"
            >
              <div className="space-y-4">
                {/* Setup commands */}
                <div>
                  <label className="block text-xs text-text-muted mb-1">Setup commands</label>
                  <p className="text-[10px] text-text-muted/60 mb-1.5">
                    Shell commands run inside the pod after cloning. Use this to install
                    dependencies, build tools, or configure the environment.
                  </p>
                  <textarea
                    value={setupCommands}
                    onChange={(e) => setSetupCommands(e.target.value)}
                    rows={4}
                    placeholder={"npm install\nnpx playwright install --with-deps\ncargo build"}
                    className={inputClass({
                      className: "text-xs font-mono resize-y leading-relaxed",
                    })}
                  />
                </div>

                {/* Custom Dockerfile */}
                <div>
                  <label className="block text-xs text-text-muted mb-1">Custom Dockerfile</label>
                  <p className="text-[10px] text-text-muted/60 mb-1.5">
                    Full Dockerfile override. When set, this is used instead of the preset image.
                    Must include all tools the agent needs (git, node, claude-code, gh).
                  </p>
                  <textarea
                    value={customDockerfile}
                    onChange={(e) => setCustomDockerfile(e.target.value)}
                    rows={8}
                    placeholder={
                      "FROM ubuntu:24.04\nRUN apt-get update && apt-get install -y git curl nodejs\nRUN npm install -g @anthropic-ai/claude-code\n# Add your custom tools here"
                    }
                    className={inputClass({
                      className: "text-xs font-mono resize-y leading-relaxed",
                    })}
                  />
                  {customDockerfile && (
                    <p className="text-[10px] text-warning mt-1">
                      Custom Dockerfile is set — the preset image above will be ignored. You must
                      rebuild the image manually.
                    </p>
                  )}
                </div>
              </div>
            </Disclosure>
          </SectionCard>

          <SectionCard
            label="Prompt template"
            hint="What the coding agent is told"
            summary={useCustomPrompt ? "custom for this repo" : "global default"}
            bodyClassName="p-4 space-y-3"
          >
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
                  className={inputClass({
                    className: "text-xs font-mono resize-y leading-relaxed",
                  })}
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
                      <span className="text-text-muted">
                        Git branch name the agent is working on
                      </span>
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
          </SectionCard>

          {/* Actions */}
          <div className="flex items-center justify-between">
            <Button variant="danger" onClick={handleDelete}>
              <Trash2 />
              Remove Repo
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              {saving ? "Saving..." : "Save Settings"}
            </Button>
          </div>
        </div>
      </div>
    </>
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
