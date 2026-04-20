import type {
  AgentTaskInput,
  AgentContainerConfig,
  AgentResult,
  GeminiAuthMode,
} from "@optio/shared";
import { TASK_BRANCH_PREFIX } from "@optio/shared";
import type { AgentAdapter } from "./types.js";

/**
 * Gemini CLI (`gemini -p ... --output-format stream-json`) outputs NDJSON events.
 * Each line is a JSON object. Known event shapes:
 *
 * - { type: "init", session_id: "...", model: "..." }
 * - { type: "message", role: "assistant"|"system", content: "..." }
 * - { type: "tool_use", name: "...", arguments: {...}, call_id: "..." }
 * - { type: "tool_result", call_id: "...", output: "..." }
 * - { type: "error", message: "..." }
 * - { type: "result", stats: { per-model usage } }
 */

/** Known Gemini model pricing (USD per 1M tokens) */
const GEMINI_MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-3-pro": { input: 1.25, output: 10.0 },
  "gemini-3-flash": { input: 0.15, output: 0.6 },
};

const DEFAULT_PRICING = GEMINI_MODEL_PRICING["gemini-2.5-pro"];

export class GeminiAdapter implements AgentAdapter {
  readonly type = "gemini";
  readonly displayName = "Google Gemini";

  validateSecrets(
    availableSecrets: string[],
    geminiAuthMode?: GeminiAuthMode,
  ): { valid: boolean; missing: string[] } {
    const required: string[] = [];
    // In vertex-ai mode, authentication is via ADC — no API key needed.
    if (geminiAuthMode !== "vertex-ai") {
      // Accept either GEMINI_API_KEY or GOOGLE_API_KEY
      if (
        !availableSecrets.includes("GEMINI_API_KEY") &&
        !availableSecrets.includes("GOOGLE_API_KEY")
      ) {
        required.push("GEMINI_API_KEY");
      }
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
      OPTIO_AGENT_TYPE: "gemini",
      OPTIO_BRANCH_NAME: `${TASK_BRANCH_PREFIX}${input.taskId}`,
    };

    const requiredSecrets: string[] = [];

    if (input.geminiAuthMode === "vertex-ai") {
      env.OPTIO_GEMINI_AUTH_MODE = "vertex-ai";
      env.GOOGLE_GENAI_USE_VERTEXAI = "true";
      if (input.googleCloudProject) {
        env.GOOGLE_CLOUD_PROJECT = input.googleCloudProject;
      }
      if (input.googleCloudLocation) {
        env.GOOGLE_CLOUD_LOCATION = input.googleCloudLocation;
      }
    } else {
      env.OPTIO_GEMINI_AUTH_MODE = "api-key";
      requiredSecrets.push("GEMINI_API_KEY");
    }

    if (input.geminiModel) {
      env.OPTIO_GEMINI_MODEL = input.geminiModel;
    }

    const setupFiles: AgentContainerConfig["setupFiles"] = [];

    // Write the task file into the worktree
    if (input.taskFileContent && input.taskFilePath) {
      setupFiles.push({
        path: input.taskFilePath,
        content: input.taskFileContent,
      });
    }

    // Write Gemini settings file
    const approvalMode = input.geminiApprovalMode ?? "yolo";
    const authType = input.geminiAuthMode === "vertex-ai" ? "vertex-ai" : "gemini-api-key";
    const maxSessionTurns = input.maxTurnsCoding ?? 250;
    const geminiSettings = {
      security: { auth: { selectedType: authType } },
      model: { maxSessionTurns },
      general: { defaultApprovalMode: approvalMode },
      telemetry: { enabled: false },
    };
    setupFiles.push({
      path: "/home/agent/.gemini/settings.json",
      content: JSON.stringify(geminiSettings, null, 2),
    });

    return {
      command: ["/opt/optio/entrypoint.sh"],
      env,
      requiredSecrets,
      setupFiles,
    };
  }

