"use client";

import { useState } from "react";
import { FORM_WIDTH } from "@/components/ui/page";
import { useRouter } from "next/navigation";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import { NumberInput } from "@/components/number-input";
import { toast } from "sonner";
import { PRESET_IMAGES, type PresetImageId } from "@optio/shared";
import {
  Loader2,
  ArrowLeft,
  ArrowRight,
  Check,
  FolderGit2,
  Lock,
  Globe,
  Search,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentOptionsValues } from "@/components/agent-options-picker";
import type { AgentType } from "@optio/shared";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import { Disclosure } from "@/components/ui/disclosure";
import { AgentChoice, ReviewAgentChoice } from "@/components/agent-choice";
import {
  REPO_FACTORY_AGENT,
  REPO_FACTORY_OPTIONS,
  agentSummary,
  repoAgentPatch,
} from "@/components/agent-choice-model";
import { GitHubRepoBrowser } from "@/components/github-repo-browser";
import { Button, ButtonLink } from "@/components/ui/button";
import { inputClass as fieldClass } from "@/components/ui/input";

const STEPS = [
  { id: "repo", label: "Repository" },
  { id: "image", label: "Container" },
  { id: "agent", label: "Agent" },
  { id: "review", label: "PR Lifecycle" },
] as const;

type StepId = (typeof STEPS)[number]["id"];

