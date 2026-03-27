"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Zap,
  Github,
  Key,
  GitBranch,
  Ticket,
  CheckCircle,
  Loader2,
  ArrowRight,
  ArrowLeft,
  AlertCircle,
  Check,
  Plus,
  ExternalLink,
  FileText,
} from "lucide-react";

const STEPS = [
  { id: "welcome", label: "Welcome", icon: Zap },
  { id: "github", label: "GitHub", icon: Github },
  { id: "agents", label: "Agent Keys", icon: Key },
  { id: "repos", label: "Repositories", icon: GitBranch },
  { id: "prompt", label: "Prompt", icon: FileText },
  { id: "tickets", label: "Tickets", icon: Ticket },
  { id: "done", label: "Done", icon: CheckCircle },
];

interface RepoEntry {
  url: string;
  fullName?: string;
  defaultBranch?: string;
  isPrivate?: boolean;
  validated: boolean;
}

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);

  // Step 1: Runtime health
  const [runtimeHealthy, setRuntimeHealthy] = useState<boolean | null>(null);

  // Step 2: GitHub token
  const [githubToken, setGithubToken] = useState("");
  const [githubUser, setGithubUser] = useState<{ login: string; name: string } | null>(null);
  const [githubValidated, setGithubValidated] = useState(false);
  const [githubError, setGithubError] = useState("");

  // Step 3: Agent keys
  const [anthropicKey, setAnthropicKey] = useState("");
  const [anthropicValidated, setAnthropicValidated] = useState(false);
  const [anthropicError, setAnthropicError] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiValidated, setOpenaiValidated] = useState(false);
  const [openaiError, setOpenaiError] = useState("");

  // Step 3: Claude auth mode
  const [claudeAuthMode, setClaudeAuthMode] = useState<"api-key" | "oauth-token">("oauth-token");
  const [oauthToken, setOauthToken] = useState("");
  const [oauthTokenDetected, setOauthTokenDetected] = useState(false);
  const [oauthChecking, setOauthChecking] = useState(false);
  const [showManualPaste, setShowManualPaste] = useState(false);

  // Step 4: Repos
  const [repos, setRepos] = useState<RepoEntry[]>([]);
  const [suggestedRepos, setSuggestedRepos] = useState<
    Array<{
      fullName: string;
      cloneUrl: string;
      defaultBranch: string;
      isPrivate: boolean;
      description: string | null;
      language: string | null;
      pushedAt: string;
    }>
  >([]);
  const [suggestedLoading, setSuggestedLoading] = useState(false);
  const [manualRepoUrl, setManualRepoUrl] = useState("");
  const validatingUrlsRef = useRef<Set<string>>(new Set());

  // Step 5: Prompt template
  const [promptTemplate, setPromptTemplate] = useState("");
  const [autoMerge, setAutoMerge] = useState(false);
  const [promptLoading, setPromptLoading] = useState(false);

  // Step 6: Tickets
  const [enableTickets, setEnableTickets] = useState(false);
  const [ticketOwner, setTicketOwner] = useState("");
  const [ticketRepo, setTicketRepo] = useState("");

  // Check runtime on mount
  useEffect(() => {
    api
      .getHealth()
      .then((res) => setRuntimeHealthy(res.healthy))
      .catch(() => setRuntimeHealthy(false));
  }, []);

  // Check if OAuth token is already stored when reaching the agents step
  useEffect(() => {
    if (step === 2) {
      checkOauthToken();
    }
  }, [step]);

  // Fetch suggested repos when reaching the repos step
  useEffect(() => {
    if (currentStep?.id === "repos" && githubToken && suggestedRepos.length === 0) {
      setSuggestedLoading(true);
      api
        .listUserRepos(githubToken)
        .then((res) => setSuggestedRepos(res.repos.slice(0, 8)))
        .catch(() => {})
        .finally(() => setSuggestedLoading(false));
    }
  }, [step]);

  useEffect(() => {
    if (currentStep?.id === "prompt" && !promptTemplate) {
      setPromptLoading(true);
      api
        .getBuiltinDefault()
        .then((res) => setPromptTemplate(res.template))
        .catch(() => {})
        .finally(() => setPromptLoading(false));
    }
  }, [step]);

  const claudeReady =
    claudeAuthMode === "oauth-token"
      ? oauthTokenDetected || oauthToken.trim().length > 0
      : anthropicValidated;

  const currentStep = STEPS[step];

  const goNext = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const goBack = () => setStep((s) => Math.max(s - 1, 0));

  // Validators
  const validateGithub = async (tokenOverride?: string) => {
    const token = tokenOverride ?? githubToken;
    if (!token.trim()) return;
    setLoading(true);
    setGithubError("");
    try {
      const res = await api.validateGithubToken(token);
      if (res.valid && res.user) {
        setGithubUser(res.user);
        setGithubValidated(true);
      } else {
        setGithubError(res.error ?? "Invalid token");
      }
    } catch (err) {
      setGithubError(err instanceof Error ? err.message : "Validation failed");
    }
    setLoading(false);
  };

  const validateAnthropic = async (keyOverride?: string) => {
    const key = keyOverride ?? anthropicKey;
    if (!key.trim()) return;
    setLoading(true);
    setAnthropicError("");
    try {
      const res = await api.validateAnthropicKey(key);
      if (res.valid) {
        setAnthropicValidated(true);
      } else {
        setAnthropicError(res.error ?? "Invalid key");
      }
    } catch (err) {
      setAnthropicError(err instanceof Error ? err.message : "Validation failed");
    }
    setLoading(false);
  };

  const validateOpenai = async (keyOverride?: string) => {
    const key = keyOverride ?? openaiKey;
    if (!key.trim()) return;
    setLoading(true);
    setOpenaiError("");
    try {
      const res = await api.validateOpenAIKey(key);
      if (res.valid) {
        setOpenaiValidated(true);
      } else {
        setOpenaiError(res.error ?? "Invalid key");
      }
    } catch (err) {
      setOpenaiError(err instanceof Error ? err.message : "Validation failed");
    }
    setLoading(false);
  };

  const checkOauthToken = async () => {
    setOauthChecking(true);
    try {
      const res = await api.getAuthStatus();
      if (res.subscription.available) {
        setOauthTokenDetected(true);
        setClaudeAuthMode("oauth-token");
      }
    } catch {}
    setOauthChecking(false);
  };

  const validateRepo = async (repoUrl: string) => {
    if (!repoUrl.trim()) return;
    setLoading(true);
    try {
      const res = await api.validateRepo(repoUrl, githubToken || undefined);
      if (res.valid && res.repo) {
        setRepos((prev) =>
          prev.map((r) =>
            r.url === repoUrl
              ? {
                  ...r,
                  fullName: res.repo!.fullName,
                  defaultBranch: res.repo!.defaultBranch,
                  isPrivate: res.repo!.isPrivate,
                  validated: true,
                }
              : r,
          ),
        );
      } else {
        toast.error(res.error ?? "Could not access repository");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Validation failed");
    }
    setLoading(false);
  };

  // Validate newly added repos when repos state changes
  useEffect(() => {
    for (const repo of repos) {
      if (!repo.validated && !validatingUrlsRef.current.has(repo.url)) {
        validatingUrlsRef.current.add(repo.url);
        validateRepo(repo.url);
      }
    }
  }, [repos]);

  // Save step: store all secrets and config
  const saveGithubStep = async () => {
    setLoading(true);
    try {
      await api.createSecret({ name: "GITHUB_TOKEN", value: githubToken });
      goNext();
    } catch (err) {
      toast.error("Failed to save GitHub token");
    }
    setLoading(false);
  };

  const saveAgentKeysStep = async () => {
    setLoading(true);
    try {
      // Save Claude auth mode as a secret so the worker knows which mode to use
      await api.createSecret({ name: "CLAUDE_AUTH_MODE", value: claudeAuthMode });

      if (claudeAuthMode === "api-key" && anthropicKey.trim() && anthropicValidated) {
        await api.createSecret({ name: "ANTHROPIC_API_KEY", value: anthropicKey });
      }
      if (claudeAuthMode === "oauth-token" && oauthToken.trim()) {
        await api.createSecret({ name: "CLAUDE_CODE_OAUTH_TOKEN", value: oauthToken });
      }
      if (openaiKey.trim() && openaiValidated) {
        await api.createSecret({ name: "OPENAI_API_KEY", value: openaiKey });
      }
      goNext();
    } catch (err) {
      toast.error("Failed to save API keys");
    } finally {
      setLoading(false);
    }
  };

  const saveReposStep = async () => {
    setLoading(true);
    try {
      for (const repo of repos) {
        if (repo.fullName && repo.url) {
          await api.createRepoConfig({
            repoUrl: repo.url,
            fullName: repo.fullName,
            defaultBranch: repo.defaultBranch,
            isPrivate: repo.isPrivate,
          });
        }
      }
      goNext();
    } catch (err) {
      toast.error("Failed to save repos");
    } finally {
      setLoading(false);
    }
  };

  const savePromptStep = async () => {
    setLoading(true);
    try {
      await api.savePromptTemplate({ template: promptTemplate, autoMerge });
      goNext();
    } catch (err) {
      toast.error("Failed to save prompt template");
    } finally {
      setLoading(false);
    }
  };

  const saveTicketsStep = async () => {
    setLoading(true);
    try {
      if (enableTickets && ticketOwner && ticketRepo) {
        await api.createTicketProvider({
          source: "github",
          config: {
            token: githubToken,
            owner: ticketOwner,
            repo: ticketRepo,
            label: "optio",
          },
        });
      }
      goNext();
    } catch (err) {
      toast.error("Failed to configure ticket provider");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        {/* Progress */}
        <div className="flex items-center justify-center gap-1 mb-8">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex items-center">
              <div
                className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-xs transition-colors",
                  i < step
                    ? "bg-primary text-white"
                    : i === step
                      ? "bg-primary/20 text-primary border border-primary"
                      : "bg-bg-card text-text-muted border border-border",
                )}
              >
                {i < step ? <Check className="w-4 h-4" /> : <s.icon className="w-3.5 h-3.5" />}
              </div>
              {i < STEPS.length - 1 && (
                <div className={cn("w-8 h-px mx-1", i < step ? "bg-primary" : "bg-border")} />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="border border-border rounded-lg bg-bg-card p-6">
          {/* Welcome */}
          {currentStep.id === "welcome" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Zap className="w-6 h-6 text-primary" />
                <h1 className="text-xl font-bold">Welcome to Optio</h1>
              </div>
              <p className="text-text-muted text-sm leading-relaxed">
                Optio orchestrates AI coding agents on your repositories. Let's get you set up with
                the credentials and repos your agents will need.
              </p>
              <div className="p-3 rounded-md bg-bg border border-border">
                <div className="flex items-center gap-2 text-sm">
                  <span
                    className={
                      runtimeHealthy === true
                        ? "text-success"
                        : runtimeHealthy === false
                          ? "text-error"
                          : "text-text-muted"
                    }
                  >
                    {runtimeHealthy === null ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : runtimeHealthy ? (
                      <CheckCircle className="w-4 h-4" />
                    ) : (
                      <AlertCircle className="w-4 h-4" />
                    )}
                  </span>
                  <span>
                    Kubernetes runtime:{" "}
                    {runtimeHealthy === null
                      ? "Checking..."
                      : runtimeHealthy
                        ? "Connected"
                        : "Not available"}
                  </span>
                </div>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={goNext}
                  disabled={!runtimeHealthy}
                  className="flex items-center gap-2 px-5 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover disabled:opacity-50 transition-colors"
                >
                  Get Started <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* GitHub Token */}
          {currentStep.id === "github" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Github className="w-6 h-6 text-text" />
                <h2 className="text-lg font-bold">GitHub Access</h2>
              </div>
              <p className="text-text-muted text-sm">
                Agents need a GitHub token to clone repos, create branches, and open pull requests.
                Create a token with <code className="px-1 py-0.5 bg-bg rounded text-xs">repo</code>{" "}
                scope, then paste it below.
              </p>
              <a
                href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=Optio+Agent"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-bg-hover text-text text-sm hover:bg-border transition-colors"
              >
                <ExternalLink className="w-4 h-4" />
                Create GitHub Personal Access Token
              </a>
              <div>
                <label className="block text-sm text-text-muted mb-1.5">GitHub Token</label>
                <input
                  type="password"
                  value={githubToken}
                  onChange={(e) => {
                    setGithubToken(e.target.value);
                    setGithubValidated(false);
                    setGithubError("");
                  }}
                  onPaste={(e) => {
                    e.preventDefault();
                    const pasted = e.clipboardData.getData("text").trim();
                    if (pasted) {
                      setGithubToken(pasted);
                      setGithubValidated(false);
                      setGithubError("");
                      setTimeout(() => validateGithub(pasted), 50);
                    }
                  }}
                  placeholder="ghp_..."
                  className="w-full px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
                />
              </div>
              {githubError && (
                <div className="flex items-center gap-2 text-error text-sm">
                  <AlertCircle className="w-4 h-4" />
                  {githubError}
                </div>
              )}
              {githubValidated && githubUser && (
                <div className="flex items-center gap-2 text-success text-sm p-2 rounded-md bg-success/10">
                  <CheckCircle className="w-4 h-4" />
                  Authenticated as <strong>{githubUser.login}</strong>
                  {githubUser.name && <span className="text-text-muted">({githubUser.name})</span>}
                </div>
              )}
              <div className="flex items-center justify-between">
                <button
                  onClick={goBack}
                  className="flex items-center gap-2 px-4 py-2 rounded-md text-text-muted text-sm hover:bg-bg-hover"
                >
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>
                <div className="flex gap-2">
                  {!githubValidated && (
                    <button
                      onClick={() => validateGithub()}
                      disabled={loading || !githubToken.trim()}
                      className="flex items-center gap-2 px-4 py-2 rounded-md bg-bg-hover text-text text-sm hover:bg-border disabled:opacity-50"
                    >
                      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Validate"}
                    </button>
                  )}
                  <button
                    onClick={saveGithubStep}
                    disabled={!githubValidated || loading}
                    className="flex items-center gap-2 px-5 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover disabled:opacity-50"
                  >
                    {loading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <>
                        Continue <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Agent Keys */}
          {currentStep.id === "agents" && (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <Key className="w-6 h-6 text-text" />
                <h2 className="text-lg font-bold">Agent Configuration</h2>
              </div>
              <p className="text-text-muted text-sm">
                Configure how agents authenticate. You need at least one agent set up.
              </p>

              {/* Claude Code */}
              <div className="p-4 rounded-md bg-bg border border-border space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Claude Code</span>
                  {claudeReady ? (
                    <span className="text-success text-xs flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" /> Ready
                    </span>
                  ) : null}
                </div>

                {/* Auth mode selector */}
                <div className="space-y-2">
                  <label
                    className={cn(
                      "flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors",
                      claudeAuthMode === "oauth-token"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-text-muted",
                    )}
                  >
                    <input
                      type="radio"
                      name="claude-auth"
                      checked={claudeAuthMode === "oauth-token"}
                      onChange={() => setClaudeAuthMode("oauth-token")}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium">Use Max/Pro subscription</span>
                      <p className="text-xs text-text-muted mt-0.5">
                        Uses your existing Claude subscription — no API key costs. Run the command
                        below to copy your token, then paste it here.
                      </p>
                      {claudeAuthMode === "oauth-token" && (
                        <div className="mt-3 space-y-3">
                          {oauthChecking ? (
                            <span className="text-xs text-text-muted flex items-center gap-1">
                              <Loader2 className="w-3 h-3 animate-spin" /> Checking for existing
                              token...
                            </span>
                          ) : oauthTokenDetected ? (
                            <span className="text-xs text-success flex items-center gap-1">
                              <CheckCircle className="w-3 h-3" /> Claude subscription token detected
                            </span>
                          ) : (
                            <>
                              <div>
                                <p className="text-xs text-text-muted mb-1.5">
                                  Run this in a terminal to copy your token:
                                </p>
                                <div className="relative group">
                                  <pre className="text-[11px] font-mono bg-bg-card border border-border rounded-md px-3 py-2.5 overflow-x-auto select-all whitespace-pre-wrap break-all">
                                    {`security find-generic-password -s "Claude Code-credentials" -w | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" | pbcopy`}
                                  </pre>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      navigator.clipboard.writeText(
                                        `security find-generic-password -s "Claude Code-credentials" -w | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" | pbcopy`,
                                      );
                                      toast.success("Command copied to clipboard");
                                    }}
                                    className="absolute top-1.5 right-1.5 px-2 py-1 rounded bg-bg-hover text-text-muted hover:text-text text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                                  >
                                    Copy
                                  </button>
                                </div>
                              </div>
                              <div>
                                <p className="text-xs text-text-muted mb-1.5">
                                  Then paste the token here:
                                </p>
                                <input
                                  type="password"
                                  value={oauthToken}
                                  onChange={(e) => setOauthToken(e.target.value)}
                                  placeholder="Paste token here"
                                  className="w-full px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary font-mono"
                                />
                              </div>
                              {oauthToken.trim().length > 0 && (
                                <span className="text-xs text-success flex items-center gap-1">
                                  <Check className="w-3 h-3" /> Token ready
                                </span>
                              )}
                              {!showManualPaste && (
                                <p className="text-[10px] text-text-muted">
                                  Not on macOS?{" "}
                                  <button
                                    type="button"
                                    onClick={() => setShowManualPaste(true)}
                                    className="text-primary hover:underline"
                                  >
                                    See alternative methods
                                  </button>
                                </p>
                              )}
                              {showManualPaste && (
                                <div className="text-[10px] text-text-muted space-y-1 border-t border-border pt-2">
                                  <p>
                                    <strong>Linux:</strong> Check{" "}
                                    <code className="px-1 py-0.5 bg-bg-card rounded text-primary">
                                      ~/.claude/.credentials.json
                                    </code>{" "}
                                    for <code>claudeAiOauth.accessToken</code>
                                  </p>
                                  <p>
                                    <strong>Any platform:</strong> Run{" "}
                                    <code className="px-1 py-0.5 bg-bg-card rounded text-primary">
                                      claude setup-token
                                    </code>{" "}
                                    (note: usage charts may not work with this method)
                                  </p>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </label>

                  <label
                    className={cn(
                      "flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors",
                      claudeAuthMode === "api-key"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-text-muted",
                    )}
                  >
                    <input
                      type="radio"
                      name="claude-auth"
                      checked={claudeAuthMode === "api-key"}
                      onChange={() => setClaudeAuthMode("api-key")}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium">Use API key</span>
                      <p className="text-xs text-text-muted mt-0.5">
                        Pay-per-use via the Anthropic API. Get a key from console.anthropic.com.
                      </p>
                      {claudeAuthMode === "api-key" && (
                        <div className="mt-2 space-y-2">
                          <div className="flex gap-2">
                            <input
                              type="password"
                              value={anthropicKey}
                              onChange={(e) => {
                                setAnthropicKey(e.target.value);
                                setAnthropicValidated(false);
                                setAnthropicError("");
                              }}
                              onPaste={(e) => {
                                e.preventDefault();
                                const pasted = e.clipboardData.getData("text").trim();
                                if (pasted) {
                                  setAnthropicKey(pasted);
                                  setAnthropicValidated(false);
                                  setAnthropicError("");
                                  setTimeout(() => validateAnthropic(pasted), 50);
                                }
                              }}
                              placeholder="sk-ant-..."
                              className="flex-1 px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                            />
                            <button
                              onClick={() => validateAnthropic()}
                              disabled={loading || !anthropicKey.trim() || anthropicValidated}
                              className="px-3 py-2 rounded-md bg-bg-hover text-sm hover:bg-border disabled:opacity-50"
                            >
                              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Validate"}
                            </button>
                          </div>
                          {anthropicError && (
                            <p className="text-error text-xs flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" /> {anthropicError}
                            </p>
                          )}
                          {anthropicValidated && (
                            <p className="text-success text-xs flex items-center gap-1">
                              <CheckCircle className="w-3 h-3" /> API key valid
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </label>
                </div>
              </div>

              {/* OpenAI (unchanged) */}
              <div className="p-4 rounded-md bg-bg border border-border space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    Codex (OpenAI) <span className="text-text-muted font-normal">— optional</span>
                  </span>
                  {openaiValidated && (
                    <span className="text-success text-xs flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" /> Valid
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={openaiKey}
                    onChange={(e) => {
                      setOpenaiKey(e.target.value);
                      setOpenaiValidated(false);
                      setOpenaiError("");
                    }}
                    onPaste={(e) => {
                      e.preventDefault();
                      const pasted = e.clipboardData.getData("text").trim();
                      if (pasted) {
                        setOpenaiKey(pasted);
                        setOpenaiValidated(false);
                        setOpenaiError("");
                        setTimeout(() => validateOpenai(pasted), 50);
                      }
                    }}
                    placeholder="sk-..."
                    className="flex-1 px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                  />
                  <button
                    onClick={() => validateOpenai()}
                    disabled={loading || !openaiKey.trim() || openaiValidated}
                    className="px-3 py-2 rounded-md bg-bg-hover text-sm hover:bg-border disabled:opacity-50"
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Validate"}
                  </button>
                </div>
                {openaiError && (
                  <p className="text-error text-xs flex items-center gap-1">
                    <AlertCircle className="w-3 h-3" /> {openaiError}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between">
                <button
                  onClick={goBack}
                  className="flex items-center gap-2 px-4 py-2 rounded-md text-text-muted text-sm hover:bg-bg-hover"
                >
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>
                <button
                  onClick={saveAgentKeysStep}
                  disabled={(!claudeReady && !openaiValidated) || loading}
                  className="flex items-center gap-2 px-5 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover disabled:opacity-50"
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      Continue <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Repositories */}
          {currentStep.id === "repos" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <GitBranch className="w-6 h-6 text-text" />
                <h2 className="text-lg font-bold">Repositories</h2>
              </div>
              <p className="text-text-muted text-sm">
                Select the repos your agents will work on. You can always add more later.
              </p>

              {/* Suggested repos from GitHub */}
              {suggestedLoading ? (
                <div className="flex items-center justify-center py-6 text-text-muted text-sm">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading your repos...
                </div>
              ) : suggestedRepos.length > 0 ? (
                <div>
                  <label className="text-xs text-text-muted mb-2 block">
                    Your recent repositories
                  </label>
                  <div className="grid gap-1.5 overflow-hidden">
                    {suggestedRepos.map((sr) => {
                      const isSelected = repos.some((r) => r.fullName === sr.fullName);
                      return (
                        <button
                          key={sr.fullName}
                          onClick={() => {
                            if (isSelected) {
                              setRepos(repos.filter((r) => r.fullName !== sr.fullName));
                            } else {
                              setRepos([
                                ...repos,
                                {
                                  url: sr.cloneUrl,
                                  fullName: sr.fullName,
                                  defaultBranch: sr.defaultBranch,
                                  isPrivate: sr.isPrivate,
                                  validated: true,
                                },
                              ]);
                            }
                          }}
                          className={cn(
                            "flex items-center gap-3 p-2.5 rounded-md border text-left text-sm transition-colors min-w-0",
                            isSelected
                              ? "border-primary bg-primary/5"
                              : "border-border hover:border-text-muted bg-bg",
                          )}
                        >
                          <div
                            className={cn(
                              "w-5 h-5 rounded border flex items-center justify-center shrink-0",
                              isSelected ? "bg-primary border-primary" : "border-border",
                            )}
                          >
                            {isSelected && <Check className="w-3 h-3 text-white" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">{sr.fullName}</span>
                              {sr.isPrivate && (
                                <span className="text-[10px] px-1 py-0.5 rounded bg-text-muted/10 text-text-muted">
                                  private
                                </span>
                              )}
                              {sr.language && (
                                <span className="text-[10px] text-text-muted">{sr.language}</span>
                              )}
                            </div>
                            {sr.description && (
                              <p className="text-xs text-text-muted truncate mt-0.5">
                                {sr.description}
                              </p>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {/* Selected repos summary */}
              {repos.length > 0 && (
                <div className="flex items-center gap-2 text-xs text-success">
                  <CheckCircle className="w-3 h-3" />
                  {repos.length} repo{repos.length !== 1 ? "s" : ""} selected
                </div>
              )}

              {/* Manual add */}
              <div>
                <label className="text-xs text-text-muted mb-1.5 block">Or add by URL</label>
                <div className="flex gap-2">
                  <input
                    value={manualRepoUrl}
                    onChange={(e) => setManualRepoUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && manualRepoUrl.trim()) {
                        const url = manualRepoUrl.trim();
                        setRepos([...repos, { url, validated: false }]);
                        setManualRepoUrl("");
                      }
                    }}
                    placeholder="https://github.com/owner/repo"
                    className="flex-1 px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
                  />
                  <button
                    onClick={() => {
                      if (!manualRepoUrl.trim()) return;
                      const url = manualRepoUrl.trim();
                      setRepos([...repos, { url, validated: false }]);
                      setManualRepoUrl("");
                    }}
                    disabled={!manualRepoUrl.trim()}
                    className="px-3 py-2 rounded-md bg-bg-hover text-sm hover:bg-border disabled:opacity-50"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <button
                  onClick={goBack}
                  className="flex items-center gap-2 px-4 py-2 rounded-md text-text-muted text-sm hover:bg-bg-hover"
                >
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>
                <button
                  onClick={saveReposStep}
                  disabled={loading}
                  className="flex items-center gap-2 px-5 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover disabled:opacity-50"
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      Continue <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Prompt Template */}
          {currentStep.id === "prompt" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <FileText className="w-6 h-6 text-text" />
                <h2 className="text-lg font-bold">Agent Prompt</h2>
              </div>
              <p className="text-text-muted text-sm">
                This prompt tells agents how to work. It's sent to the agent along with a task file
                containing the specific work to do. You can customize this per-repo later.
              </p>

              {promptLoading ? (
                <div className="flex items-center justify-center py-8 text-text-muted">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading template...
                </div>
              ) : (
                <>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-sm text-text-muted">System Prompt Template</label>
                      <button
                        onClick={() =>
                          api.getBuiltinDefault().then((r) => setPromptTemplate(r.template))
                        }
                        className="text-xs text-primary hover:underline"
                      >
                        Reset to default
                      </button>
                    </div>
                    <textarea
                      value={promptTemplate}
                      onChange={(e) => setPromptTemplate(e.target.value)}
                      rows={14}
                      className="w-full px-3 py-2 rounded-md bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary transition-colors resize-y leading-relaxed"
                    />
                    <p className="text-xs text-text-muted mt-1">
                      Variables: <code className="text-primary">{"{{TASK_FILE}}"}</code>{" "}
                      <code className="text-primary">{"{{BRANCH_NAME}}"}</code>{" "}
                      <code className="text-primary">{"{{TASK_ID}}"}</code>{" "}
                      <code className="text-primary">{"{{TASK_TITLE}}"}</code>{" "}
                      <code className="text-primary">{"{{REPO_NAME}}"}</code>{" "}
                      <code className="text-primary">{"{{AUTO_MERGE}}"}</code>
                    </p>
                  </div>

                  <label className="flex items-center gap-3 p-3 rounded-md border border-border bg-bg cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoMerge}
                      onChange={(e) => setAutoMerge(e.target.checked)}
                      className="w-4 h-4 rounded"
                    />
                    <div>
                      <span className="text-sm font-medium">Auto-merge PRs</span>
                      <p className="text-xs text-text-muted mt-0.5">
                        When enabled, agents will merge PRs automatically after CI passes. Disable
                        to require human review.
                      </p>
                    </div>
                  </label>
                </>
              )}

              <div className="flex items-center justify-between">
                <button
                  onClick={goBack}
                  className="flex items-center gap-2 px-4 py-2 rounded-md text-text-muted text-sm hover:bg-bg-hover"
                >
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>
                <button
                  onClick={savePromptStep}
                  disabled={loading || !promptTemplate.trim()}
                  className="flex items-center gap-2 px-5 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover disabled:opacity-50"
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      Continue <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Tickets */}
          {currentStep.id === "tickets" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Ticket className="w-6 h-6 text-text" />
                <h2 className="text-lg font-bold">Ticket Integration</h2>
              </div>
              <p className="text-text-muted text-sm">
                Optionally connect a GitHub repository to auto-create tasks from issues labeled{" "}
                <code className="px-1 py-0.5 bg-bg rounded text-primary text-xs">optio</code>.
              </p>

              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enableTickets}
                  onChange={(e) => {
                    setEnableTickets(e.target.checked);
                    // Auto-populate from the first selected repo
                    if (e.target.checked && !ticketOwner && repos.length > 0) {
                      const firstRepo = repos[0];
                      const name = firstRepo.fullName ?? firstRepo.url;
                      const match = name.match(/([^/]+)\/([^/.]+?)(?:\.git)?$/);
                      if (match) {
                        setTicketOwner(match[1]);
                        setTicketRepo(match[2]);
                      }
                    }
                  }}
                  className="w-4 h-4 rounded"
                />
                <span className="text-sm">Enable GitHub Issues integration</span>
              </label>

              {enableTickets && (
                <div className="p-4 rounded-md bg-bg border border-border space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Owner</label>
                      <input
                        value={ticketOwner}
                        onChange={(e) => setTicketOwner(e.target.value)}
                        placeholder="your-org"
                        className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Repository</label>
                      <input
                        value={ticketRepo}
                        onChange={(e) => setTicketRepo(e.target.value)}
                        placeholder="your-repo"
                        className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-text-muted">
                    Issues with the{" "}
                    <code className="px-1 py-0.5 bg-bg-card rounded text-primary">optio</code> label
                    will be synced automatically.
                  </p>
                </div>
              )}

              <div className="flex items-center justify-between">
                <button
                  onClick={goBack}
                  className="flex items-center gap-2 px-4 py-2 rounded-md text-text-muted text-sm hover:bg-bg-hover"
                >
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>
                <button
                  onClick={saveTicketsStep}
                  disabled={loading}
                  className="flex items-center gap-2 px-5 py-2 rounded-md bg-primary text-white text-sm hover:bg-primary-hover disabled:opacity-50"
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      Continue <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Done */}
          {currentStep.id === "done" && (
            <div className="space-y-5 text-center">
              <div className="flex justify-center">
                <div className="w-16 h-16 rounded-full bg-success/10 flex items-center justify-center">
                  <CheckCircle className="w-8 h-8 text-success" />
                </div>
              </div>
              <div>
                <h2 className="text-lg font-bold">You're all set!</h2>
                <p className="text-text-muted text-sm mt-1">
                  Optio is configured and ready to run agents.
                </p>
              </div>

              <div className="text-left p-4 rounded-md bg-bg border border-border space-y-2">
                <h3 className="text-sm font-medium mb-2">Configuration summary</h3>
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle className="w-4 h-4 text-success" />
                  <span>GitHub: {githubUser?.login ?? "configured"}</span>
                </div>
                {claudeReady && (
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle className="w-4 h-4 text-success" />
                    <span>
                      Claude Code:{" "}
                      {claudeAuthMode === "oauth-token" ? "Max/Pro subscription" : "API key"}
                    </span>
                  </div>
                )}
                {openaiValidated && (
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle className="w-4 h-4 text-success" />
                    <span>OpenAI Codex: ready</span>
                  </div>
                )}
                {repos.filter((r) => r.validated).length > 0 && (
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle className="w-4 h-4 text-success" />
                    <span>{repos.filter((r) => r.validated).length} repo(s) verified</span>
                  </div>
                )}
                <div className="flex items-center gap-2 text-sm">
                  <CheckCircle className="w-4 h-4 text-success" />
                  <span>
                    Prompt template: {autoMerge ? "auto-merge enabled" : "review required"}
                  </span>
                </div>
                {enableTickets && ticketOwner && ticketRepo && (
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle className="w-4 h-4 text-success" />
                    <span>
                      GitHub Issues: {ticketOwner}/{ticketRepo}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex justify-center gap-3">
                <button
                  onClick={() => router.push("/tasks/new")}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover"
                >
                  Create Your First Task <ArrowRight className="w-4 h-4" />
                </button>
                <button
                  onClick={() => router.push("/")}
                  className="flex items-center gap-2 px-6 py-2.5 rounded-md bg-bg-hover text-text-muted text-sm hover:text-text"
                >
                  Go to Dashboard
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
