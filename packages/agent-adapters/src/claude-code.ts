import type { AgentTaskInput, AgentContainerConfig, AgentResult } from "@optio/shared";
import { TASK_BRANCH_PREFIX } from "@optio/shared";
import type { AgentAdapter, AgentResultParser } from "./types.js";
import { firstMatch, parseAllLines } from "./types.js";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly type = "claude-code";
  readonly displayName = "Claude Code";

  validateSecrets(availableSecrets: string[]): { valid: boolean; missing: string[] } {
    // ANTHROPIC_API_KEY is only required in api-key mode (checked at runtime).
    // GITHUB_TOKEN is no longer required — GitHub App credential helper handles
    // git auth dynamically, and PAT mode injects it via pod env if available.
    const required: string[] = [];
    const missing = required.filter((s) => !availableSecrets.includes(s));
    return { valid: missing.length === 0, missing };
  }

  buildContainerConfig(input: AgentTaskInput): AgentContainerConfig {
    // Use the pre-rendered prompt from the template system, or fall back to raw prompt
    const prompt = input.renderedPrompt ?? input.prompt;
    const authMode = input.claudeAuthMode ?? "api-key";
    // A gateway run (docs/model-gateway.md): the catalog says what the
    // model's context is, so the `[1m]` suffix is never added to its id.
    const gateway = authMode === "gateway";

    const env: Record<string, string> = {
      OPTIO_TASK_ID: input.taskId,
      OPTIO_REPO_URL: input.repoUrl,
      OPTIO_REPO_BRANCH: input.repoBranch,
      OPTIO_PROMPT: prompt,
      OPTIO_AGENT_TYPE: "claude-code",
      OPTIO_BRANCH_NAME: `${TASK_BRANCH_PREFIX}${input.taskId}`,
      OPTIO_AUTH_MODE: authMode,
    };

    // Pass model info as env vars so buildAgentCommand can add --model flag
    if (input.claudeModel) {
      env.OPTIO_CLAUDE_MODEL = input.claudeModel;
    }
    if (input.claudeContextWindow && !gateway) {
      env.OPTIO_CLAUDE_CONTEXT_WINDOW = input.claudeContextWindow;
    }

    const requiredSecrets: string[] = [];
    const setupFiles: AgentContainerConfig["setupFiles"] = [];

    // Write the task file into the worktree
    if (input.taskFileContent && input.taskFilePath) {
      setupFiles.push({
        path: input.taskFilePath,
        content: input.taskFileContent,
      });
    }

    if (authMode === "api-key") {
      requiredSecrets.push("ANTHROPIC_API_KEY");
    } else if (authMode === "max-subscription") {
      // Max subscription: use CLAUDE_CODE_OAUTH_TOKEN env var
      // The token is fetched from the Optio auth proxy at task execution time
      // and injected as an env var by the task worker
      const apiUrl = input.optioApiUrl ?? "http://host.docker.internal:4000";
      env.OPTIO_API_URL = apiUrl;
      // CLAUDE_CODE_OAUTH_TOKEN will be injected by the task worker after fetching from auth proxy
    } else if (authMode === "vertex-ai") {
      // Vertex AI: authenticate via Google ADC, route through Google Cloud
      // Claude Code reads CLAUDE_CODE_USE_VERTEX=1 + ANTHROPIC_VERTEX_PROJECT_ID + CLOUD_ML_REGION
      env.CLAUDE_CODE_USE_VERTEX = "1";
      if (input.googleCloudProject) {
        env.ANTHROPIC_VERTEX_PROJECT_ID = input.googleCloudProject;
      }
      if (input.googleCloudLocation) {
        env.CLOUD_ML_REGION = input.googleCloudLocation;
      }
      // If a service account key was provided, write it as a setup file and point ADC at it
      if (input.claudeVertexServiceAccountKey) {
        setupFiles.push({
          path: "/home/agent/.config/gcloud/gsa-key.json",
          content: input.claudeVertexServiceAccountKey,
          sensitive: true, // Apply chmod 600 for security
        });
        env.GOOGLE_APPLICATION_CREDENTIALS = "/home/agent/.config/gcloud/gsa-key.json";
      }
      // When no key is provided, rely on workload identity (GKE) or pre-mounted ADC
    } else if (authMode === "bedrock" || gateway) {
      // A model provider: Amazon Bedrock (CLAUDE_CODE_USE_BEDROCK + region +
      // AWS credentials, from bedrockRuntime()) or the organization's model
      // gateway (ANTHROPIC_BASE_URL + the owner's token + the catalog's
      // model, from gatewayRuntime()) — no Anthropic key needed.
      Object.assign(env, input.modelProviderEnv ?? {});
    }

    // Claude Code settings
    const claudeSettings: Record<string, unknown> = {
      hasCompletedOnboarding: true,
    };
    // The WebFetch domain check would call api.anthropic.com: nothing
    // leaves the network on a gateway run.
    if (gateway) claudeSettings.skipWebFetchPreflight = true;
    // Model: format is "sonnet", "opus", "sonnet[1m]", "opus[1m]"
    if (input.claudeModel) {
      const ctx = input.claudeContextWindow === "1m" && !gateway ? "[1m]" : "";
      claudeSettings.model = `${input.claudeModel}${ctx}`;
    }
    // Thinking stays at Claude Code's default (on: adaptive thinking on
    // current models). The settings key only persists effort up to xhigh;
    // CLAUDE_CODE_EFFORT_LEVEL takes every level, max included, for the
    // session (older releases ignore it).
    if (input.claudeEffort) {
      if (input.claudeEffort !== "max") claudeSettings.effortLevel = input.claudeEffort;
      env.CLAUDE_CODE_EFFORT_LEVEL = input.claudeEffort;
    }
    setupFiles.push({
      path: "/home/agent/.claude/settings.json",
      content: JSON.stringify(claudeSettings),
    });

    return {
      env,
      requiredSecrets,
      setupFiles,
    };
  }

  parseResult(exitCode: number, logs: string): AgentResult {
    return parseAllLines(this.createResultParser(), exitCode, logs);
  }

  createResultParser(): AgentResultParser {
    // Match both GitHub PR URLs and GitLab MR URLs (web URLs only, not API URLs)
    const pr = firstMatch(
      /https:\/\/(?![\w.-]+\/api\/)[^\s"]+\/(?:pull\/\d+|-\/merge_requests\/\d+)/,
    );
    // Cost: take the LAST total_cost_usd, not the first. In stream-json mode a
    // multi-turn run (mid-task user messages) emits a `result` event PER TURN,
    // and each result's total_cost_usd is the CUMULATIVE cost of the process so
    // far — so the final result event carries the full spend. Grabbing the first
    // match would drop every turn after the first (issue #541). The authoritative
    // value comes from the last result event (captured below); this last regex
    // match is only a fallback for output whose result event didn't parse as JSON.
    let costFromRegex: number | undefined;

    // Extract error, token usage, model, and result text from Claude's NDJSON events
    let totalInputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let totalOutputTokens = 0;
    let model: string | undefined;

    // Track the final result event — the authoritative signal for how the run
    // ended. With --input-format stream-json each turn emits a result event and
    // the CLI then exits 0 once stdin closes, so the process exit code alone
    // cannot be trusted (see issue #552: an API-error run exited 0).
    let sawResultEvent = false;
    let lastResultIsError = false;
    let lastResultText: string | undefined;
    let lastResultSubtype: string | undefined;
    // Cumulative cost reported by the most recent result event (last wins).
    let lastResultCostUsd: number | undefined;
    // Synthetic assistant text Claude Code emits when an API call fails
    // ("API Error: ..."). Only used as a failure signal when the run never
    // produced a result event (i.e. the error was terminal, not recovered).
    let lastApiErrorText: string | undefined;

    const push = (line: string): void => {
      pr.push(line);
      const costMatches = [...line.matchAll(/"total_cost_usd":\s*([\d.]+)/g)];
      if (costMatches.length > 0) {
        costFromRegex = parseFloat(costMatches[costMatches.length - 1][1]);
      }
      try {
        const event = JSON.parse(line);

        // Extract model from system init event
        if (event.type === "system" && event.subtype === "init" && event.model && !model) {
          model = event.model;
        }

        // Accumulate token usage from assistant messages
        if (event.type === "assistant" && event.message?.usage) {
          const usage = event.message.usage;
          totalInputTokens +=
            (usage.input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0) +
            (usage.cache_read_input_tokens || 0);
          totalOutputTokens += usage.output_tokens || 0;
          cacheReadTokens += usage.cache_read_input_tokens || 0;
          cacheWriteTokens += usage.cache_creation_input_tokens || 0;
          if (!model && event.message.model) {
            model = event.message.model;
          }
        }

        // Track API-error text blocks emitted as synthetic assistant messages
        if (event.type === "assistant" && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (
              block?.type === "text" &&
              typeof block.text === "string" &&
              /^API Error[:\s]/.test(block.text.trim())
            ) {
              lastApiErrorText = block.text.trim();
            }
          }
        }

        // Track the final result event (last one wins across multiple turns)
        if (event.type === "result") {
          sawResultEvent = true;
          lastResultIsError = event.is_error === true;
          lastResultSubtype = typeof event.subtype === "string" ? event.subtype : undefined;
          lastResultText =
            typeof event.result === "string" && event.result ? event.result : undefined;
          // Each result event's total_cost_usd is cumulative for the process,
          // so the last one seen holds the authoritative final cost.
          if (typeof event.total_cost_usd === "number") {
            lastResultCostUsd = event.total_cost_usd;
          }
        }
      } catch {
        // Not JSON, skip
      }
    };

    const finish = (exitCode: number): AgentResult => {
      let error: string | undefined;
      let resultText: string | undefined;
      // Did the agent itself report a terminal, unrecovered error?
      let agentReportedError = false;

      if (sawResultEvent && lastResultIsError) {
        // Terminal error result (e.g. "API Error: Usage credits required") —
        // authoritative failure even when the CLI process exits 0.
        agentReportedError = true;
        error =
          lastResultText ??
          lastApiErrorText ??
          `Agent reported an error result${lastResultSubtype ? ` (${lastResultSubtype})` : ""}`;
      } else if (sawResultEvent) {
        // A successful final result event supersedes any transient API errors
        // the agent recovered from mid-run.
        resultText = lastResultText;
      } else if (lastApiErrorText) {
        // API error with no result event at all — the run died on the error.
        agentReportedError = true;
        error = lastApiErrorText;
      }

      if (exitCode !== 0 && !error) {
        error = `Exit code: ${exitCode}`;
      }

      const success = exitCode === 0 && !agentReportedError;

      // Use the agent's actual result text as the summary when available.
      // When the agent reports an explicit error, surface it in the summary
      // so users see what went wrong without digging into raw logs.
      let summary: string;
      const hasStructuredError = !success && error && error !== `Exit code: ${exitCode}`;
      if (hasStructuredError) {
        const preview = error!.length > 500 ? error!.slice(0, 500) + "…" : error!;
        summary = `Agent error: ${preview}`;
      } else if (!success) {
        summary = `Agent exited with code ${exitCode}`;
      } else if (resultText) {
        // Truncate very long result texts for the summary field
        summary = resultText.length > 2000 ? resultText.slice(0, 2000) + "…" : resultText;
      } else {
        summary = "Agent completed successfully";
      }

      return {
        success,
        prUrl: pr.value?.[0],
        costUsd: lastResultCostUsd ?? costFromRegex,
        costBasis: "reported",
        cacheReadTokens,
        cacheWriteTokens,
        inputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
        outputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
        model,
        summary,
        error,
      };
    };

    return { push, finish };
  }
}
