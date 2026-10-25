/**
 * How Claude Code signs in for a run. `oauth-token` is a stored
 * `CLAUDE_CODE_OAUTH_TOKEN`; `bedrock` a model provider; `gateway` the
 * organization's model gateway with the owner's own token
 * (docs/model-gateway.md).
 */
export type ClaudeAuthMode =
  | "api-key"
  | "max-subscription"
  | "oauth-token"
  | "vertex-ai"
  | "bedrock"
  | "gateway";
export type CodexAuthMode = "api-key" | "app-server" | "bedrock";
/** OpenCode: its own provider keys, or the model gateway's OpenAI-compatible endpoint. */
export type OpenCodeAuthMode = "api-key" | "gateway";
export type CopilotAuthMode = "github-token";
export type GeminiAuthMode = "api-key" | "vertex-ai";
export type OpenClawAuthMode = "api-key";

export interface AgentTaskInput {
  taskId: string;
  prompt: string;
  repoUrl: string;
  repoBranch: string;
  additionalContext?: string;
  claudeAuthMode?: ClaudeAuthMode;
  codexAuthMode?: CodexAuthMode;
  /** The app-server WebSocket URL for Codex CLI (used when codexAuthMode is "app-server") */
  codexAppServerUrl?: string;
  copilotAuthMode?: CopilotAuthMode;
  optioApiUrl?: string; // for apiKeyHelper callback
  /** The rendered system prompt (from the prompt template) */
  renderedPrompt?: string;
  /** The task file content to write into the worktree */
  taskFileContent?: string;
  /** Path for the task file inside the worktree */
  taskFilePath?: string;
  claudeModel?: string;
  claudeContextWindow?: string;
  claudeEffort?: string;
  copilotModel?: string;
  copilotEffort?: string;
  opencodeModel?: string;
  opencodeAgent?: string;
  opencodeBaseUrl?: string;
  /** "gateway" runs OpenCode against the model gateway (`modelProviderEnv`); absent = its own keys. */
  opencodeAuthMode?: OpenCodeAuthMode;
  cursorModel?: string;
  openclawModel?: string;
  openclawAgent?: string;
  geminiAuthMode?: GeminiAuthMode;
  geminiModel?: string;
  geminiApprovalMode?: "default" | "auto_edit" | "yolo";
  maxTurnsCoding?: number;
  maxTurnsReview?: number;
  googleCloudProject?: string;
  googleCloudLocation?: string;
  claudeVertexServiceAccountKey?: string;
  /**
   * Env that points the agent at a model provider: Bedrock, from
   * `bedrockRuntime` (with `claudeAuthMode` / `codexAuthMode` = "bedrock"),
   * or the model gateway, from `gatewayRuntime` (with `claudeAuthMode` /
   * `opencodeAuthMode` = "gateway").
   */
  modelProviderEnv?: Record<string, string>;
  /** Codex `-c` overrides for the model provider (`model_provider="amazon-bedrock"`). */
  codexProviderConfig?: string[];
}

export interface AgentContainerConfig {
  command: string[];
  env: Record<string, string>;
  requiredSecrets: string[];
  image?: string;
  /**
   * Files to create inside the container before running the agent. The
   * entrypoint writes `content` as text by default; if `contentBase64` is
   * set it takes precedence and is decoded to bytes (used for binary
   * payloads from marketplace skills). When using `contentBase64`, set
   * `content` to an empty string.
   */
  setupFiles?: Array<{
    path: string;
    content: string;
    contentBase64?: string;
    executable?: boolean;
    /** Mark as sensitive to apply restrictive permissions (chmod 600) */
    sensitive?: boolean;
    /**
     * `json`: when a file is already there and is a JSON object, keep it
     * and merge this one's keys over it (one level into objects shared by
     * both) instead of replacing it — for a runtime's project config a
     * repo may commit (Cursor's `.cursor/mcp.json`).
     */
    merge?: "json";
  }>;
}

/**
 * One model's share of a run, from Claude Code's result event (`modelUsage`,
 * keyed by the model id as the run asked for it — a gateway's own name, the
 * `[1m]` context suffix stripped). The pricing module recomputes a gateway
 * run's cost from these (docs/model-gateway.md "Usage").
 */
export interface AgentModelUsage {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Claude Code's own guess from the public price list, when it gave one. */
  costUsd?: number;
}

export interface AgentResult {
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costBasis?: "reported" | "estimated";
  success: boolean;
  prUrl?: string;
  summary?: string;
  error?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  /** Tokens per model the run called, when the agent reports them (Claude Code). */
  modelUsage?: Record<string, AgentModelUsage>;
}

export interface AgentConfig {
  id: string;
  type: string;
  displayName: string;
  enabled: boolean;
  config?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
