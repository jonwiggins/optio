import type { AgentTaskInput, AgentContainerConfig, AgentResult } from "@optio/shared";
import { TASK_BRANCH_PREFIX } from "@optio/shared";
import type { AgentAdapter } from "./types.js";

/**
 * Copilot CLI (copilot --autopilot --output-format json) outputs NDJSON events.
 * Each line is a JSON object. The exact schema is not fully documented, but known shapes include:
 *
 * - { type: "message", role: "assistant"|"system", content: "..." }
 * - { type: "function_call", name: "shell"|"...", call_id: "...", arguments: "..." }
 * - { type: "function_call_output", call_id: "...", output: "..." }
 * - { type: "error", message: "..." }
 * - Events with usage data (input_tokens, output_tokens)
 *
 * The parser is conservative — unrecognized events are skipped.
 */

export class CopilotAdapter implements AgentAdapter {
  readonly type = "copilot";
  readonly displayName = "GitHub Copilot";

  validateSecrets(availableSecrets: string[]): { valid: boolean; missing: string[] } {
    const required = ["COPILOT_GITHUB_TOKEN"];
    const missing = required.filter((s) => !availableSecrets.includes(s));
    return { valid: missing.length === 0, missing };
  }

  buildContainerConfig(input: AgentTaskInput): AgentContainerConfig {
    const prompt = input.renderedPrompt ?? input.prompt;

    const env: Record<string, string> = {
      OPTIO_TASK_ID: input.taskId,
      OPTIO_REPO_URL: input.repoUrl,
      OPTIO_REPO_BRANCH: input.repoBranch,
      OPTIO_PROMPT: prompt,
      OPTIO_AGENT_TYPE: "copilot",
      OPTIO_BRANCH_NAME: `${TASK_BRANCH_PREFIX}${input.taskId}`,
    };

    const requiredSecrets = ["COPILOT_GITHUB_TOKEN"];
    const setupFiles: AgentContainerConfig["setupFiles"] = [];

    // Copilot reads COPILOT_MODEL env var for model selection
    if (input.copilotModel) {
      env.COPILOT_MODEL = input.copilotModel;
    }
    if (input.copilotEffort) {
      env.COPILOT_EFFORT = input.copilotEffort;
    }

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
    const prMatch = logs.match(/https:\/\/github\.com\/[^\s"]+\/pull\/\d+/);
    const { costUsd, errorMessage, hasError, summary, inputTokens, outputTokens, model } =
      this.parseLogs(logs);

    const success = exitCode === 0 && !hasError;

    return {
      success,
      prUrl: prMatch?.[0],
      costUsd,
      inputTokens,
      outputTokens,
      model,
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
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
  } {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
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
        if (!errorMessage && isRawTextError(line)) {
          errorMessage = line.trim();
          hasError = true;
          // Log raw error for diagnostics (helps catch API key issues, auth failures, etc.)
          console.warn(`[copilot] Raw error: ${errorMessage}`);
        }
        continue;
      }

      // Extract model name
      if (event.model && !model) {
        model = event.model;
      }

      // Error envelope: { error: { message, type, code } }
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

      // Result with is_error flag
      if (event.is_error === true && event.result) {
        errorMessage =
          typeof event.result === "string" ? event.result : JSON.stringify(event.result);
        hasError = true;
        continue;
      }

      // Track assistant messages for summary
      if (event.type === "message" && event.role === "assistant" && event.content) {
        if (typeof event.content === "string") {
          lastAssistantMessage = event.content;
        }
      }

      // Extract usage data
      const usage = event.usage ?? event.response?.usage;
      if (usage) {
        if (usage.input_tokens) totalInputTokens += usage.input_tokens;
        if (usage.output_tokens) totalOutputTokens += usage.output_tokens;
        if (usage.cache_creation_input_tokens)
          totalInputTokens += usage.cache_creation_input_tokens;
        if (usage.cache_read_input_tokens) totalInputTokens += usage.cache_read_input_tokens;
        if (usage.prompt_tokens) totalInputTokens += usage.prompt_tokens;
        if (usage.completion_tokens) totalOutputTokens += usage.completion_tokens;
      }

      if (event.total_cost_usd != null) {
        directCost = event.total_cost_usd;
      }
    }

    // Copilot usage is subscription-based, so cost may not be available.
    // Use direct cost if reported, otherwise leave undefined (no per-token pricing).
    const costUsd = directCost;

    return {
      costUsd,
      errorMessage,
      hasError,
      summary: lastAssistantMessage ? truncate(lastAssistantMessage, 200) : undefined,
      inputTokens: totalInputTokens > 0 ? totalInputTokens : undefined,
      outputTokens: totalOutputTokens > 0 ? totalOutputTokens : undefined,
      model,
    };
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "\u2026";
}

/** Detect common Copilot error patterns in non-JSON output lines */
function isRawTextError(line: string): boolean {
  // Auth / token errors
  if (
    /error|failed|fatal/i.test(line) &&
    /COPILOT_GITHUB_TOKEN|copilot.*auth|authentication|unauthorized|forbidden/i.test(line)
  ) {
    return true;
  }
  // Subscription errors
  if (/subscription.*required|copilot.*not.*enabled|no.*copilot.*access/i.test(line)) {
    return true;
  }
  // Classic PAT not supported
  if (/classic.*pat.*not.*supported|ghp_.*not.*supported/i.test(line)) {
    return true;
  }
  // Model not found
  if (/model.*not found|model_not_found|does not exist|invalid.*model/i.test(line)) {
    return true;
  }
  // Server errors
  if (/server.?error|internal.?error|service.?unavailable|503|502/i.test(line)) {
    return true;
  }
  return false;
}
