import type {
  AgentTaskInput,
  AgentContainerConfig,
  AgentResult,
  CodexAuthMode,
} from "@optio/shared";
import { TASK_BRANCH_PREFIX } from "@optio/shared";
import type { AgentAdapter } from "./types.js";

/**
 * Codex CLI (codex exec --full-auto --json) outputs NDJSON events.
 * Each line is a JSON object. Known event shapes:
 *
 * - { type: "message", role: "assistant"|"system", content: "..." }
 * - { type: "function_call", name: "shell"|"...", call_id: "...", arguments: "..." }
 * - { type: "function_call_output", call_id: "...", output: "..." }
 * - { type: "error", message: "..." }
 * - { error: { message: "...", type: "...", code: "..." } }  (OpenAI API error envelope)
 * - { type: "usage", ... } or inline usage in final message
 *
 * The final summary event may contain usage data with input_tokens / output_tokens.
 */

/** Known Codex-compatible model pricing (USD per 1M tokens) */
const CODEX_MODEL_PRICING: Record<string, { input: number; output: number; cachedInput?: number }> =
  {
    "codex-mini": { input: 1.5, output: 6.0, cachedInput: 0.375 },
    "o4-mini": { input: 1.1, output: 4.4, cachedInput: 0.275 },
    o3: { input: 10.0, output: 40.0, cachedInput: 2.5 },
    "gpt-4.1": { input: 2.0, output: 8.0, cachedInput: 0.5 },
    "gpt-4.1-mini": { input: 0.4, output: 1.6, cachedInput: 0.1 },
    "gpt-4.1-nano": { input: 0.1, output: 0.4, cachedInput: 0.025 },
  };

const DEFAULT_PRICING = CODEX_MODEL_PRICING["codex-mini"];

export class CodexAdapter implements AgentAdapter {
  readonly type = "codex";
  readonly displayName = "OpenAI Codex";

  validateSecrets(
    availableSecrets: string[],
    codexAuthMode?: CodexAuthMode,
  ): { valid: boolean; missing: string[] } {
    const required: string[] = [];
    // In app-server mode, no OpenAI API key is needed — the CLI connects to
    // a local app-server endpoint that handles auth via the user's ChatGPT plan.
    if (codexAuthMode !== "app-server") {
      required.push("OPENAI_API_KEY");
    }
    const missing = required.filter((s) => !availableSecrets.includes(s));
    return { valid: missing.length === 0, missing };
  }

  buildContainerConfig(input: AgentTaskInput): AgentContainerConfig {
    // Use the pre-rendered prompt from the template system, or fall back to raw prompt
    const prompt = input.renderedPrompt ?? this.buildPrompt(input);

    const env: Record<string, string> = {
      OPTIO_TASK_ID: input.taskId,
      OPTIO_REPO_URL: input.repoUrl,
      OPTIO_REPO_BRANCH: input.repoBranch,
      OPTIO_PROMPT: prompt,
      OPTIO_AGENT_TYPE: "codex",
      OPTIO_BRANCH_NAME: `${TASK_BRANCH_PREFIX}${input.taskId}`,
    };

    const requiredSecrets: string[] = [];

    if (input.codexAuthMode === "app-server") {
      env.OPTIO_CODEX_AUTH_MODE = "app-server";
      if (input.codexAppServerUrl) {
        env.OPTIO_CODEX_APP_SERVER_URL = input.codexAppServerUrl;
      }
    } else {
      env.OPTIO_CODEX_AUTH_MODE = "api-key";
      requiredSecrets.push("OPENAI_API_KEY");
    }

    const setupFiles: AgentContainerConfig["setupFiles"] = [];

    // Write the task file into the worktree
    if (input.taskFileContent && input.taskFilePath) {
      setupFiles.push({
        path: input.taskFilePath,
        content: input.taskFileContent,
      });
    }

    return {
      command: ["/opt/optio/entrypoint.sh"],
      env,
      requiredSecrets,
      setupFiles,
    };
  }

