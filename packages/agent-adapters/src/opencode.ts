import type { AgentTaskInput, AgentContainerConfig, AgentResult } from "@optio/shared";
import { TASK_BRANCH_PREFIX } from "@optio/shared";
import type { AgentAdapter } from "./types.js";

interface OpenCodeConfig {
  $schema: string;
  model?: string;
  provider?: {
    litellm?: {
      npm: string;
      name: string;
      options: {
        baseURL: string;
        apiKey: string;
      };
      models: Record<string, { name: string }>;
    };
  };
  permission?: Record<string, string | Record<string, string>>;
}

export const OPENCODE_WORKSPACE_GUARD_PLUGIN = `export const OptioWorkspaceGuard = async ({ directory, worktree }) => {
  const workspace = directory || worktree || process.cwd();
  const home = process.env.HOME || "/home/agent";
  const roots = [
    workspace.endsWith("/") ? workspace : workspace + "/",
    home + "/.local/share/opencode/",
    "/dev/",
  ];
  const HINT =
    "Blocked: path outside the workspace. Stay inside the workspace (Im Workspace bleiben) — write temp files, caches and venvs inside the worktree (e.g. ./.tmp/) instead of /tmp or $HOME.";
  const HOME_RE = /^(~|\\$HOME)(?=\\/|$)/;
  const ABS_RE = /(^|[\\s'"(=])(\\/(?:[^\\s'"\\x60\\\\:,;)]|\\*|\\?)+)/g;

  const expand = (p) => p.replace(HOME_RE, home);
  const isAllowed = (p) => roots.some((r) => p.startsWith(r));

  const offendingPath = (tool, args) => {
    if (!args || typeof args !== "object") return null;
    if (["webfetch", "websearch", "task", "skill", "lsp", "question"].includes(tool)) return null;
    const values = Object.values(args).filter((v) => typeof v === "string");
    for (const value of values) {
      const candidates =
        tool === "bash"
          ? value.split(/[\\s;|&><()]+/).filter(Boolean)
          : [value.trim()];
      for (const token of candidates) {
        const expanded = expand(token);
        if (expanded.startsWith("/") && !roots.some((r) => expanded.startsWith(r))) return token;
        const matches = [...expanded.matchAll(ABS_RE)].map((m) => m[2]);
        const bad = matches.find((p) => !roots.some((r) => expand(p).startsWith(r)));
        if (bad) return bad;
      }
    }
    return null;
  };

  return {
    "tool.execute.before": async (input, output) => {
      const bad = offendingPath(input.tool, output.args);
      if (bad) {
        throw new Error(HINT + " (tool: " + input.tool + ", path: " + bad + ")");
      }
    },
  };
};
`;

export const OPENCODE_GLOBAL_AGENTS_MD = `# Optio Runtime Rules (headless, mandatory)

You are a coding agent launched headless by the Optio orchestrator inside an isolated Kubernetes pod. Your current working directory is your workspace (the git worktree for this task).

## Workspace confinement — absolute rules

- Stay inside the workspace. Never read, write, create, or execute anything outside it.
- Never use /tmp, /var, /usr, /opt, /etc or \$HOME paths for any file or tool call.
- Create temporary files, caches, and virtual environments INSIDE the workspace (e.g. \`./.tmp/\`), and clean them up before finishing.
- No sudo, no system package installs (apt-get), no global pip/npm installs. If tooling is missing, work with what is available inside the workspace.
- When a tool call is blocked with a workspace-boundary error, do NOT retry the same external path — switch to an in-workspace path.

## Headless mode

- You run non-interactively (opencode run). Asking the user questions is impossible — never attempt it.
- If something is ambiguous, state your assumption and proceed.
- Never wait for interactive input; there is none.

## Focus

- Work only on the task described in the task file (.optio/task.md).
- Commit your work to the task branch and open a PR as described in the task instructions.
`;

/**
 * OpenCode CLI (opencode run --format json) outputs NDJSON events.
 * Each line is a JSON object. The exact schema is not fully documented,
 * but known shapes include:
 *
 * - { type: "message", role: "assistant"|"system", content: "..." }
 * - { type: "tool_call", name: "...", arguments: "..." }
 * - { type: "tool_result", call_id: "...", output: "..." }
 * - { type: "error", message: "..." }
 * - Events with usage data (input_tokens, output_tokens)
 *
 * The parser is conservative — unrecognized events are skipped.
 *
 * NOTE: OpenCode support is EXPERIMENTAL. The JSON output schema is
 * not exhaustively documented and may change between versions.
 */

export class OpenCodeAdapter implements AgentAdapter {
  readonly type = "opencode";
  readonly displayName = "OpenCode";

  validateSecrets(availableSecrets: string[]): { valid: boolean; missing: string[] } {
    // OpenCode is provider-agnostic — it needs at least one provider API key.
    // Note: when opencodeBaseUrl is set, buildContainerConfig() skips requiredSecrets
    // and injects a placeholder key, so missing provider keys won't block execution.
    const acceptedKeys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY"];
    const hasAny = acceptedKeys.some((k) => availableSecrets.includes(k));
    return {
      valid: hasAny,
      missing: hasAny ? [] : ["ANTHROPIC_API_KEY or OPENAI_API_KEY"],
    };
  }

