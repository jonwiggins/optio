import type { AgentTaskInput, AgentContainerConfig, AgentResult } from "@optio/shared";
import { TASK_BRANCH_PREFIX } from "@optio/shared";
import type { AgentAdapter } from "./types.js";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly type = "claude-code";
  readonly displayName = "Claude Code";

  validateSecrets(availableSecrets: string[]): { valid: boolean; missing: string[] } {
    // GITHUB_TOKEN is always required
    // ANTHROPIC_API_KEY is only required in api-key mode (checked at runtime)
    const required = ["GITHUB_TOKEN"];
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

    const requiredSecrets = ["GITHUB_TOKEN"];
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

      // Claude Code needs hasCompletedOnboarding to skip interactive setup
      setupFiles.push({
        path: "/home/agent/.claude/settings.json",
        content: JSON.stringify({
          hasCompletedOnboarding: true,
        }),
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
    const prMatch = logs.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    return {
      success: exitCode === 0,
      prUrl: prMatch?.[0],
      summary:
        exitCode === 0 ? "Agent completed successfully" : `Agent exited with code ${exitCode}`,
      error: exitCode !== 0 ? `Exit code: ${exitCode}` : undefined,
    };
  }
}