  parseResult(exitCode: number, logs: string): AgentResult {
    // Extract PR URL from anywhere in the logs
    const prMatch = logs.match(/https:\/\/github\.com\/[^\s"]+\/pull\/\d+/);

    // Parse NDJSON lines to extract structured data
    const { costUsd, errorMessage, hasError, summary } = this.parseLogs(logs);

    const success = exitCode === 0 && !hasError;

    return {
      success,
      prUrl: prMatch?.[0],
      costUsd,
      summary:
        summary ??
        (success ? "Agent completed successfully" : `Agent exited with code ${exitCode}`),
      error: !success ? (errorMessage ?? `Exit code: ${exitCode}`) : undefined,
    };
  }

  private parseLogs(logs: string): {
    costUsd?: number;
    errorMessage?: string;
    hasError: boolean;
    summary?: string;
  } {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let directCost: number | undefined;
    let model: string | undefined;
    let errorMessage: string | undefined;
    let hasError = false;
    let lastAssistantMessage: string | undefined;

    for (const line of logs.split("\n")) {
      if (!line.trim()) continue;

      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        // Not JSON — check for error patterns in raw text
        if (!errorMessage && isRawTextError(line)) {
          errorMessage = line.trim();
          hasError = true;
          // Log raw error for diagnostics (helps catch API key issues, auth failures, etc.)
          console.warn(`[codex] Raw error: ${errorMessage}`);
        }
        continue;
      }

      // Extract model name
      if (event.model && !model) {
        model = event.model;
      }

      // OpenAI structured API error envelope: { error: { message, type, code } }
      if (event.error && typeof event.error === "object" && event.error.message) {
        errorMessage = event.error.message;
        hasError = true;
        continue;
      }

      // Error events: { type: "error", message: "..." }
      if (event.type === "error") {
        errorMessage = event.message ?? event.error ?? JSON.stringify(event);
        hasError = true;
        continue;
      }

      // Track assistant messages for summary
      if (event.type === "message" && event.role === "assistant" && event.content) {
        if (typeof event.content === "string") {
          lastAssistantMessage = event.content;
        }
      }

      // Extract usage data — may appear in multiple places
      const usage = event.usage ?? event.response?.usage;
      if (usage) {
        if (usage.input_tokens) totalInputTokens += usage.input_tokens;
        if (usage.output_tokens) totalOutputTokens += usage.output_tokens;
        if (usage.cache_creation_input_tokens)
          totalInputTokens += usage.cache_creation_input_tokens;
        if (usage.cache_read_input_tokens) totalInputTokens += usage.cache_read_input_tokens;
        // Also handle OpenAI-style naming
        if (usage.prompt_tokens) totalInputTokens += usage.prompt_tokens;
        if (usage.completion_tokens) totalOutputTokens += usage.completion_tokens;
        // Cached tokens (discounted pricing)
        if (usage.cached_tokens) totalCachedTokens += usage.cached_tokens;
        if (usage.prompt_tokens_details?.cached_tokens)
          totalCachedTokens += usage.prompt_tokens_details.cached_tokens;
      }

      // Capture direct cost without returning early — subsequent lines may
      // contain error events or additional messages that we still need to parse.
      if (event.total_cost_usd != null) {
        directCost = event.total_cost_usd;
      }
    }

    // Prefer direct cost from the agent over token-calculated cost
    let costUsd: number | undefined = directCost;
    if (costUsd == null && (totalInputTokens > 0 || totalOutputTokens > 0)) {
      const pricing = model ? (CODEX_MODEL_PRICING[model] ?? DEFAULT_PRICING) : DEFAULT_PRICING;
      // Cached tokens are a subset of input tokens and charged at a discounted rate
      const nonCachedInputTokens = Math.max(0, totalInputTokens - totalCachedTokens);
      const cachedRate = pricing.cachedInput ?? pricing.input * 0.25;
      costUsd =
        (nonCachedInputTokens / 1_000_000) * pricing.input +
        (totalCachedTokens / 1_000_000) * cachedRate +
        (totalOutputTokens / 1_000_000) * pricing.output;
    }

    return {
      costUsd,
      errorMessage,
      hasError,
      summary: lastAssistantMessage ? truncate(lastAssistantMessage, 200) : undefined,
    };
  }

  private buildPrompt(input: AgentTaskInput): string {
    const parts = [input.prompt, "", "Instructions:", "- Work on the task described above."];
    if (input.taskFilePath) {
      parts.push(`- Read the task file at ${input.taskFilePath} for full details.`);
    }
    parts.push(
      "- When you are done, create a pull request using the gh CLI.",
      `- Use branch name: ${TASK_BRANCH_PREFIX}${input.taskId}`,
      "- Write a clear PR title and description summarizing your changes.",
    );
    if (input.additionalContext) {
      parts.push("", "Additional context:", input.additionalContext);
    }
    return parts.join("\n");
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "\u2026";
}

/** Detect common Codex/OpenAI error patterns in non-JSON output lines */
function isRawTextError(line: string): boolean {
  // Auth / API key errors
  if (
    /error|failed|fatal/i.test(line) &&
    /OPENAI_API_KEY|api\.openai\.com|authentication|unauthorized|quota/i.test(line)
  ) {
    return true;
  }
  // Model not found
  if (/model.*not found|model_not_found|does not exist|invalid.*model/i.test(line)) {
    return true;
  }
  // Context length exceeded
  if (/context.?length|maximum.?context|token.?limit|too many tokens/i.test(line)) {
    return true;
  }
  // Content filter / safety
  if (/content.?filter|content.?policy|safety.?system|flagged/i.test(line)) {
    return true;
  }
  // Server errors
  if (/server.?error|internal.?error|service.?unavailable|503|502/i.test(line)) {
    return true;
  }
  return false;
}