  buildContainerConfig(input: AgentTaskInput): AgentContainerConfig {
    const prompt = input.renderedPrompt ?? input.prompt;

    const env: Record<string, string> = {
      OPTIO_TASK_ID: input.taskId,
      OPTIO_REPO_URL: input.repoUrl,
      OPTIO_REPO_BRANCH: input.repoBranch,
      OPTIO_PROMPT: prompt,
      OPTIO_AGENT_TYPE: "opencode",
      OPTIO_BRANCH_NAME: `${TASK_BRANCH_PREFIX}${input.taskId}`,
    };

    // OpenCode reads provider-specific env vars directly (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
    // These are injected via requiredSecrets
    const requiredSecrets: string[] = [];

    // When using a custom base URL, provider API keys are optional — the adapter
    // sets a placeholder OPENAI_API_KEY in env that will be overridden if a real
    // secret exists. Without a custom base URL, require standard provider keys.
    // Full "litellm/<model>" name routes to the provider; only the models map key uses the bare name.
    const isLitellm =
      input.opencodeModel?.startsWith("litellm/") === true ||
      input.opencodeDefaultModel?.startsWith("litellm/") === true;

    const fullModel = input.opencodeModel ?? input.opencodeDefaultModel;
    const proxyModel = isLitellm ? fullModel?.replace(/^litellm\//, "") : undefined;

    const config: OpenCodeConfig = {
      $schema: "https://opencode.ai/config.json",
      permission: {
        "*": "allow",
        question: "deny",
        bash: {
          "sudo *": "deny",
          "apt *": "deny",
          "apt-get *": "deny",
          "dpkg *": "deny",
        },
        external_directory: {
          "*": "deny",
          "/home/agent/.local/share/opencode/**": "allow",
        },
      },
    };

    const setupFiles: AgentContainerConfig["setupFiles"] = [];

    if (isLitellm) {
      requiredSecrets.push("OPENAI_API_KEY");
      env.OPENAI_API_KEY = "sk-no-key-required";
      if (input.opencodeBaseUrl) {
        if (fullModel) {
          config.model = fullModel;
          env.OPENCODE_MODEL = fullModel;
        }
        config.provider = {
          litellm: {
            npm: "@ai-sdk/openai-compatible",
            name: "LiteLLM Proxy",
            options: {
              baseURL: input.opencodeBaseUrl,
              // Rendered to the literal value by the API workers — opencode
              // does not resolve {env:VAR} in provider options (#27853).
              apiKey: "{env:OPENAI_API_KEY}",
            },
            models: proxyModel
              ? {
                  [proxyModel]: {
                    name: proxyModel,
                  },
                }
              : {},
          },
        };
      }
    } else if (!input.opencodeBaseUrl) {
      requiredSecrets.push("ANTHROPIC_API_KEY", "OPENAI_API_KEY");
    }

    // opencodeModel (repo-specific) always wins over opencodeDefaultModel (global secret)
    if (fullModel) {
      env.OPENCODE_MODEL = fullModel;
      env.OPTIO_OPENCODE_MODEL = fullModel;
    }
    // Set named agent if configured (e.g. "build", "plan")
    if (input.opencodeAgent) {
      env.OPTIO_OPENCODE_AGENT = input.opencodeAgent;
    }

    // Custom OpenAI-compatible endpoint (e.g. vLLM, lightllm, Ollama)
    if (input.opencodeBaseUrl && !isLitellm) {
      env.OPENAI_BASE_URL = input.opencodeBaseUrl;
      // Local endpoints typically don't require a real API key — set a
      // placeholder that gets overridden if a real secret is configured.
      env.OPENAI_API_KEY = "sk-no-key-required";
    }

    // Pre-seed a minimal opencode config so the CLI doesn't hit first-run setup
    setupFiles.push({
      path: "/home/agent/.config/opencode/opencode.json",
      content: JSON.stringify(config),
    });

    setupFiles.push({
      path: "/home/agent/.config/opencode/plugins/optio-workspace-guard.js",
      content: OPENCODE_WORKSPACE_GUARD_PLUGIN,
    });

    setupFiles.push({
      path: "/home/agent/.config/opencode/AGENTS.md",
      content: OPENCODE_GLOBAL_AGENTS_MD,
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
          // Log raw error for diagnostics (helps catch API key issues, auth failures, etc.)
          console.warn(`[opencode] Raw error: ${errorMessage}`);
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

    // OpenCode is provider-agnostic — cost may not be available.
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

/** Detect common OpenCode error patterns in non-JSON output lines */
function isRawTextError(line: string): boolean {
  // Auth / API key errors
  if (
    /error|failed|fatal/i.test(line) &&
    /ANTHROPIC_API_KEY|OPENAI_API_KEY|GROQ_API_KEY|api.?key|authentication|unauthorized|forbidden/i.test(
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
