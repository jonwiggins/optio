export type ClaudeAuthMode = "api-key" | "max-subscription" | "vertex-ai";
export type CodexAuthMode = "api-key" | "app-server";
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
  claudeThinking?: boolean;
  claudeEffort?: string;
  copilotModel?: string;
  copilotEffort?: string;
  opencodeModel?: string;
  opencodeAgent?: string;
  opencodeBaseUrl?: string;
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
}

export interface AgentContainerConfig {
  command: string[];
  env: Record<string, string>;
  requiredSecrets: string[];
  image?: string;
  /** Files to create inside the container before running the agent */
  setupFiles?: Array<{
    path: string;
    content: string;
    executable?: boolean;
    /** Mark as sensitive to apply restrictive permissions (chmod 600) */
    sensitive?: boolean;
  }>;
}

export interface AgentResult {
  success: boolean;
  prUrl?: string;
  summary?: string;
  error?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
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
