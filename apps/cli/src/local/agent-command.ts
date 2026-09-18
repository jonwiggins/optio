import { shellQuote, type LocalAgentKind } from "@optio/shared";

/**
 * Build the shell command string for an `{kind: "agent"}` spawn. Prompts are
 * always passed as a single shell-quoted argv element — never interpolated
 * into shell syntax (see docs/optio-local.md, "Command safety").
 */
export function buildAgentCommand(
  agent: LocalAgentKind,
  prompt: string | undefined,
  hookSettingsPath: string,
): string {
  switch (agent) {
    case "claude-code":
      return (
        `claude --settings ${shellQuote(hookSettingsPath)}` +
        (prompt ? ` ${shellQuote(prompt)}` : "")
      );
    case "codex":
      return `codex` + (prompt ? ` ${shellQuote(prompt)}` : "");
    case "cursor":
      return `cursor-agent` + (prompt ? ` ${shellQuote(prompt)}` : "");
    case "gemini":
      return `gemini` + (prompt ? ` -i ${shellQuote(prompt)}` : "");
    case "opencode":
      return `opencode` + (prompt ? ` --prompt ${shellQuote(prompt)}` : "");
  }
}
