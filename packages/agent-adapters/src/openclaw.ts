import type { AgentTaskInput, AgentContainerConfig, AgentResult } from "@optio/shared";
import { TASK_BRANCH_PREFIX } from "@optio/shared";
import type { AgentAdapter } from "./types.js";

/**
 * OpenClaw CLI (openclaw agent --output-format stream-json) outputs NDJSON events.
 * Each line is a JSON object. The format is similar to Claude Code's NDJSON:
 *
 * - { type: "message", role: "assistant"|"system", content: "..." }
 * - { type: "tool_call", name: "...", call_id: "...", arguments: "..." }
 * - { type: "tool_result", call_id: "...", output: "..." }
 * - { type: "error", message: "..." }
 * - { type: "result", result: "...", total_cost_usd, session_id }
 * - Events with usage data (input_tokens, output_tokens)
 *
 * The parser is conservative — unrecognized events are skipped.
 */

export class OpenClawAdapter implements AgentAdapter {
  readonly type = "openclaw";
  readonly displayName = "OpenClaw";

  validateSecrets(availableSecrets: string[]): { valid: boolean; missing: string[] } {
    // OpenClaw is provider-agnostic — it needs at least one provider API key
    const acceptedKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCLAW_API_KEY"];
    const hasAny = acceptedKeys.some((k) => availableSecrets.includes(k));
    return {
      valid: hasAny,
      missing: hasAny ? [] : ["ANTHROPIC_API_KEY or OPENAI_API_KEY or OPENCLAW_API_KEY"],
    };
  }

  buildContainerConfig(input: AgentTaskInput): AgentContainerConfig {
    const prompt = input.renderedPrompt ?? input.prompt;

    const env: Record<string, string> = {
      OPTIO_TASK_ID: input.taskId,
      OPTIO_REPO_URL: input.repoUrl,
      OPTIO_REPO_BRANCH: input.repoBranch,
      OPTIO_PROMPT: prompt,
      OPTIO_AGENT_TYPE: "openclaw",
      OPTIO_BRANCH_NAME: `${TASK_BRANCH_PREFIX}${input.taskId}`,
    };

    // OpenClaw reads provider-specific env vars directly (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
    // These are injected via requiredSecrets
    const requiredSecrets: string[] = [];

    // Determine which provider keys to request based on what's configured
    // The task worker resolves these against available secrets
    requiredSecrets.push("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENCLAW_API_KEY");

    const setupFiles: AgentContainerConfig["setupFiles"] = [];

    // Set model if configured
    if (input.openclawModel) {
      env.OPTIO_OPENCLAW_MODEL = input.openclawModel;
    }
    // Set named agent if configured
    if (input.openclawAgent) {
      env.OPTIO_OPENCLAW_AGENT = input.openclawAgent;
    }

    // Pre-seed a minimal openclaw config so the CLI doesn't hit first-run setup
    setupFiles.push({
      path: "/home/agent/.openclaw/config.json",
      content: JSON.stringify({ $schema: "https://openclaw.dev/config.json" }),
    });

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
    const prMatch = logs.match(
      /https:\/\/(?![\w.-]+\/api\/)[^\s"]+\/(?:pull\/\d+|-\/merge_requests\/\d+)/,
    );
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

      // Result event with summary
      if (event.type === "result" && event.result && !event.is_error) {
        if (typeof event.result === "string") {
          lastAssistantMessage = event.result;
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

    // OpenClaw is provider-agnostic — cost may not be available.
    // Use direct cost if reported, otherwise leave undefined.
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

/** Detect common OpenClaw error patterns in non-JSON output lines */
function isRawTextError(line: string): boolean {
  // Auth / API key errors
  if (
    /error|failed|fatal/i.test(line) &&
    /ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENCLAW_API_KEY|api.?key|authentication|unauthorized|forbidden/i.test(
      line,
    )
  ) {
    return true;
  }
  // Provider errors
  if (/invalid.*key|key.*invalid|api.*error/i.test(line)) {
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