  parseResult(exitCode: number, logs: string): AgentResult {
    // Extract PR URL from anywhere in the logs (GitHub PR + GitLab MR)
    const prMatch = logs.match(
      /https:\/\/(?![\w.-]+\/api\/)[^\s"]+\/(?:pull\/\d+|-\/merge_requests\/\d+)/,
    );

    // Parse NDJSON lines to extract structured data
    const { costUsd, errorMessage, hasError, summary, inputTokens, outputTokens, model } =
      this.parseLogs(logs);

    const success = exitCode === 0 && !hasError;

    return {
      success,
      prUrl: prMatch?.[0],
      costUsd,
      summary:
        summary ??
        (success ? "Agent completed successfully" : `Agent exited with code ${exitCode}`),
      error: !success ? (errorMessage ?? `Exit code: ${exitCode}`) : undefined,
      inputTokens,
      outputTokens,
      model,
    };
  }

  private parseLogs(logs: string): {
    costUsd?: number;
    errorMessage?: string;
    hasError: boolean;
    summary?: string;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
  } {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
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
        }
        continue;
      }

      // Extract model name from init or result events
      if (event.model && !model) {
        model = event.model;
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

      // Result event with stats — per-model usage
      if (event.type === "result" && event.stats) {
        // stats may be an object keyed by model name with input_tokens/output_tokens
        const stats = event.stats;
        if (typeof stats === "object") {
          // If stats has per-model breakdown: { "gemini-2.5-pro": { input_tokens, output_tokens } }
          for (const [key, value] of Object.entries(stats)) {
            if (typeof value === "object" && value !== null) {
              const s = value as Record<string, unknown>;
              if (typeof s.input_tokens === "number") totalInputTokens += s.input_tokens;
              if (typeof s.output_tokens === "number") totalOutputTokens += s.output_tokens;
              if (typeof s.cache_creation_input_tokens === "number")
                totalInputTokens += s.cache_creation_input_tokens;
              if (typeof s.cache_read_input_tokens === "number")
                totalInputTokens += s.cache_read_input_tokens;
              if (!model) model = key;
            }
          }
          // Also handle flat stats: { input_tokens, output_tokens }
          if (typeof stats.input_tokens === "number") totalInputTokens += stats.input_tokens;
          if (typeof stats.output_tokens === "number") totalOutputTokens += stats.output_tokens;
          if (typeof stats.cache_creation_input_tokens === "number")
            totalInputTokens += stats.cache_creation_input_tokens;
          if (typeof stats.cache_read_input_tokens === "number")
            totalInputTokens += stats.cache_read_input_tokens;
        }
      }

      // Extract usage data from inline usage objects
      const usage = event.usage;
      if (usage) {
        if (usage.input_tokens) totalInputTokens += usage.input_tokens;
        if (usage.output_tokens) totalOutputTokens += usage.output_tokens;
        if (usage.cache_creation_input_tokens)
          totalInputTokens += usage.cache_creation_input_tokens;
        if (usage.cache_read_input_tokens) totalInputTokens += usage.cache_read_input_tokens;
      }
    }

    // Calculate cost from token counts
    let costUsd: number | undefined;
    if (totalInputTokens > 0 || totalOutputTokens > 0) {
      const pricing = model ? (GEMINI_MODEL_PRICING[model] ?? DEFAULT_PRICING) : DEFAULT_PRICING;
      costUsd =
        (totalInputTokens / 1_000_000) * pricing.input +
        (totalOutputTokens / 1_000_000) * pricing.output;
    }

    return {
      costUsd,
      errorMessage,
      hasError,
      summary: lastAssistantMessage ? truncate(lastAssistantMessage, 200) : undefined,
      inputTokens: totalInputTokens || undefined,
      outputTokens: totalOutputTokens || undefined,
      model,
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

/** Detect common Gemini error patterns in non-JSON output lines */
function isRawTextError(line: string): boolean {
  // Auth / API key errors
  if (
    /error|failed|fatal/i.test(line) &&
    /GEMINI_API_KEY|GOOGLE_API_KEY|generativelanguage|permission denied|unauthorized/i.test(line)
  ) {
    return true;
  }
  // Vertex AI errors
  if (/error|failed/i.test(line) && /vertex|adc|application.?default.?credentials/i.test(line)) {
    return true;
  }
  // Quota / rate limit
  if (/quota|rate.?limit|resource.?exhausted|429/i.test(line)) {
    return true;
  }
  // Model not found
  if (/model.*not found|model_not_found|does not exist|invalid.*model/i.test(line)) {
    return true;
  }
  // Turn limit exceeded (exit code 53)
  if (/turn.?limit|max.*turns|session.*turns/i.test(line)) {
    return true;
  }
  // Server errors
  if (/server.?error|internal.?error|service.?unavailable|503|502/i.test(line)) {
    return true;
  }
  return false;
}
