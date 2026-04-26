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
  AlertTriangle,
  Check,
  Plus,
  ExternalLink,
  FileText,
} from "lucide-react";

const STEPS = [
  { id: "welcome", label: "Welcome", icon: Zap },
  { id: "git", label: "Git Provider", icon: GitBranch },
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

function isGitHubUrl(url: string): boolean {
  return /(^|[./:@])github\.com([/:]|$)/i.test(url);
}

function parseGitHubOwnerRepo(source: string): { owner: string; repo: string } | null {
  const m = source.match(/(?:github\.com[/:])?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);

  // Step 1: Runtime health
  const [runtimeHealthy, setRuntimeHealthy] = useState<boolean | null>(null);

  // Step 2: Git provider
  const [githubEnabled, setGithubEnabled] = useState(true);
  const [gitlabEnabled, setGitlabEnabled] = useState(false);
  const [githubToken, setGithubToken] = useState("");
  const [githubUser, setGithubUser] = useState<{ login: string; name: string } | null>(null);
  const [githubValidated, setGithubValidated] = useState(false);
  const [githubError, setGithubError] = useState("");
  const [githubAppConfigured, setGithubAppConfigured] = useState(false);
  const [gitlabToken, setGitlabToken] = useState("");
  const [gitlabHost, setGitlabHost] = useState("gitlab.com");
  const [gitlabUser, setGitlabUser] = useState<{ login: string; name: string } | null>(null);
  const [gitlabValidated, setGitlabValidated] = useState(false);
  const [gitlabError, setGitlabError] = useState("");

  // Step 3: Agent keys
  const [anthropicKey, setAnthropicKey] = useState("");
  const [anthropicValidated, setAnthropicValidated] = useState(false);
  const [anthropicError, setAnthropicError] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiValidated, setOpenaiValidated] = useState(false);
  const [openaiError, setOpenaiError] = useState("");

  // Step 3: Claude auth mode
  const [claudeAuthMode, setClaudeAuthMode] = useState<"api-key" | "oauth-token" | "vertex-ai">(
    "oauth-token",
  );
  const [oauthToken, setOauthToken] = useState("");
  const [oauthTokenDetected, setOauthTokenDetected] = useState(false);
  const [oauthChecking, setOauthChecking] = useState(false);
  const [showManualPaste, setShowManualPaste] = useState(false);
  const [claudeVertexProject, setClaudeVertexProject] = useState("");
  const [claudeVertexRegion, setClaudeVertexRegion] = useState("us-central1");
  const [claudeVertexServiceAccountKey, setClaudeVertexServiceAccountKey] = useState("");
  const [claudeVertexKeyError, setClaudeVertexKeyError] = useState("");

  // Step 3: Codex auth mode
  const [codexAuthMode, setCodexAuthMode] = useState<"api-key" | "app-server">("api-key");
  const [codexAppServerUrl, setCodexAppServerUrl] = useState("");

  // Step 3: Copilot token
  const [copilotToken, setCopilotToken] = useState("");
  const [copilotValidated, setCopilotValidated] = useState(false);
  const [copilotError, setCopilotError] = useState("");

  // Step 3: OpenCode (optional, experimental — reuses Anthropic/OpenAI keys or a custom base URL)
  const [opencodeMode, setOpencodeMode] = useState<"provider-key" | "custom-endpoint">(
    "provider-key",
  );
  const [opencodeBaseUrl, setOpencodeBaseUrl] = useState("");
  const [opencodeDefaultModel, setOpencodeDefaultModel] = useState("");

  // Step 3b: Gemini
  const [geminiAuthMode, setGeminiAuthMode] = useState<"api-key" | "vertex-ai">("api-key");
  const [geminiKey, setGeminiKey] = useState("");
  const [geminiValidated, setGeminiValidated] = useState(false);
  const [geminiError, setGeminiError] = useState("");
  const [geminiVertexProject, setGeminiVertexProject] = useState("");
  const [geminiVertexLocation, setGeminiVertexLocation] = useState("us-central1");

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

  // Scope for agent credentials (ANTHROPIC_API_KEY / OPENAI_API_KEY /
  // GEMINI_API_KEY / CLAUDE_CODE_OAUTH_TOKEN). User-scoped secrets are only
  // visible to tasks the same user kicks off — background runs (ticket sync,
  // scheduled, webhooks) have no user context and will not find them, so we
  // default to "global" for admins and "user" otherwise.
  const [agentSecretScope, setAgentSecretScope] = useState<"global" | "user">("global");
  const [canSetGlobalSecrets, setCanSetGlobalSecrets] = useState(true);

  // Step 6: Tickets — per-repo GitHub Issues toggles + a list of external trackers
  const [githubIssueRepos, setGithubIssueRepos] = useState<Record<string, boolean>>({});
  type AddedTracker = {
    source: "linear" | "notion" | "jira";
    config: Record<string, unknown>;
    repoUrl: string;
    label: string;
  };
  const [addedTrackers, setAddedTrackers] = useState<AddedTracker[]>([]);
  // Draft (form) state for adding a new external tracker
  const [draftProvider, setDraftProvider] = useState<"linear" | "notion" | "jira">("linear");
  const [draftRepoUrl, setDraftRepoUrl] = useState("");
  const [notionApiKey, setNotionApiKey] = useState("");
  const [notionDatabaseId, setNotionDatabaseId] = useState("");
  const [linearApiKey, setLinearApiKey] = useState("");
  const [linearTeamId, setLinearTeamId] = useState("");
  const [jiraBaseUrl, setJiraBaseUrl] = useState("");
  const [jiraEmail, setJiraEmail] = useState("");
  const [jiraApiToken, setJiraApiToken] = useState("");
  const [jiraProjectKey, setJiraProjectKey] = useState("");

  // Check runtime and GitHub App status on mount
  useEffect(() => {
    api
      .getHealth()
      .then((res) => setRuntimeHealthy(res.healthy))
      .catch(() => setRuntimeHealthy(false));
    api
      .getGitHubAppStatus()
      .then((res) => setGithubAppConfigured(res.configured))
      .catch(() => {});
    // Determine if the current user can store global secrets. Only admins
    // (or anyone, when auth is disabled) may; non-admins must use user scope.
    api
      .getCurrentUser()
      .then((res) => {
        const isAdmin = res.authDisabled || res.user.workspaceRole === "admin";
        setCanSetGlobalSecrets(isAdmin);
        setAgentSecretScope(isAdmin ? "global" : "user");
      })
      .catch(() => {});
  }, []);

  // Check if OAuth token is already stored when reaching the agents step
  useEffect(() => {
    if (step === 2) {
      checkOauthToken();
    }
  }, [step]);

  // Fetch suggested repos when reaching the repos step
  useEffect(() => {
    if (currentStep?.id === "repos" && suggestedRepos.length === 0) {
      setSuggestedLoading(true);
      const fetches: Promise<{ repos: any[] }>[] = [];
      if (githubAppConfigured || (githubEnabled && githubToken))
        fetches.push(api.listUserRepos(githubToken || ""));
      if (gitlabEnabled && gitlabToken)
        fetches.push(api.listGitlabRepos(gitlabToken, gitlabHost || undefined));
      if (fetches.length > 0) {
        Promise.all(fetches)
          .then((results) => {
            const all = results.flatMap((r) => r.repos);
            setSuggestedRepos(all.slice(0, 8));
          })
          .catch(() => {})
          .finally(() => setSuggestedLoading(false));
      } else {
        setSuggestedLoading(false);
      }
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

  // When entering the tickets step, default each selected GitHub repo to ON.
  // Preserve any explicit user choices made on prior visits to the step.
  useEffect(() => {
    if (currentStep?.id !== "tickets") return;
    setGithubIssueRepos((prev) => {
      const next = { ...prev };
      for (const r of repos) {
        if (isGitHubUrl(r.url) && !(r.url in next)) next[r.url] = true;
      }
      return next;
    });
    if (!draftRepoUrl && repos.length > 0) setDraftRepoUrl(repos[0].url);
  }, [step]);

  const claudeReady =
    claudeAuthMode === "oauth-token"
      ? oauthTokenDetected || oauthToken.trim().length > 0
      : claudeAuthMode === "vertex-ai"
        ? claudeVertexProject.trim().length > 0
        : anthropicValidated;

  const codexReady =
    codexAuthMode === "app-server" ? codexAppServerUrl.trim().length > 0 : openaiValidated;

  const copilotReady = copilotValidated;

  const opencodeReady =
    opencodeMode === "custom-endpoint"
      ? opencodeBaseUrl.trim().length > 0
      : claudeReady || openaiValidated;

  const geminiReady =
    geminiAuthMode === "vertex-ai" ? geminiVertexProject.trim().length > 0 : geminiValidated;

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

  const validateGitlab = async (tokenOverride?: string) => {
    const token = tokenOverride ?? gitlabToken;
    if (!token.trim()) return;
    setLoading(true);
    setGitlabError("");
    try {
      const res = await api.validateGitlabToken(token, gitlabHost || undefined);
      if (res.valid && res.user) {
        setGitlabUser(res.user);
        setGitlabValidated(true);
      } else {
        setGitlabError(res.error ?? "Invalid token");
      }
    } catch (err) {
      setGitlabError(err instanceof Error ? err.message : "Validation failed");
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

  const validateCopilot = async (tokenOverride?: string) => {
    const token = tokenOverride ?? copilotToken;
    if (!token.trim()) return;
    setLoading(true);
    setCopilotError("");
    try {
      const res = await api.validateCopilotToken(token);
      if (res.valid) {
        setCopilotValidated(true);
      } else {
        setCopilotError(res.error ?? "Invalid token");
      }
    } catch (err) {
      setCopilotError(err instanceof Error ? err.message : "Validation failed");
    }
    setLoading(false);
  };

  const validateGemini = async (keyOverride?: string) => {
    const key = keyOverride ?? geminiKey;
    if (!key.trim()) return;
    setLoading(true);
    setGeminiError("");
    try {
      const res = await api.validateGeminiKey(key);
      if (res.valid) {
        setGeminiValidated(true);
      } else {
        setGeminiError(res.error ?? "Invalid API key");
      }
    } catch (err) {
      setGeminiError(err instanceof Error ? err.message : "Validation failed");
    }
    setLoading(false);
  };

  const [oauthExpired, setOauthExpired] = useState(false);

  const checkOauthToken = async () => {
    setOauthChecking(true);
    try {
      const res = await api.getAuthStatus();
      if (res.subscription.expired) {
        setOauthExpired(true);
        setOauthTokenDetected(false);
        setClaudeAuthMode("oauth-token");
      } else if (res.subscription.available) {
        setOauthExpired(false);
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
  const saveGitStep = async () => {
    setLoading(true);
    try {
      if (githubEnabled && githubToken.trim() && githubValidated) {
        await api.createSecret({ name: "GITHUB_TOKEN", value: githubToken });
      }
      if (gitlabEnabled && gitlabToken.trim() && gitlabValidated) {
        await api.createSecret({ name: "GITLAB_TOKEN", value: gitlabToken });
        if (gitlabHost && gitlabHost !== "gitlab.com") {
          await api.createSecret({ name: "GITLAB_HOST", value: gitlabHost });
        }
      }
      goNext();
    } catch (err) {
      toast.error("Failed to save git provider tokens");
    }
    setLoading(false);
  };

  const saveAgentKeysStep = async () => {
    setLoading(true);
    try {
      // Save Claude auth mode as a secret so the worker knows which mode to use
      await api.createSecret({ name: "CLAUDE_AUTH_MODE", value: claudeAuthMode });

      if (claudeAuthMode === "api-key" && anthropicKey.trim() && anthropicValidated) {
        await api.createSecret({
          name: "ANTHROPIC_API_KEY",
          value: anthropicKey,
          scope: agentSecretScope,
        });
      }
      if (claudeAuthMode === "oauth-token" && oauthToken.trim()) {
        await api.createSecret({
          name: "CLAUDE_CODE_OAUTH_TOKEN",
          value: oauthToken,
          scope: agentSecretScope,
        });
      }
      if (claudeAuthMode === "vertex-ai" && claudeVertexProject.trim()) {
        await api.createSecret({
          name: "CLAUDE_VERTEX_PROJECT_ID",
          value: claudeVertexProject.trim(),
        });
        if (claudeVertexRegion.trim()) {
          await api.createSecret({
            name: "CLAUDE_VERTEX_REGION",
            value: claudeVertexRegion.trim(),
          });
        }
        if (claudeVertexServiceAccountKey.trim()) {
          // Validate JSON structure before saving
          try {
            const keyData = JSON.parse(claudeVertexServiceAccountKey);
            // Validate it's actually a service account key with required fields
            const requiredFields = ["type", "project_id", "private_key", "client_email"];
            const missingFields = requiredFields.filter((field) => !keyData[field]);
            if (missingFields.length > 0) {
              throw new Error(
                `Invalid service account key: missing required fields: ${missingFields.join(", ")}`,
              );
            }
            if (keyData.type !== "service_account") {
              throw new Error('Invalid service account key: type must be "service_account"');
            }
            await api.createSecret({
              name: "CLAUDE_VERTEX_SERVICE_ACCOUNT_KEY",
              value: claudeVertexServiceAccountKey,
            });
          } catch (e) {
            if (e instanceof Error) {
              throw e;
            }
            throw new Error("Service account key must be valid JSON");
          }
        }
      }
      // Save Codex auth mode and credentials
      if (codexAuthMode === "app-server" && codexAppServerUrl.trim()) {
        await api.createSecret({ name: "CODEX_AUTH_MODE", value: "app-server" });
        await api.createSecret({ name: "CODEX_APP_SERVER_URL", value: codexAppServerUrl.trim() });
      } else if (openaiKey.trim() && openaiValidated) {
        await api.createSecret({ name: "CODEX_AUTH_MODE", value: "api-key" });
        await api.createSecret({
          name: "OPENAI_API_KEY",
          value: openaiKey,
          scope: agentSecretScope,
        });
      }
      // Save Copilot token
      if (copilotToken.trim() && copilotValidated) {
        await api.createSecret({ name: "COPILOT_GITHUB_TOKEN", value: copilotToken });
      }
      // Save OpenCode custom endpoint defaults
      if (opencodeMode === "custom-endpoint" && opencodeBaseUrl.trim()) {
        await api.createSecret({
          name: "OPENCODE_DEFAULT_BASE_URL",
          value: opencodeBaseUrl.trim(),
        });
        if (opencodeDefaultModel.trim()) {
          await api.createSecret({
            name: "OPENCODE_DEFAULT_MODEL",
            value: opencodeDefaultModel.trim(),
          });
        }
      }
      // Save Gemini credentials
      if (geminiAuthMode === "vertex-ai" && geminiVertexProject.trim()) {
        await api.createSecret({ name: "GEMINI_AUTH_MODE", value: "vertex-ai" });
        await api.createSecret({ name: "GOOGLE_CLOUD_PROJECT", value: geminiVertexProject.trim() });
        if (geminiVertexLocation.trim()) {
          await api.createSecret({
            name: "GOOGLE_CLOUD_LOCATION",
            value: geminiVertexLocation.trim(),
          });
        }
      } else if (geminiKey.trim() && geminiValidated) {
        await api.createSecret({ name: "GEMINI_AUTH_MODE", value: "api-key" });
        await api.createSecret({
          name: "GEMINI_API_KEY",
          value: geminiKey,
          scope: agentSecretScope,
        });
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
          try {
            await api.createRepoConfig({
              repoUrl: repo.url,
              fullName: repo.fullName,
              defaultBranch: repo.defaultBranch,
              isPrivate: repo.isPrivate,
            });
          } catch (err) {
            // Skip 409 Conflict (repo already exists) — this is expected on re-runs
            if (err instanceof Error && err.message.includes("already been added")) {
              continue;
            }
            throw err;
          }
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

  // Build an AddedTracker from the draft form, or return null if incomplete.
  const buildDraftTracker = (): AddedTracker | null => {
    if (!draftRepoUrl) return null;
    const repoLabel = repos.find((r) => r.url === draftRepoUrl)?.fullName ?? draftRepoUrl;
    if (draftProvider === "linear" && linearApiKey) {
      return {
        source: "linear",
        config: {
          apiKey: linearApiKey,
          teamId: linearTeamId || undefined,
          label: "optio",
          repoUrl: draftRepoUrl,
        },
        repoUrl: draftRepoUrl,
        label: `Linear → ${repoLabel}`,
      };
    }
    if (draftProvider === "notion" && notionApiKey && notionDatabaseId) {
      return {
        source: "notion",
        config: {
          apiKey: notionApiKey,
          databaseId: notionDatabaseId,
          label: "optio",
          repoUrl: draftRepoUrl,
        },
        repoUrl: draftRepoUrl,
        label: `Notion → ${repoLabel}`,
      };
    }
    if (draftProvider === "jira" && jiraBaseUrl && jiraEmail && jiraApiToken) {
      return {
        source: "jira",
        config: {
          baseUrl: jiraBaseUrl,
          email: jiraEmail,
          apiToken: jiraApiToken,
          projectKey: jiraProjectKey || undefined,
          label: "optio",
          repoUrl: draftRepoUrl,
        },
        repoUrl: draftRepoUrl,
        label: `Jira (${jiraProjectKey || "all"}) → ${repoLabel}`,
      };
    }
    return null;
  };

  const addDraftTracker = () => {
    const tracker = buildDraftTracker();
    if (!tracker) {
      toast.error("Fill in all required fields before adding");
      return;
    }
    setAddedTrackers((prev) => [...prev, tracker]);
    // Reset draft creds (keep provider selection and target repo for quick re-use)
    setLinearApiKey("");
    setLinearTeamId("");
    setNotionApiKey("");
    setNotionDatabaseId("");
    setJiraBaseUrl("");
    setJiraEmail("");
    setJiraApiToken("");
    setJiraProjectKey("");
  };

  const saveTicketsStep = async () => {
    setLoading(true);
    try {
      // One GitHub Issues provider per repo the user enabled
      for (const repo of repos) {
        if (!isGitHubUrl(repo.url) || !githubIssueRepos[repo.url]) continue;
        const parsed = parseGitHubOwnerRepo(repo.fullName ?? repo.url);
        if (!parsed) continue;
        const config: Record<string, unknown> = {
          owner: parsed.owner,
          repo: parsed.repo,
          label: "optio",
        };
        // Only send a token if the user supplied one; otherwise sync falls back
        // to the GitHub App installation token.
        if (githubToken) config.token = githubToken;
        await api.createTicketProvider({ source: "github", config });
      }

      // All external trackers the user added (Linear / Notion / Jira)
      for (const tracker of addedTrackers) {
        await api.createTicketProvider({ source: tracker.source, config: tracker.config });
      }

      // If the user filled in the draft form but didn't click "Add", save it too
      const pending = buildDraftTracker();
      if (pending) {
        await api.createTicketProvider({ source: pending.source, config: pending.config });
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

          {/* Git Provider */}
          {currentStep.id === "git" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <GitBranch className="w-6 h-6 text-text" />
                <h2 className="text-lg font-bold">Git Provider</h2>
              </div>
              <p className="text-text-muted text-sm">
                Agents need access to your git platform to clone repos, create branches, and open
                pull/merge requests. Choose your provider and add a token.
              </p>

              {/* Provider selector (both can be enabled) */}
              <div className="flex gap-2">
                <button
                  onClick={() => setGithubEnabled((v) => !v)}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2 rounded-md text-sm border transition-colors",
                    githubEnabled
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-text-muted hover:bg-bg-hover",
                  )}
                >
                  <Github className="w-4 h-4" />
                  GitHub
                </button>
                <button
                  onClick={() => setGitlabEnabled((v) => !v)}
                  className={cn(
                    "flex items-center gap-2 px-4 py-2 rounded-md text-sm border transition-colors",
                    gitlabEnabled
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-text-muted hover:bg-bg-hover",
                  )}
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0 1 18.6 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51L23 13.45a.84.84 0 0 1-.35.94z" />
                  </svg>
                  GitLab
                </button>
              </div>

              {/* GitHub form */}
              {githubEnabled && (
                <>
                  {githubAppConfigured ? (
                    <>
                      <div className="flex items-center gap-2 text-success text-sm p-3 rounded-md bg-success/10">
                        <CheckCircle className="w-4 h-4" />
                        GitHub App is configured — no personal access token needed.
                      </div>
                      <p className="text-text-muted text-sm">
                        Optio will use the installed GitHub App to clone repos, create branches, and
                        open pull requests.
                      </p>
                    </>
                  ) : (
                    <>
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
                          {githubUser.name && (
                            <span className="text-text-muted">({githubUser.name})</span>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              {/* GitLab form */}
              {gitlabEnabled && (
                <>
                  <a
                    href={`https://${gitlabHost || "gitlab.com"}/-/user_settings/personal_access_tokens?name=Optio+Agent&scopes=api,read_user,read_repository,write_repository`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-bg-hover text-text text-sm hover:bg-border transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                    Create GitLab Personal Access Token
                  </a>
                  <div>
                    <label className="block text-sm text-text-muted mb-1.5">
                      GitLab Host{" "}
                      <span className="text-text-muted/60">(leave default for gitlab.com)</span>
                    </label>
                    <input
                      type="text"
                      value={gitlabHost}
                      onChange={(e) => {
                        setGitlabHost(e.target.value);
                        setGitlabValidated(false);
                        setGitlabError("");
                      }}
                      placeholder="gitlab.com"
                      className="w-full px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-text-muted mb-1.5">GitLab Token</label>
                    <input
                      type="password"
                      value={gitlabToken}
                      onChange={(e) => {
                        setGitlabToken(e.target.value);
                        setGitlabValidated(false);
                        setGitlabError("");
                      }}
                      onPaste={(e) => {
                        e.preventDefault();
                        const pasted = e.clipboardData.getData("text").trim();
                        if (pasted) {
                          setGitlabToken(pasted);
                          setGitlabValidated(false);
                          setGitlabError("");
                          setTimeout(() => validateGitlab(pasted), 50);
                        }
                      }}
                      placeholder="glpat-..."
                      className="w-full px-3 py-2 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary"
                    />
                  </div>
                  {gitlabError && (
                    <div className="flex items-center gap-2 text-error text-sm">
                      <AlertCircle className="w-4 h-4" />
                      {gitlabError}
                    </div>
                  )}
                  {gitlabValidated && gitlabUser && (
                    <div className="flex items-center gap-2 text-success text-sm p-2 rounded-md bg-success/10">
                      <CheckCircle className="w-4 h-4" />
                      Authenticated as <strong>{gitlabUser.login}</strong>
                      {gitlabUser.name && (
                        <span className="text-text-muted">({gitlabUser.name})</span>
                      )}
                    </div>
                  )}
                </>
              )}

              <div className="flex items-center justify-between">
                <button
                  onClick={goBack}
                  className="flex items-center gap-2 px-4 py-2 rounded-md text-text-muted text-sm hover:bg-bg-hover"
                >
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>
                <div className="flex gap-2">
                  {githubEnabled && !githubAppConfigured && !githubValidated && (
                    <button
                      onClick={() => validateGithub()}
                      disabled={loading || !githubToken.trim()}
                      className="flex items-center gap-2 px-4 py-2 rounded-md bg-bg-hover text-text text-sm hover:bg-border disabled:opacity-50"
                    >
                      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Validate GitHub"}
                    </button>
                  )}
                  {gitlabEnabled && !gitlabValidated && (
                    <button
                      onClick={() => validateGitlab()}
                      disabled={loading || !gitlabToken.trim()}
                      className="flex items-center gap-2 px-4 py-2 rounded-md bg-bg-hover text-text text-sm hover:bg-border disabled:opacity-50"
                    >
                      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Validate GitLab"}
                    </button>
                  )}
                  <button
                    onClick={saveGitStep}
                    disabled={
                      loading ||
                      (!githubEnabled && !gitlabEnabled) ||
                      (githubEnabled && !githubAppConfigured && !githubValidated) ||
                      (gitlabEnabled && !gitlabValidated)
                    }
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

              {/* Scope: who can use these credentials */}
              <div className="p-4 rounded-md bg-bg border border-border space-y-3">
                <div>
                  <span className="text-sm font-medium">Who can use these credentials?</span>
                  <p className="text-xs text-text-muted mt-1">
                    Background runs (ticket sync, scheduled tasks, webhooks) have no user context,
                    so they can only see <strong>global</strong> credentials.
                  </p>
                </div>
                <div className="space-y-2">
                  <label
                    className={cn(
                      "flex items-start gap-3 p-3 rounded-md border transition-colors",
                      !canSetGlobalSecrets
                        ? "border-border opacity-50 cursor-not-allowed"
                        : agentSecretScope === "global"
                          ? "border-primary bg-primary/5 cursor-pointer"
                          : "border-border hover:border-text-muted cursor-pointer",
                    )}
                  >
                    <input
                      type="radio"
                      name="agent-scope"
                      checked={agentSecretScope === "global"}
                      onChange={() => setAgentSecretScope("global")}
                      disabled={!canSetGlobalSecrets}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium">
                        Global — recommended for shared instances
                      </span>
                      <p className="text-xs text-text-muted mt-0.5">
                        All users and all background tasks (ticket sync, scheduled, webhooks) can
                        use these credentials.
                        {!canSetGlobalSecrets && (
                          <>
                            {" "}
                            <span className="text-warning">
                              Requires <code>admin</code> role — ask a workspace admin to run setup
                              or store these globally on the Secrets page.
                            </span>
                          </>
                        )}
                      </p>
                    </div>
                  </label>
                  <label
                    className={cn(
                      "flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors",
                      agentSecretScope === "user"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-text-muted",
                    )}
                  >
                    <input
                      type="radio"
                      name="agent-scope"
                      checked={agentSecretScope === "user"}
                      onChange={() => setAgentSecretScope("user")}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium">
                        User-only — just for tasks I create
                      </span>
                      <p className="text-xs text-text-muted mt-0.5">
                        Only tasks you start manually will use these credentials. Background runs
                        like GitHub ticket sync, scheduled triggers, and webhooks will not see them
                        and may fail.
                      </p>
                    </div>
                  </label>
                </div>
              </div>

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
                          ) : oauthExpired ? (
                            <span className="text-xs text-error flex items-center gap-2">
                              <AlertTriangle className="w-3 h-3" /> OAuth token has expired — paste
                              a new one below
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

                  <label
                    className={cn(
                      "flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors",
                      claudeAuthMode === "vertex-ai"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-text-muted",
                    )}
                  >
                    <input
                      type="radio"
                      name="claude-auth"
                      checked={claudeAuthMode === "vertex-ai"}
                      onChange={() => setClaudeAuthMode("vertex-ai")}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium">
                        Use Vertex AI (ADC){" "}
                        <span className="text-text-muted font-normal">— GCP workloads</span>
                      </span>
                      <p className="text-xs text-text-muted mt-0.5">
                        Route Claude API calls through Google Cloud Vertex AI. Supports workload
                        identity or service account keys.
                      </p>
                      {claudeAuthMode === "vertex-ai" && (
                        <div className="mt-2 space-y-2">
                          <input
                            type="text"
                            value={claudeVertexProject}
                            onChange={(e) => setClaudeVertexProject(e.target.value)}
                            placeholder="GCP Project ID (required)"
                            className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                          />
                          <input
                            type="text"
                            value={claudeVertexRegion}
                            onChange={(e) => setClaudeVertexRegion(e.target.value)}
                            placeholder="Region (e.g. us-east5, global)"
                            className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                          />
                          <div className="space-y-1">
                            <label className="text-xs text-text-muted">
                              Service Account Key (optional — uses workload identity if blank)
                            </label>
                            <textarea
                              value={claudeVertexServiceAccountKey}
                              onChange={(e) => {
                                setClaudeVertexServiceAccountKey(e.target.value);
                                setClaudeVertexKeyError("");
                                // Validate JSON on change
                                if (e.target.value.trim()) {
                                  try {
                                    JSON.parse(e.target.value);
                                  } catch {
                                    setClaudeVertexKeyError("Invalid JSON format");
                                  }
                                }
                              }}
                              placeholder='{"type":"service_account",...}'
                              rows={4}
                              className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-xs font-mono focus:outline-none focus:border-primary resize-none"
                            />
                            {claudeVertexKeyError && (
                              <p className="text-error text-xs flex items-center gap-1">
                                <AlertCircle className="w-3 h-3" /> {claudeVertexKeyError}
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </label>
                </div>
              </div>

              {/* OpenAI Codex */}
              <div className="p-4 rounded-md bg-bg border border-border space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    Codex (OpenAI) <span className="text-text-muted font-normal">— optional</span>
                  </span>
                  {codexReady && (
                    <span className="text-success text-xs flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" /> Ready
                    </span>
                  )}
                </div>

                {/* Codex auth mode selector */}
                <div className="space-y-2">
                  <label
                    className={cn(
                      "flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors",
                      codexAuthMode === "app-server"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-text-muted",
                    )}
                  >
                    <input
                      type="radio"
                      name="codex-auth"
                      checked={codexAuthMode === "app-server"}
                      onChange={() => setCodexAuthMode("app-server")}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium">
                        Use ChatGPT subscription (app-server)
                      </span>
                      <p className="text-xs text-text-muted mt-0.5">
                        Run Codex CLI with your ChatGPT Plus/Pro plan — no API key costs. Start the
                        Codex desktop app or run{" "}
                        <code className="px-1 py-0.5 bg-bg-card rounded text-primary text-[11px]">
                          codex --app-server
                        </code>{" "}
                        locally, then provide the WebSocket endpoint below.
                      </p>
                      {codexAuthMode === "app-server" && (
                        <div className="mt-3 space-y-2">
                          <div>
                            <p className="text-xs text-text-muted mb-1.5">
                              App-server WebSocket endpoint:
                            </p>
                            <input
                              type="text"
                              value={codexAppServerUrl}
                              onChange={(e) => setCodexAppServerUrl(e.target.value)}
                              onPaste={(e) => {
                                e.preventDefault();
                                const pasted = e.clipboardData.getData("text").trim();
                                if (pasted) {
                                  setCodexAppServerUrl(pasted);
                                }
                              }}
                              placeholder="ws://localhost:3900/v1/connect"
                              className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary font-mono"
                            />
                          </div>
                          {codexAppServerUrl.trim().length > 0 && (
                            <span className="text-xs text-success flex items-center gap-1">
                              <Check className="w-3 h-3" /> Endpoint configured
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </label>

                  <label
                    className={cn(
                      "flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors",
                      codexAuthMode === "api-key"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-text-muted",
                    )}
                  >
                    <input
                      type="radio"
                      name="codex-auth"
                      checked={codexAuthMode === "api-key"}
                      onChange={() => setCodexAuthMode("api-key")}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium">Use API key</span>
                      <p className="text-xs text-text-muted mt-0.5">
                        Pay-per-use via the OpenAI API. Get a key from platform.openai.com.
                      </p>
                      {codexAuthMode === "api-key" && (
                        <div className="mt-2 space-y-2">
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
                          {openaiValidated && (
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

              {/* Copilot */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-text">
                    Copilot (GitHub) <span className="text-text-muted font-normal">— optional</span>
                  </span>
                  {copilotReady && (
                    <span className="text-success text-xs flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" /> Ready
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  <p className="text-xs text-text-muted">
                    Requires an active GitHub Copilot subscription. Provide a fine-grained PAT with
                    the <strong>Copilot Requests</strong> permission, or an OAuth token (gho_).
                    Classic PATs (ghp_) are not supported.
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={copilotToken}
                      onChange={(e) => {
                        setCopilotToken(e.target.value);
                        setCopilotValidated(false);
                        setCopilotError("");
                      }}
                      onPaste={(e) => {
                        const pasted = e.clipboardData.getData("text");
                        if (pasted) {
                          setCopilotToken(pasted);
                          setCopilotValidated(false);
                          setCopilotError("");
                          setTimeout(() => validateCopilot(pasted), 100);
                        }
                      }}
                      placeholder="github_pat_... or gho_..."
                      className="flex-1 px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                    />
                    <button
                      onClick={() => validateCopilot()}
                      disabled={loading || !copilotToken.trim() || copilotValidated}
                      className="px-3 py-2 rounded-md bg-bg-hover text-sm hover:bg-border disabled:opacity-50"
                    >
                      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Validate"}
                    </button>
                  </div>
                  {copilotError && (
                    <p className="text-error text-xs flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> {copilotError}
                    </p>
                  )}
                  {copilotValidated && (
                    <p className="text-success text-xs flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" /> Token valid
                    </p>
                  )}
                </div>
              </div>

              {/* OpenCode */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-text">
                    OpenCode{" "}
                    <span className="text-text-muted font-normal">— optional, experimental</span>
                  </span>
                  {opencodeReady && (
                    <span className="text-success text-xs flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" /> Ready
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-muted">
                  Provider-agnostic agent. Use the Anthropic/OpenAI keys configured above, or point
                  it at a local OpenAI-compatible endpoint (vLLM, lightllm, Ollama, etc.).
                </p>
                <div className="space-y-2">
                  <label
                    className={cn(
                      "flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors",
                      opencodeMode === "provider-key"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-text-muted",
                    )}
                  >
                    <input
                      type="radio"
                      name="opencode-mode"
                      checked={opencodeMode === "provider-key"}
                      onChange={() => setOpencodeMode("provider-key")}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium">Use provider API key</span>
                      <p className="text-xs text-text-muted mt-0.5">
                        Piggybacks on the Anthropic or OpenAI key configured above.
                      </p>
                      {opencodeMode === "provider-key" && (
                        <p className="text-xs text-text-muted mt-2">
                          {claudeReady || openaiValidated ? (
                            <span className="text-success flex items-center gap-1">
                              <CheckCircle className="w-3 h-3" /> Provider key detected
                            </span>
                          ) : (
                            <span className="flex items-center gap-1">
                              <AlertCircle className="w-3 h-3" /> Configure an Anthropic or OpenAI
                              key above to enable this mode.
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  </label>
                  <label
                    className={cn(
                      "flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors",
                      opencodeMode === "custom-endpoint"
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-text-muted",
                    )}
                  >
                    <input
                      type="radio"
                      name="opencode-mode"
                      checked={opencodeMode === "custom-endpoint"}
                      onChange={() => setOpencodeMode("custom-endpoint")}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <span className="text-sm font-medium">
                        Use custom OpenAI-compatible endpoint
                      </span>
                      <p className="text-xs text-text-muted mt-0.5">
                        For self-hosted inference servers. API key is optional — a placeholder is
                        injected if your endpoint doesn't require one.
                      </p>
                      {opencodeMode === "custom-endpoint" && (
                        <div className="mt-2 space-y-2">
                          <input
                            type="text"
                            value={opencodeBaseUrl}
                            onChange={(e) => setOpencodeBaseUrl(e.target.value)}
                            placeholder="https://your-inference-server/v1"
                            className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                          />
                          <input
                            type="text"
                            value={opencodeDefaultModel}
                            onChange={(e) => setOpencodeDefaultModel(e.target.value)}
                            placeholder="Default model (optional, e.g. openai/gpt-oss-120b)"
                            className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                          />
                          <p className="text-xs text-text-muted">
                            These become defaults for all repos. Each repo can override them in its
                            settings.
                          </p>
                        </div>
                      )}
                    </div>
                  </label>
                </div>
              </div>

              {/* Gemini */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-text">
                    Gemini (Google) <span className="text-text-muted font-normal">— optional</span>
                  </span>
                  {geminiReady && (
                    <span className="text-success text-xs flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" /> Ready
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="space-y-2">
                    <label className="flex items-start gap-2 cursor-pointer p-2 rounded-md hover:bg-bg-hover">
                      <input
                        type="radio"
                        name="gemini-auth-mode"
                        checked={geminiAuthMode === "api-key"}
                        onChange={() => setGeminiAuthMode("api-key")}
                        className="mt-1"
                      />
                      <div className="flex-1">
                        <span className="text-sm font-medium">
                          Use Gemini API key{" "}
                          <span className="text-text-muted font-normal">— pay-per-use</span>
                        </span>
                        <p className="text-xs text-text-muted mt-0.5">
                          Get your API key from{" "}
                          <a
                            href="https://aistudio.google.com/apikey"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                          >
                            Google AI Studio
                          </a>
                          .
                        </p>
                        {geminiAuthMode === "api-key" && (
                          <div className="mt-2 space-y-2">
                            <div className="flex gap-2">
                              <input
                                type="password"
                                value={geminiKey}
                                onChange={(e) => {
                                  setGeminiKey(e.target.value);
                                  setGeminiValidated(false);
                                  setGeminiError("");
                                }}
                                onPaste={(e) => {
                                  const pasted = e.clipboardData.getData("text");
                                  if (pasted) {
                                    setGeminiKey(pasted);
                                    setGeminiValidated(false);
                                    setGeminiError("");
                                    setTimeout(() => validateGemini(pasted), 100);
                                  }
                                }}
                                placeholder="AIza..."
                                className="flex-1 px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                              />
                              <button
                                onClick={() => validateGemini()}
                                disabled={loading || !geminiKey.trim() || geminiValidated}
                                className="px-3 py-2 rounded-md bg-bg-hover text-sm hover:bg-border disabled:opacity-50"
                              >
                                {loading ? (
                                  <Loader2 className="w-4 h-4 animate-spin" />
                                ) : (
                                  "Validate"
                                )}
                              </button>
                            </div>
                            {geminiError && (
                              <p className="text-error text-xs flex items-center gap-1">
                                <AlertCircle className="w-3 h-3" /> {geminiError}
                              </p>
                            )}
                            {geminiValidated && (
                              <p className="text-success text-xs flex items-center gap-1">
                                <CheckCircle className="w-3 h-3" /> API key valid
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </label>
                    <label className="flex items-start gap-2 cursor-pointer p-2 rounded-md hover:bg-bg-hover">
                      <input
                        type="radio"
                        name="gemini-auth-mode"
                        checked={geminiAuthMode === "vertex-ai"}
                        onChange={() => setGeminiAuthMode("vertex-ai")}
                        className="mt-1"
                      />
                      <div className="flex-1">
                        <span className="text-sm font-medium">
                          Use Vertex AI (ADC){" "}
                          <span className="text-text-muted font-normal">— GCP workloads</span>
                        </span>
                        <p className="text-xs text-text-muted mt-0.5">
                          Uses Application Default Credentials. Requires a service account with
                          Vertex AI permissions.
                        </p>
                        {geminiAuthMode === "vertex-ai" && (
                          <div className="mt-2 space-y-2">
                            <input
                              type="text"
                              value={geminiVertexProject}
                              onChange={(e) => setGeminiVertexProject(e.target.value)}
                              placeholder="GCP Project ID"
                              className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                            />
                            <input
                              type="text"
                              value={geminiVertexLocation}
                              onChange={(e) => setGeminiVertexLocation(e.target.value)}
                              placeholder="Location (e.g. us-central1)"
                              className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                            />
                          </div>
                        )}
                      </div>
                    </label>
                  </div>
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
                  onClick={saveAgentKeysStep}
                  disabled={
                    (!claudeReady &&
                      !codexReady &&
                      !copilotReady &&
                      !opencodeReady &&
                      !geminiReady) ||
                    loading
                  }
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
                Optio auto-creates tasks from items labeled{" "}
                <code className="px-1 py-0.5 bg-bg rounded text-primary text-xs">optio</code>. Pick
                which repos to watch — this is optional and can be changed later in Settings.
              </p>

              {/* GitHub Issues — per-repo toggles */}
              {repos.some((r) => isGitHubUrl(r.url)) ? (
                <div className="p-4 rounded-md bg-bg border border-border">
                  <div className="flex items-center gap-2 mb-1">
                    <Github className="w-4 h-4" />
                    <h3 className="text-sm font-semibold">GitHub Issues</h3>
                  </div>
                  <p className="text-xs text-text-muted mb-3">
                    Watch these repos for issues labeled{" "}
                    <code className="px-1 py-0.5 bg-bg-card rounded text-primary">optio</code>.
                  </p>
                  <div className="space-y-2">
                    {repos
                      .filter((r) => isGitHubUrl(r.url))
                      .map((r) => (
                        <label
                          key={r.url}
                          className="flex items-center gap-3 text-sm cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={!!githubIssueRepos[r.url]}
                            onChange={(e) =>
                              setGithubIssueRepos({
                                ...githubIssueRepos,
                                [r.url]: e.target.checked,
                              })
                            }
                            className="w-4 h-4 rounded"
                          />
                          <span className="font-mono text-xs">{r.fullName ?? r.url}</span>
                        </label>
                      ))}
                  </div>
                </div>
              ) : null}

              {/* External trackers — add as many Linear/Notion/Jira as you want */}
              <div className="p-4 rounded-md bg-bg border border-border space-y-3">
                <div>
                  <h3 className="text-sm font-semibold">Third-party trackers</h3>
                  <p className="text-xs text-text-muted mt-1">
                    Optional. Connect Linear, Notion, or Jira — one or more of each. Each tracker is
                    attached to a specific repo.
                  </p>
                </div>

                {addedTrackers.length > 0 && (
                  <div className="space-y-2">
                    {addedTrackers.map((t, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-bg-card border border-border text-sm"
                      >
                        <span className="font-mono text-xs">{t.label}</span>
                        <button
                          onClick={() =>
                            setAddedTrackers((prev) => prev.filter((_, idx) => idx !== i))
                          }
                          className="text-text-muted hover:text-error text-xs"
                          aria-label="Remove tracker"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="pt-3 border-t border-border space-y-3">
                  <div>
                    <label className="block text-xs text-text-muted mb-1">
                      {addedTrackers.length > 0 ? "Add another tracker" : "Add a tracker"}
                    </label>
                    <select
                      value={draftProvider}
                      onChange={(e) =>
                        setDraftProvider(e.target.value as "linear" | "notion" | "jira")
                      }
                      className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                    >
                      <option value="linear">Linear</option>
                      <option value="notion">Notion</option>
                      <option value="jira">Jira</option>
                    </select>
                  </div>

                  {draftProvider === "linear" && (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs text-text-muted mb-1">API Key</label>
                        <input
                          type="password"
                          value={linearApiKey}
                          onChange={(e) => setLinearApiKey(e.target.value)}
                          placeholder="lin_api_..."
                          className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-text-muted mb-1">
                          Team ID (optional)
                        </label>
                        <input
                          value={linearTeamId}
                          onChange={(e) => setLinearTeamId(e.target.value)}
                          className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                        />
                      </div>
                    </div>
                  )}

                  {draftProvider === "notion" && (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs text-text-muted mb-1">
                          Integration Token
                        </label>
                        <input
                          type="password"
                          value={notionApiKey}
                          onChange={(e) => setNotionApiKey(e.target.value)}
                          placeholder="ntn_..."
                          className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                        />
                        <p className="text-xs text-text-muted mt-1">
                          Create an integration at notion.so/my-integrations and share the database
                          with it.
                        </p>
                      </div>
                      <div>
                        <label className="block text-xs text-text-muted mb-1">Database ID</label>
                        <input
                          value={notionDatabaseId}
                          onChange={(e) => setNotionDatabaseId(e.target.value)}
                          placeholder="abc123..."
                          className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                        />
                      </div>
                    </div>
                  )}

                  {draftProvider === "jira" && (
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs text-text-muted mb-1">Base URL</label>
                        <input
                          value={jiraBaseUrl}
                          onChange={(e) => setJiraBaseUrl(e.target.value)}
                          placeholder="https://your-org.atlassian.net"
                          className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs text-text-muted mb-1">Email</label>
                          <input
                            value={jiraEmail}
                            onChange={(e) => setJiraEmail(e.target.value)}
                            className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-text-muted mb-1">API Token</label>
                          <input
                            type="password"
                            value={jiraApiToken}
                            onChange={(e) => setJiraApiToken(e.target.value)}
                            className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs text-text-muted mb-1">
                          Project Key (optional)
                        </label>
                        <input
                          value={jiraProjectKey}
                          onChange={(e) => setJiraProjectKey(e.target.value)}
                          placeholder="ENG"
                          className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                        />
                      </div>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs text-text-muted mb-1">
                      Attach tickets to repo
                    </label>
                    <select
                      value={draftRepoUrl}
                      onChange={(e) => setDraftRepoUrl(e.target.value)}
                      className="w-full px-3 py-2 rounded-md bg-bg-card border border-border text-sm focus:outline-none focus:border-primary"
                    >
                      {repos.length === 0 && <option value="">— No repos selected —</option>}
                      {repos.map((r) => (
                        <option key={r.url} value={r.url}>
                          {r.fullName ?? r.url}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex justify-end">
                    <button
                      onClick={addDraftTracker}
                      disabled={!buildDraftTracker()}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-bg-card border border-border text-sm hover:bg-bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add tracker
                    </button>
                  </div>
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
                  <span>
                    GitHub:{" "}
                    {githubAppConfigured ? "App configured" : (githubUser?.login ?? "configured")}
                  </span>
                </div>
                {claudeReady && (
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle className="w-4 h-4 text-success" />
                    <span>
                      Claude Code:{" "}
                      {claudeAuthMode === "oauth-token"
                        ? "Max/Pro subscription"
                        : claudeAuthMode === "vertex-ai"
                          ? "Vertex AI"
                          : "API key"}
                    </span>
                  </div>
                )}
                {openaiValidated && (
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle className="w-4 h-4 text-success" />
                    <span>OpenAI Codex: ready</span>
                  </div>
                )}
                {geminiReady && (
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle className="w-4 h-4 text-success" />
                    <span>
                      Google Gemini: {geminiAuthMode === "vertex-ai" ? "Vertex AI" : "API key"}
                    </span>
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
                {Object.values(githubIssueRepos).filter(Boolean).length > 0 && (
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle className="w-4 h-4 text-success" />
                    <span>
                      GitHub Issues watching{" "}
                      {Object.values(githubIssueRepos).filter(Boolean).length} repo(s)
                    </span>
                  </div>
                )}
                {addedTrackers.length + (buildDraftTracker() ? 1 : 0) > 0 && (
                  <div className="flex items-center gap-2 text-sm">
                    <CheckCircle className="w-4 h-4 text-success" />
                    <span>
                      {addedTrackers.length + (buildDraftTracker() ? 1 : 0)} external tracker(s)
                      connected
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