export default function NewRepoPage() {
  usePageTitle("Add Repository");
  const router = useRouter();
  const [stepIndex, setStepIndex] = useState(0);
  const currentStep = STEPS[stepIndex];

  // Step 1: Repo
  const [repoUrl, setRepoUrl] = useState("");
  const [fullName, setFullName] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [isPrivate, setIsPrivate] = useState(false);
  const [validated, setValidated] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationError, setValidationError] = useState("");

  // Step 2: Image
  const [imagePreset, setImagePreset] = useState("base");
  const [extraPackages, setExtraPackages] = useState("");
  const [setupCommands, setSetupCommands] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [detected, setDetected] = useState(false);

  // Step 3: Agent
  const [agentType, setAgentType] = useState(REPO_FACTORY_AGENT);
  const [agentValues, setAgentValues] = useState<AgentOptionsValues>({ ...REPO_FACTORY_OPTIONS });
  const [maxTurnsCoding, setMaxTurnsCoding] = useState(250);
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(2);

  // Step 4: Review
  const [reviewEnabled, setReviewEnabled] = useState(false);
  const [reviewTrigger, setReviewTrigger] = useState("on_ci_pass");
  // null = inherit from repo's defaultAgentType / global setting.
  const [reviewAgentType, setReviewAgentType] = useState<AgentType | null>(null);
  const [reviewModel, setReviewModel] = useState("");
  const [testCommand, setTestCommand] = useState("");
  const [autoResume, setAutoResume] = useState(false);
  const [autoMerge, setAutoMerge] = useState(false);

  // Creating
  const [creating, setCreating] = useState(false);

  const validateRepo = async () => {
    if (!repoUrl.trim()) return;
    setValidating(true);
    setValidationError("");
    setValidated(false);
    try {
      // Try to get GitHub token from secrets for private repos
      let token: string | undefined;
      try {
        const secrets = await api.listSecrets("global");
        const ghSecret = secrets.secrets.find((s: any) => s.name === "GITHUB_TOKEN");
        if (ghSecret) {
          // Token exists but we can't read the value — the validate endpoint will use it server-side
          token = undefined;
        }
      } catch {
        // No secrets access, that's fine
      }

      const res = await api.validateRepo(repoUrl, token);
      if (res.valid && res.repo) {
        setFullName(res.repo.fullName);
        setDefaultBranch(res.repo.defaultBranch);
        setIsPrivate(res.repo.isPrivate);
        setValidated(true);
      } else {
        setValidationError(res.error || "Could not access repository");
      }
    } catch {
      setValidationError("Failed to validate repository");
    } finally {
      setValidating(false);
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await api.createRepoConfig({
        repoUrl,
        fullName,
        defaultBranch,
        isPrivate,
      });
      const repoId = res.repo.id;

      // Update with all the settings
      await api.updateRepo(repoId, {
        imagePreset,
        extraPackages: extraPackages || undefined,
        setupCommands: setupCommands || undefined,
        ...repoAgentPatch(agentType, agentValues),
        maxTurnsCoding,
        maxConcurrentTasks,
        reviewEnabled,
        reviewTrigger,
        testCommand: testCommand || undefined,
        reviewAgentType,
        reviewModel: reviewModel || undefined,
        autoResume,
        autoMerge,
      });

      toast.success(`${fullName} added successfully`);
      router.push(`/repos/${repoId}`);
    } catch (err) {
      toast.error("Failed to create repository");
    } finally {
      setCreating(false);
    }
  };

  const canAdvance = (): boolean => {
    switch (currentStep.id) {
      case "repo":
        return validated;
      case "image":
      case "agent":
      case "review":
        return true;
      default:
        return true;
    }
  };

  const next = () => {
    if (stepIndex < STEPS.length - 1) {
      setStepIndex(stepIndex + 1);
    } else {
      handleCreate();
    }
  };

  const back = () => {
    if (stepIndex > 0) setStepIndex(stepIndex - 1);
  };

  const inputClass = fieldClass();

  return (
    <div className="page-column py-6">
      <PageHeader
        icon={FolderGit2}
        title="Add Repository"
        description="Point Optio at a repository, then pick its container, agent, and what happens to the PRs it opens."
        actions={
          <ButtonLink variant="ghost" href="/repos">
            <ArrowLeft /> Repos
          </ButtonLink>
        }
      />

      <div className={FORM_WIDTH}>
        {/* Step indicator */}
        <div className="flex items-center gap-1 mb-6">
          {STEPS.map((step, i) => (
            <div key={step.id} className="flex items-center gap-1 flex-1">
              <button
                onClick={() => i < stepIndex && setStepIndex(i)}
                disabled={i > stepIndex}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                  i === stepIndex
                    ? "bg-primary text-white"
                    : i < stepIndex
                      ? "bg-primary/10 text-primary cursor-pointer hover:bg-primary/20"
                      : "bg-bg-hover text-text-muted",
                )}
              >
                {i < stepIndex ? <Check className="w-3 h-3" /> : <span>{i + 1}</span>}
                {step.label}
              </button>
              {i < STEPS.length - 1 && <div className="flex-1 h-px bg-border mx-1" />}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="space-y-6">
          {currentStep.id === "repo" && (
            <RepoStep
              repoUrl={repoUrl}
              setRepoUrl={(v) => {
                setRepoUrl(v);
                // A different URL needs validating again.
                setValidated(false);
                setValidationError("");
              }}
              onPick={(r) => {
                // The picked repo's metadata comes from GitHub already.
                setRepoUrl(r.htmlUrl);
                setFullName(r.fullName);
                setDefaultBranch(r.defaultBranch);
                setIsPrivate(r.isPrivate);
                setValidationError("");
                setValidated(true);
              }}
              fullName={fullName}
              defaultBranch={defaultBranch}
              isPrivate={isPrivate}
              validated={validated}
              validating={validating}
              validationError={validationError}
              onValidate={validateRepo}
              inputClass={inputClass}
            />
          )}

          {currentStep.id === "image" && (
            <ImageStep
              imagePreset={imagePreset}
              setImagePreset={setImagePreset}
              extraPackages={extraPackages}
              setExtraPackages={setExtraPackages}
              setupCommands={setupCommands}
              setSetupCommands={setSetupCommands}
              showAdvanced={showAdvanced}
              setShowAdvanced={setShowAdvanced}
              detected={detected}
              inputClass={inputClass}
            />
          )}

          {currentStep.id === "agent" && (
            <AgentStep
              agentType={agentType}
              setAgentType={setAgentType}
              agentValues={agentValues}
              setAgentValues={setAgentValues}
              maxTurnsCoding={maxTurnsCoding}
              setMaxTurnsCoding={setMaxTurnsCoding}
              maxConcurrentTasks={maxConcurrentTasks}
              setMaxConcurrentTasks={setMaxConcurrentTasks}
              inputClass={inputClass}
            />
          )}

          {currentStep.id === "review" && (
            <ReviewStep
              reviewEnabled={reviewEnabled}
              setReviewEnabled={setReviewEnabled}
              reviewTrigger={reviewTrigger}
              setReviewTrigger={setReviewTrigger}
              reviewAgentType={reviewAgentType}
              setReviewAgentType={setReviewAgentType}
              reviewModel={reviewModel}
              setReviewModel={setReviewModel}
              testCommand={testCommand}
              setTestCommand={setTestCommand}
              autoResume={autoResume}
              setAutoResume={setAutoResume}
              autoMerge={autoMerge}
              setAutoMerge={setAutoMerge}
              inputClass={inputClass}
            />
          )}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between mt-6">
          <Button variant="ghost" onClick={back} disabled={stepIndex === 0}>
            <ArrowLeft /> Back
          </Button>

          <Button onClick={next} disabled={!canAdvance() || creating}>
            {creating ? (
              <>
                <Loader2 className="animate-spin" /> Creating...
              </>
            ) : stepIndex === STEPS.length - 1 ? (
              <>
                <Check /> Create Repository
              </>
            ) : (
              <>
                Continue <ArrowRight />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Step 1: Repository URL ─────────────────────────────────── */

function RepoStep({
  repoUrl,
  setRepoUrl,
  onPick,
  fullName,
  defaultBranch,
  isPrivate,
  validated,
  validating,
  validationError,
  onValidate,
  inputClass,
}: {
  repoUrl: string;
  setRepoUrl: (v: string) => void;
  onPick: (repo: {
    fullName: string;
    htmlUrl: string;
    defaultBranch: string;
    isPrivate: boolean;
  }) => void;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  validated: boolean;
  validating: boolean;
  validationError: string;
  onValidate: () => void;
  inputClass: string;
}) {
  return (
    <SectionCard
      step={1}
      label="Repository"
      hint="Pick one or paste a URL"
      summary={validated ? fullName : undefined}
      bodyClassName="p-4 space-y-4"
    >
      <p className="text-xs text-text-muted">
        Pick one of the repositories Optio's GitHub credentials can access, or paste any repository
        URL. Optio will fetch the repo metadata automatically.
      </p>

      <GitHubRepoBrowser selected={validated ? fullName : null} onPick={onPick} />

      <div className="flex gap-2">
        <input
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onValidate()}
          placeholder="https://github.com/owner/repo"
          className={cn(inputClass, "flex-1")}
          aria-label="Repository URL"
        />
        <Button onClick={onValidate} disabled={validating || !repoUrl.trim()} className="shrink-0">
          {validating ? <Loader2 className="animate-spin" /> : <Search />}
          {validating ? "Checking..." : "Validate"}
        </Button>
      </div>

      {validationError && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-error/10 border border-error/20">
          <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
          <p className="text-sm text-error">{validationError}</p>
        </div>
      )}

      {validated && (
        <div className="p-4 rounded-lg bg-success/5 border border-success/20 space-y-2">
          <div className="flex items-center gap-2">
            <Check className="w-4 h-4 text-success" />
            <span className="text-sm font-medium">{fullName}</span>
            {isPrivate ? (
              <Lock className="w-3.5 h-3.5 text-text-muted" />
            ) : (
              <Globe className="w-3.5 h-3.5 text-text-muted" />
            )}
          </div>
          <div className="flex items-center gap-4 text-xs text-text-muted ml-6">
            <span>
              Branch: <strong>{defaultBranch}</strong>
            </span>
            <span>{isPrivate ? "Private" : "Public"}</span>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

/* ── Step 2: Container Image ────────────────────────────────── */

function ImageStep({
  imagePreset,
  setImagePreset,
  extraPackages,
  setExtraPackages,
  setupCommands,
  setSetupCommands,
  showAdvanced,
  setShowAdvanced,
  detected,
  inputClass,
}: {
  imagePreset: string;
  setImagePreset: (v: string) => void;
  extraPackages: string;
  setExtraPackages: (v: string) => void;
  setupCommands: string;
  setSetupCommands: (v: string) => void;
  showAdvanced: boolean;
  setShowAdvanced: (v: boolean) => void;
  detected: boolean;
  inputClass: string;
}) {
  return (
    <SectionCard
      step={2}
      label="Container"
      hint={
        detected
          ? "Auto-detected from repository contents"
          : "The base image for agent pods on this repo"
      }
      summary={PRESET_IMAGES[imagePreset as PresetImageId]?.label ?? imagePreset}
      bodyClassName="p-4 space-y-4"
    >
      <div className="grid gap-1.5">
        {(
          Object.entries(PRESET_IMAGES) as [PresetImageId, (typeof PRESET_IMAGES)[PresetImageId]][]
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
          className={inputClass}
        />
      </div>

      <Disclosure
        open={showAdvanced}
        onToggle={() => setShowAdvanced(!showAdvanced)}
        label="Setup commands"
      >
        <div>
          <label className="block text-xs text-text-muted mb-1">Setup commands</label>
          <p className="text-[10px] text-text-muted/60 mb-1.5">
            Shell commands run inside the pod after cloning. Use this to install dependencies, build
            tools, or configure the environment.
          </p>
          <textarea
            value={setupCommands}
            onChange={(e) => setSetupCommands(e.target.value)}
            rows={4}
            placeholder={"npm install\nnpx playwright install --with-deps\ncargo build"}
            className={fieldClass({ className: "text-xs font-mono resize-y leading-relaxed" })}
          />
        </div>
      </Disclosure>
    </SectionCard>
  );
}

/* ── Step 3: Agent Settings ─────────────────────────────────── */

function AgentStep({
  agentType,
  setAgentType,
  agentValues,
  setAgentValues,
  maxTurnsCoding,
  setMaxTurnsCoding,
  maxConcurrentTasks,
  setMaxConcurrentTasks,
  inputClass,
}: {
  agentType: string;
  setAgentType: (v: string) => void;
  agentValues: AgentOptionsValues;
  setAgentValues: (v: AgentOptionsValues) => void;
  maxTurnsCoding: number;
  setMaxTurnsCoding: (v: number) => void;
  maxConcurrentTasks: number;
  setMaxConcurrentTasks: (v: number) => void;
  inputClass: string;
}) {
  return (
    <SectionCard
      step={3}
      label="Agent"
      hint="New work on this repo starts from these"
      summary={agentSummary(agentType, agentValues)}
      bodyClassName="p-4 space-y-4"
    >
      <AgentChoice
        aria-label="Default agent"
        runtime={agentType}
        agentOptions={agentValues}
        onRuntimeChange={setAgentType}
        onOptionsChange={setAgentValues}
        note="The default for new work with this repo — anyone can change it per run."
        paramsHint="Saved as this repo's defaults"
        paramsNote={
          agentType === "codex"
            ? "OpenAI Codex uses its built-in defaults. No per-repo configuration is required."
            : undefined
        }
      />

      <div className="grid grid-cols-2 gap-4 pt-3 border-t border-border">
        <div>
          <label className="block text-xs text-text-muted mb-1">Max Turns</label>
          <NumberInput
            min={1}
            max={1000}
            value={maxTurnsCoding}
            onChange={(v) => setMaxTurnsCoding(v)}
            fallback={250}
            placeholder="250"
            className={inputClass}
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Max Concurrent Tasks</label>
          <NumberInput
            min={1}
            max={50}
            value={maxConcurrentTasks}
            onChange={(v) => setMaxConcurrentTasks(v)}
            fallback={2}
            className={inputClass}
          />
        </div>
      </div>
    </SectionCard>
  );
}

/* ── Step 4: PR Lifecycle ───────────────────────────────────── */

function ReviewStep({
  reviewEnabled,
  setReviewEnabled,
  reviewTrigger,
  setReviewTrigger,
  reviewAgentType,
  setReviewAgentType,
  reviewModel,
  setReviewModel,
  testCommand,
  setTestCommand,
  autoResume,
  setAutoResume,
  autoMerge,
  setAutoMerge,
  inputClass,
}: {
  reviewEnabled: boolean;
  setReviewEnabled: (v: boolean) => void;
  reviewTrigger: string;
  setReviewTrigger: (v: string) => void;
  reviewAgentType: AgentType | null;
  setReviewAgentType: (v: AgentType | null) => void;
  reviewModel: string;
  setReviewModel: (v: string) => void;
  testCommand: string;
  setTestCommand: (v: string) => void;
  autoResume: boolean;
  setAutoResume: (v: boolean) => void;
  autoMerge: boolean;
  setAutoMerge: (v: boolean) => void;
  inputClass: string;
}) {
  return (
    <SectionCard
      step={4}
      label="PR lifecycle"
      hint="Can be changed later"
      summary={
        [reviewEnabled && "review", autoResume && "auto-resume", autoMerge && "auto-merge"]
          .filter(Boolean)
          .join(" · ") || "opens the PR, then waits"
      }
      bodyClassName="p-4 space-y-5"
    >
      <p className="text-xs text-text-muted">
        What happens after the coding agent opens a pull request.
      </p>

      {/* Code Review */}
      <div className="space-y-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={reviewEnabled}
            onChange={(e) => setReviewEnabled(e.target.checked)}
            className="w-4 h-4 rounded"
          />
          <span className="text-sm">Enable automatic code review</span>
        </label>

        {reviewEnabled && (
          <div className="space-y-3 ml-6 pl-4 border-l-2 border-primary/20">
            <div>
              <label className="block text-xs text-text-muted mb-1">Trigger</label>
              <Segmented
                value={reviewTrigger}
                onChange={setReviewTrigger}
                options={[
                  { value: "on_ci_pass", label: "After CI passes" },
                  { value: "on_pr", label: "On PR open" },
                  { value: "manual", label: "Manual only" },
                ]}
              />
            </div>

            <ReviewAgentChoice
              agentType={reviewAgentType}
              model={reviewModel}
              onChange={(agentType, model) => {
                setReviewAgentType(agentType);
                setReviewModel(model);
              }}
              inheritedHint="Reviews will run with the repo's default agent unless overridden."
            />

            <div>
              <label className="block text-xs text-text-muted mb-1">Test command</label>
              <input
                value={testCommand}
                onChange={(e) => setTestCommand(e.target.value)}
                placeholder="npm test, cargo test, pytest"
                className={inputClass}
              />
              <p className="text-[10px] text-text-muted/60 mt-1">
                Leave empty if CI handles testing.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Auto-resume */}
      <div>
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
      </div>

      {/* Auto-merge */}
      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={autoMerge}
            onChange={(e) => setAutoMerge(e.target.checked)}
            className="w-4 h-4 rounded"
          />
          <span className="text-sm">Auto-merge PR when checks pass and review completes</span>
        </label>
      </div>
    </SectionCard>
  );
}
