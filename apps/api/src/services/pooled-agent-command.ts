/**
 * The shell command that runs one agent turn in a pooled pod — a Job run
 * (`workflow-worker`) or a Persistent Agent turn (`persistent-agent-worker`).
 * Both used to carry their own copy; this is the one builder.
 *
 * Unlike Repo Tasks there is no adapter writing settings files into a
 * worktree: every parameter arrives as env (see `agentOptionsEnv`) and is
 * turned into a CLI flag here. The prompt itself is never embedded — it's
 * read from `$OPTIO_PROMPT` or written to stdin (Claude Code stream-json).
 */
export function buildPooledAgentCommand(
  agentType: string,
  env: Record<string, string>,
  opts: { maxTurns: number; label: string },
): string[] {
  const { maxTurns, label } = opts;
  const q = (s: string) => JSON.stringify(s);

  switch (agentType) {
    case "claude-code": {
      const authSetup =
        env.OPTIO_AUTH_MODE === "max-subscription"
          ? [
              `if curl -sf "${env.OPTIO_API_URL}/api/auth/claude-token" > /dev/null 2>&1; then echo "[optio] Token proxy OK"; fi`,
              `unset ANTHROPIC_API_KEY 2>/dev/null || true`,
            ]
          : [];

      const flags: string[] = [];
      if (env.OPTIO_CLAUDE_MODEL) {
        const ctx = env.OPTIO_CLAUDE_CONTEXT_WINDOW === "1m" ? "[1m]" : "";
        flags.push(`--model ${env.OPTIO_CLAUDE_MODEL}${ctx}`);
      }
      // Effort + extended thinking, as the same settings keys the claude-code
      // adapter writes to ~/.claude/settings.json for Repo Tasks.
      if (env.OPTIO_CLAUDE_SETTINGS_JSON)
        flags.push(`--settings ${q(env.OPTIO_CLAUDE_SETTINGS_JSON)}`);

      return [
        ...authSetup,
        `echo "[optio] Running ${label} (Claude Code)..."`,
        `claude --print \\`,
        `  --dangerously-skip-permissions \\`,
        `  --input-format stream-json \\`,
        `  --output-format stream-json \\`,
        `  --verbose \\`,
        `  --max-turns ${maxTurns} \\`,
        `  ${flags.join(" ")}`.trim(),
      ];
    }
    case "codex": {
      return [
        `echo "[optio] Running ${label} (Codex)..."`,
        `codex exec --full-auto "$OPTIO_PROMPT" --json`,
      ];
    }
    case "copilot": {
      const modelFlag = env.COPILOT_MODEL ? ` --model ${q(env.COPILOT_MODEL)}` : "";
      const effortFlag = env.COPILOT_EFFORT ? ` --effort ${q(env.COPILOT_EFFORT)}` : "";
      return [
        `echo "[optio] Running ${label} (Copilot)..."`,
        `copilot --autopilot --yolo --max-autopilot-continues ${maxTurns} \\`,
        `  --output-format json --no-ask-user${modelFlag}${effortFlag} \\`,
        `  -p "$OPTIO_PROMPT"`,
      ];
    }
    case "opencode": {
      const modelFlag = env.OPTIO_OPENCODE_MODEL ? ` --model ${q(env.OPTIO_OPENCODE_MODEL)}` : "";
      const agentFlag = env.OPTIO_OPENCODE_AGENT ? ` --agent ${q(env.OPTIO_OPENCODE_AGENT)}` : "";
      return [
        `echo "[optio] Running ${label} (OpenCode)..."`,
        `opencode run --format json${modelFlag}${agentFlag} "$OPTIO_PROMPT"`,
      ];
    }
    case "gemini": {
      const modelFlag = env.OPTIO_GEMINI_MODEL ? ` -m ${q(env.OPTIO_GEMINI_MODEL)}` : "";
      const approvalFlag = env.OPTIO_GEMINI_APPROVAL_MODE
        ? ` --approval-mode ${q(env.OPTIO_GEMINI_APPROVAL_MODE)}`
        : "";
      return [
        `echo "[optio] Running ${label} (Gemini)..."`,
        `gemini${modelFlag}${approvalFlag} -p "$OPTIO_PROMPT"`,
      ];
    }
    case "cursor": {
      const modelFlag = env.OPTIO_CURSOR_MODEL ? ` --model ${q(env.OPTIO_CURSOR_MODEL)}` : "";
      return [
        `echo "[optio] Running ${label} (Cursor)..."`,
        `cursor-agent --print --trust --force \\`,
        `  --output-format stream-json${modelFlag} "$OPTIO_PROMPT"`,
      ];
    }
    default:
      return [`echo "Unknown agent type: ${agentType}"`, `exit 1`];
  }
}
