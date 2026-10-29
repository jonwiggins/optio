import type { AgentTaskInput, AgentContainerConfig, AgentResult } from "@optio/shared";
import { TASK_BRANCH_PREFIX } from "@optio/shared";
import type { AgentAdapter, AgentResultParser } from "./types.js";
import { firstMatch, parseAllLines } from "./types.js";

/** API-key providers supported by Optio's Pi credential picker. */
export const PI_PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"] as const;

/** Pi 1.4 JSONL: count only message_end, never its repeated turn_end/agent_end snapshots. */
export class PiAdapter implements AgentAdapter {
  readonly type = "pi";
  readonly displayName = "Pi";

  validateSecrets(available: string[]): { valid: boolean; missing: string[] } {
    const valid = PI_PROVIDER_KEYS.some((key) => available.includes(key));
    return { valid, missing: valid ? [] : [PI_PROVIDER_KEYS.join(" or ")] };
  }

  buildContainerConfig(input: AgentTaskInput): AgentContainerConfig {
    return {
      env: {
        OPTIO_TASK_ID: input.taskId,
        OPTIO_REPO_URL: input.repoUrl,
        OPTIO_REPO_BRANCH: input.repoBranch,
        OPTIO_PROMPT: input.renderedPrompt ?? input.prompt,
        OPTIO_AGENT_TYPE: this.type,
        OPTIO_BRANCH_NAME: `${TASK_BRANCH_PREFIX}${input.taskId}`,
        ...(input.piModel ? { OPTIO_PI_MODEL: input.piModel } : {}),
        ...(input.piThinking ? { OPTIO_PI_THINKING: input.piThinking } : {}),
      },
      // Pi accepts any one key. Workers resolve that alternative explicitly.
      requiredSecrets: [],
      setupFiles:
        input.taskFileContent && input.taskFilePath
          ? [{ path: input.taskFilePath, content: input.taskFileContent }]
          : [],
    };
  }

  parseResult(exitCode: number, logs: string): AgentResult {
    return parseAllLines(this.createResultParser(), exitCode, logs);
  }

  createResultParser(): AgentResultParser {
    const pr = firstMatch(
      /https:\/\/(?![\w.-]+\/api\/)[^\s"\\]+\/(?:pull\/\d+|-\/merge_requests\/\d+)/,
    );
    let summary: string | undefined;
    let error: string | undefined;
    let model: string | undefined;
    let completed = false;
    let settled = false;
    let inputTokens = 0,
      outputTokens = 0,
      cacheReadTokens = 0,
      cacheWriteTokens = 0,
      costUsd = 0;
    let hasUsage = false;
    const number = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
    return {
      push(line) {
        pr.push(line);
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (!event || typeof event !== "object") return;
        if (event.type === "message_end" && event.message?.role === "assistant") {
          const message = event.message;
          model = typeof message.model === "string" ? message.model : model;
          if (
            message.stopReason === "error" ||
            message.stopReason === "aborted" ||
            message.stopReason === "length"
          ) {
            error =
              typeof message.errorMessage === "string"
                ? message.errorMessage
                : `Pi ${message.stopReason}`;
          } else {
            // A later successful response can recover a provider error through Pi's automatic retry.
            error = undefined;
            completed = true;
            const text = Array.isArray(message.content)
              ? message.content
                  .filter((b: any) => b?.type === "text" && typeof b.text === "string")
                  .map((b: any) => b.text)
                  .join("\n")
                  .trim()
              : "";
            if (text) summary = text.slice(0, 200);
          }
          const usage = message.usage;
          if (usage && typeof usage === "object") {
            hasUsage = true;
            inputTokens += number(usage.input);
            outputTokens += number(usage.output);
            cacheReadTokens += number(usage.cacheRead);
            cacheWriteTokens += number(usage.cacheWrite);
            costUsd += number(usage.cost?.total);
          }
        }
        if (event.type === "auto_retry_end" && event.success === false) {
          error =
            typeof event.finalError === "string"
              ? event.finalError
              : "Pi exhausted automatic retries";
        }
        if (event.type === "agent_settled") {
          settled = true;
          if (event.aborted) error = "Pi run aborted";
        }
      },
      finish(exitCode) {
        const success = exitCode === 0 && completed && settled && !error;
        return {
          success,
          prUrl: pr.value?.[0],
          summary:
            summary ?? (success ? "Pi completed successfully" : "Pi did not complete successfully"),
          model,
          error: success
            ? undefined
            : (error ??
              (exitCode !== 0
                ? `Exit code: ${exitCode}`
                : "Pi output ended before a completed response and agent_settled event")),
          ...(hasUsage
            ? {
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheWriteTokens,
                costUsd,
                costBasis: "reported" as const,
              }
            : {}),
        };
      },
    };
  }
}
