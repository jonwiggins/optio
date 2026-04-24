"use client";

import { useState } from "react";
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
import Link from "next/link";
import { AgentOptionsPicker, type AgentOptionsValues } from "@/components/agent-options-picker";
import { ANTHROPIC_CATALOG, resolveModelId } from "@optio/shared";

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
  const [claudeModel, setClaudeModel] = useState("opus");
  const [claudeContextWindow, setClaudeContextWindow] = useState("1m");
  const [claudeThinking, setClaudeThinking] = useState(true);
  const [claudeEffort, setClaudeEffort] = useState("high");
  const [maxTurnsCoding, setMaxTurnsCoding] = useState(250);
  const [maxConcurrentTasks, setMaxConcurrentTasks] = useState(2);

  // Step 4: Review
  const [reviewEnabled, setReviewEnabled] = useState(false);
  const [reviewTrigger, setReviewTrigger] = useState("on_ci_pass");
  const [reviewModel, setReviewModel] = useState("sonnet");
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
        claudeModel,
        claudeContextWindow,
        claudeThinking,
        claudeEffort,
        maxTurnsCoding,
        maxConcurrentTasks,
        reviewEnabled,
        reviewTrigger,
        testCommand: testCommand || undefined,
        reviewModel,
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

  const inputClass =
    "w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20";
  const selectClass = inputClass;

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link href="/repos" className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <FolderGit2 className="w-5 h-5 text-text-muted" />
        <h1 className="text-2xl font-semibold tracking-tight">Add Repository</h1>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-1 mb-8">
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
            setRepoUrl={setRepoUrl}
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
            claudeModel={claudeModel}
            setClaudeModel={setClaudeModel}
            claudeContextWindow={claudeContextWindow}
            setClaudeContextWindow={setClaudeContextWindow}
            claudeThinking={claudeThinking}
            setClaudeThinking={setClaudeThinking}
            claudeEffort={claudeEffort}
            setClaudeEffort={setClaudeEffort}
            maxTurnsCoding={maxTurnsCoding}
            setMaxTurnsCoding={setMaxTurnsCoding}
            maxConcurrentTasks={maxConcurrentTasks}
            setMaxConcurrentTasks={setMaxConcurrentTasks}
            selectClass={selectClass}
            inputClass={inputClass}
          />
        )}

        {currentStep.id === "review" && (
          <ReviewStep
            reviewEnabled={reviewEnabled}
            setReviewEnabled={setReviewEnabled}
            reviewTrigger={reviewTrigger}
            setReviewTrigger={setReviewTrigger}
            reviewModel={reviewModel}
            setReviewModel={setReviewModel}
            testCommand={testCommand}
            setTestCommand={setTestCommand}
            autoResume={autoResume}
            setAutoResume={setAutoResume}
            autoMerge={autoMerge}
            setAutoMerge={setAutoMerge}
            selectClass={selectClass}
            inputClass={inputClass}
          />
        )}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between mt-8 pt-6 border-t border-border/50">
        <button
          onClick={back}
          disabled={stepIndex === 0}
          className="flex items-center gap-2 px-4 py-2 rounded-md text-sm text-text-muted hover:bg-bg-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>

        <button
          onClick={next}
          disabled={!canAdvance() || creating}
          className="flex items-center gap-2 px-5 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover disabled:opacity-50 transition-colors"
        >
          {creating ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" /> Creating...
            </>
          ) : stepIndex === STEPS.length - 1 ? (
            <>
              <Check className="w-4 h-4" /> Create Repository
            </>
          ) : (
            <>
              Continue <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </div>
    </div>
  );
}

/* ── Step 1: Repository URL ─────────────────────────────────── */

function RepoStep({
  repoUrl,
  setRepoUrl,
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
    <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-4">
      <div>
        <h2 className="text-sm font-medium mb-1">Repository URL</h2>
        <p className="text-xs text-text-muted">
          Paste a GitHub repository URL. Optio will fetch the repo metadata automatically.
        </p>
      </div>

      <div className="flex gap-2">
        <input
          value={repoUrl}
          onChange={(e) => {
            setRepoUrl(e.target.value);
            if (validated) {
              // Reset validation when URL changes — but don't clear fields
            }
          }}
          onKeyDown={(e) => e.key === "Enter" && onValidate()}
          placeholder="https://github.com/owner/repo"
          className={cn(inputClass, "flex-1")}
          autoFocus
        />
        <button
          onClick={onValidate}
          disabled={validating || !repoUrl.trim()}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm hover:bg-primary-hover disabled:opacity-50 transition-colors shrink-0"
        >
          {validating ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Search className="w-4 h-4" />
          )}
          {validating ? "Checking..." : "Validate"}
        </button>
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
    </section>
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
    <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-4">
      <div>
        <h2 className="text-sm font-medium mb-1">Container Image</h2>
        <p className="text-xs text-text-muted">
          Choose the base image for agent pods working on this repo.
          {detected && " Auto-detected from repository contents."}
        </p>
      </div>

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

      <button
        onClick={() => setShowAdvanced(!showAdvanced)}
        className="text-xs text-primary hover:underline"
      >
        {showAdvanced ? "Hide advanced options" : "Show advanced options"}
      </button>

      {showAdvanced && (
        <div className="space-y-4 pt-2 border-t border-border">
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
        </div>
      )}
    </section>
  );
}

