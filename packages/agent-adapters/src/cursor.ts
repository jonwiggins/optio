import type { AgentTaskInput, AgentContainerConfig, AgentResult } from "@optio/shared";
import { TASK_BRANCH_PREFIX } from "@optio/shared";
import type { AgentAdapter } from "./types.js";

/**
 * Cursor CLI (cursor-agent --print --output-format stream-json) emits NDJSON
 * events, one JSON object per line:
 *
 * - { type: "system", subtype: "init", session_id, model, permissionMode, apiKeySource, cwd }
 * - { type: "user", message: { role: "user", content: [...] } }
 * - { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }
 *   (one line per complete assistant message segment between tool calls)
 * - { type: "tool_call", subtype: "started"|"completed", call_id, tool_call: {...} }
 * - { type: "result", subtype: "success", duration_ms, duration_api_ms, is_error,
 *     result: "<final text>", session_id, request_id }
 *
 * Auth is CURSOR_API_KEY. The CLI does not report token usage or cost —
 * billing happens on the Cursor account — so costUsd stays undefined.
 */

export class CursorAdapter implements AgentAdapter {
  readonly type = "cursor";
  readonly displayName = "Cursor";

  validateSecrets(availableSecrets: string[]): { valid: boolean; missing: string[] } {
    const missing = availableSecrets.includes("CURSOR_API_KEY") ? [] : ["CURSOR_API_KEY"];
    return { valid: missing.length === 0, missing };
  }

  buildContainerConfig(input: AgentTaskInput): AgentContainerConfig {
    const prompt = input.renderedPrompt ?? input.prompt;

    const env: Record<string, string> = {
      OPTIO_TASK_ID: input.taskId,
      OPTIO_REPO_URL: input.repoUrl,
      OPTIO_REPO_BRANCH: input.repoBranch,
      OPTIO_PROMPT: prompt,
      OPTIO_AGENT_TYPE: "cursor",
      OPTIO_BRANCH_NAME: `${TASK_BRANCH_PREFIX}${input.taskId}`,
    };

    // Model slug passed to `cursor-agent --model` (e.g. "composer-2.5").
    // Unset means the CLI's account default.
    if (input.cursorModel) {
      env.OPTIO_CURSOR_MODEL = input.cursorModel;
    }

    const setupFiles: AgentContainerConfig["setupFiles"] = [];
    if (input.taskFileContent && input.taskFilePath) {
      setupFiles.push({
        path: input.taskFilePath,
        content: input.taskFileContent,
      });
    }

    return {
      command: ["/opt/optio/entrypoint.sh"],
      env,
      requiredSecrets: ["CURSOR_API_KEY"],
      setupFiles,
    };
  }

  parseResult(exitCode: number, logs: string): AgentResult {
    const prMatch = logs.match(
      /https:\/\/(?![\w.-]+\/api\/)[^\s"]+\/(?:pull\/\d+|-\/merge_requests\/\d+)/,
    );
    const { errorMessage, hasError, summary, model } = this.parseLogs(logs);

    const success = exitCode === 0 && !hasError;

    return {
      success,
      prUrl: prMatch?.[0],
      model,
      summary:
        summary ??
        (success ? "Agent completed successfully" : `Agent exited with code ${exitCode}`),
      error: !success ? (errorMessage ?? `Exit code: ${exitCode}`) : undefined,
    };
  }

  private parseLogs(logs: string): {
    errorMessage?: string;
    hasError: boolean;
    summary?: string;
    model?: string;
  } {
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
          console.warn(`[cursor] Raw error: ${errorMessage}`);
        }
        continue;
      }

      if (event.model && !model) {
        model = event.model;
      }

      // Error envelope: { error: { message, ... } }
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

      // Assistant message — content may be a string or a Claude-style block array
      if (event.type === "assistant") {
        const text = extractMessageText(event.message ?? event);
        if (text) lastAssistantMessage = text;
        continue;
      }

      // Terminal result event
      if (event.type === "result") {
        if (event.is_error) {
          errorMessage =
            typeof event.result === "string" ? event.result : JSON.stringify(event.result);
          hasError = true;
        } else if (typeof event.result === "string" && event.result.trim()) {
          lastAssistantMessage = event.result;
        }
      }
    }

    return {
      errorMessage,
      hasError,
      summary: lastAssistantMessage ? truncate(lastAssistantMessage, 200) : undefined,
      model,
    };
  }
}

/** Pull plain text out of a Cursor message ({content: string | block[]}) */
function extractMessageText(message: any): string | undefined {
  if (!message) return undefined;
  const content = message.content;
  if (typeof content === "string") return content.trim() || undefined;
  if (Array.isArray(content)) {
    const text = content
      .map((block: any) => {
        if (typeof block === "string") return block;
        if (block?.type === "text") return block.text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    return text || undefined;
  }
  return undefined;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "…";
}

/** Detect common Cursor CLI error patterns in non-JSON output lines */
function isRawTextError(line: string): boolean {
  // Auth / API key errors (headless failures go to stderr as plain text)
  if (
    /error|failed|fatal|invalid|missing/i.test(line) &&
    /CURSOR_API_KEY|api.?key|authentication|unauthorized|forbidden|not.*logged.*in|login required/i.test(
      line,
    )
  ) {
    return true;
  }
  // Plan / usage limits
  if (/usage limit|quota|plan.*limit|subscription.*required/i.test(line)) {
    return true;
  }
  // Model not found
  if (/model.*not found|model_not_found|does not exist.*model|invalid.*model/i.test(line)) {
    return true;
  }
  // Server errors
  if (/server.?error|internal.?error|service.?unavailable|503|502/i.test(line)) {
    return true;
  }
  return false;
}
