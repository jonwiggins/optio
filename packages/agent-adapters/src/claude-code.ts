import type { AgentTaskInput, AgentContainerConfig, AgentResult } from "@optio/shared";
import { TASK_BRANCH_PREFIX } from "@optio/shared";
import type { AgentAdapter } from "./types.js";

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
    if (input.claudeContextWindow) {
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
    }

    // Claude Code settings
    const claudeSettings: Record<string, unknown> = {
      hasCompletedOnboarding: true,
    };
    // Model: format is "sonnet", "opus", "sonnet[1m]", "opus[1m]"
    if (input.claudeModel) {
      const ctx = input.claudeContextWindow === "1m" ? "[1m]" : "";
      claudeSettings.model = `${input.claudeModel}${ctx}`;
    }
    if (input.claudeThinking !== undefined) {
      claudeSettings.alwaysThinkingEnabled = input.claudeThinking;
    }
    if (input.claudeEffort) {
      claudeSettings.effortLevel = input.claudeEffort;
    }
    setupFiles.push({
      path: "/home/agent/.claude/settings.json",
      content: JSON.stringify(claudeSettings),
    });

    return {
      command: ["/opt/optio/entrypoint.sh"],
      env,
      requiredSecrets,
      setupFiles,
    };
  }

  parseResult(exitCode: number, logs: string): AgentResult {
    // Match both GitHub PR URLs and GitLab MR URLs (web URLs only, not API URLs)
    const prMatch = logs.match(
      /https:\/\/(?![\w.-]+\/api\/)[^\s"]+\/(?:pull\/\d+|-\/merge_requests\/\d+)/,
    );
    const costMatch = logs.match(/"total_cost_usd":\s*([\d.]+)/);

    // Extract error, token usage, model, and result text from Claude's NDJSON events
    let error: string | undefined;
    let resultText: string | undefined;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let model: string | undefined;

    for (const line of logs.split("\n")) {
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
          if (!model && event.message.model) {
            model = event.message.model;
          }
        }

        // Extract result text from the final result event
        if (event.type === "result" && event.result) {
          if (event.is_error && exitCode !== 0) {
            error = event.result;
          } else if (!event.is_error) {
            resultText = event.result;
          }
        }
      } catch {
        // Not JSON, skip
      }
    }

    if (exitCode !== 0 && !error) {
      error = `Exit code: ${exitCode}`;
    }

    // Use the agent's actual result text as the summary when available.
    // When the agent reports an explicit error, surface it in the summary
    // so users see what went wrong without digging into raw logs.
    let summary: string;
    const hasStructuredError = exitCode !== 0 && error && error !== `Exit code: ${exitCode}`;
    if (hasStructuredError) {
      const preview = error!.length > 500 ? error!.slice(0, 500) + "…" : error!;
      summary = `Agent error: ${preview}`;
    } else if (exitCode !== 0) {
      summary = `Agent exited with code ${exitCode}`;
    } else if (resultText) {
      // Truncate very long result texts for the summary field
      summary = resultText.length > 2000 ? resultText.slice(0, 2000) + "…" : resultText;
    } else {
      summary = "Agent completed successfully";
    }

    return {
      success: exitCode === 0,
      prUrl: prMatch?.[0],
      costUsd: costMatch ? parseFloat(costMatch[1]) : undefined,
      inputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
      outputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
      model,
      summary,
      error,
    };
  }
}