/* ── Step 3: Agent Settings ─────────────────────────────────── */

function AgentStep({
  claudeModel,
  setClaudeModel,
  claudeContextWindow,
  setClaudeContextWindow,
  claudeThinking,
  setClaudeThinking,
  claudeEffort,
  setClaudeEffort,
  maxTurnsCoding,
  setMaxTurnsCoding,
  maxConcurrentTasks,
  setMaxConcurrentTasks,
  selectClass,
  inputClass,
}: {
  claudeModel: string;
  setClaudeModel: (v: string) => void;
  claudeContextWindow: string;
  setClaudeContextWindow: (v: string) => void;
  claudeThinking: boolean;
  setClaudeThinking: (v: boolean) => void;
  claudeEffort: string;
  setClaudeEffort: (v: string) => void;
  maxTurnsCoding: number;
  setMaxTurnsCoding: (v: number) => void;
  maxConcurrentTasks: number;
  setMaxConcurrentTasks: (v: number) => void;
  selectClass: string;
  inputClass: string;
}) {
  return (
    <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-4">
      <div>
        <h2 className="text-sm font-medium mb-1">Agent Settings</h2>
        <p className="text-xs text-text-muted">
          Configure the Claude Code model and behavior for this repo.
        </p>
      </div>

      <AgentOptionsPicker
        provider="anthropic"
        values={{
          claudeModel,
          claudeContextWindow,
          claudeEffort,
          claudeThinking,
        }}
        onChange={(v: AgentOptionsValues) => {
          if (typeof v.claudeModel === "string") setClaudeModel(v.claudeModel);
          if (typeof v.claudeContextWindow === "string")
            setClaudeContextWindow(v.claudeContextWindow);
          if (typeof v.claudeEffort === "string") setClaudeEffort(v.claudeEffort);
          if (typeof v.claudeThinking === "boolean") setClaudeThinking(v.claudeThinking);
        }}
        inputClass={selectClass}
      />

      <div className="grid grid-cols-2 gap-4">
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
    </section>
  );
}

/* ── Step 4: PR Lifecycle ───────────────────────────────────── */

function ReviewStep({
  reviewEnabled,
  setReviewEnabled,
  reviewTrigger,
  setReviewTrigger,
  reviewModel,
  setReviewModel,
  testCommand,
  setTestCommand,
  autoResume,
  setAutoResume,
  autoMerge,
  setAutoMerge,
  selectClass,
  inputClass,
}: {
  reviewEnabled: boolean;
  setReviewEnabled: (v: boolean) => void;
  reviewTrigger: string;
  setReviewTrigger: (v: string) => void;
  reviewModel: string;
  setReviewModel: (v: string) => void;
  testCommand: string;
  setTestCommand: (v: string) => void;
  autoResume: boolean;
  setAutoResume: (v: boolean) => void;
  autoMerge: boolean;
  setAutoMerge: (v: boolean) => void;
  selectClass: string;
  inputClass: string;
}) {
  return (
    <section className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-5">
      <div>
        <h2 className="text-sm font-medium mb-1">PR Lifecycle</h2>
        <p className="text-xs text-text-muted">
          Configure what happens after the coding agent opens a pull request. These settings can be
          changed later.
        </p>
      </div>

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
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-text-muted mb-1">Trigger</label>
                <select
                  value={reviewTrigger}
                  onChange={(e) => setReviewTrigger(e.target.value)}
                  className={selectClass}
                >
                  <option value="on_ci_pass">After CI passes</option>
                  <option value="on_pr">Immediately on PR open</option>
                  <option value="manual">Manual only</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">Review Model</label>
                <select
                  value={reviewModel}
                  onChange={(e) => setReviewModel(e.target.value)}
                  className={selectClass}
                >
                  {Object.keys(ANTHROPIC_CATALOG.aliases).map((alias) => {
                    const id = resolveModelId("anthropic", alias);
                    const label = ANTHROPIC_CATALOG.models.find((m) => m.id === id)?.label ?? alias;
                    return (
                      <option key={alias} value={alias}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>
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
    </section>
  );
}
