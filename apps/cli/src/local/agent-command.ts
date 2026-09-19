import { shellQuote, type LocalAgentKind, type LocalAgentSessionMode } from "@optio/shared";

export interface AgentCommandOptions {
  /** `interactive` (default) stays at the agent's prompt; `headless` runs one turn and exits. */
  mode?: LocalAgentSessionMode;
  /** Resume this agent session instead of starting fresh (always interactive). */
  resumeSessionId?: string;
}

/**
 * Build the shell command string for an `{kind: "agent"}` spawn. Prompts and
 * session ids are always passed as single shell-quoted argv elements — never
 * interpolated into shell syntax (see docs/optio-local.md, "Command safety").
 *
 * Headless mode maps to each CLI's non-interactive entry point (`claude -p`,
 * `codex exec`, …): the process prints its result and exits, which is the
 * "exit when done" automation shape. Claude Code still fires hooks in `-p`
 * mode, so the session id is captured and the run can be resumed later.
 */
export function buildAgentCommand(
  agent: LocalAgentKind,
  prompt: string | undefined,
  hookSettingsPath: string,
  opts: AgentCommandOptions = {},
): string {
  const headless = opts.mode === "headless" && !opts.resumeSessionId;
  const resume = opts.resumeSessionId ? shellQuote(opts.resumeSessionId) : null;
  // A prompt that starts with "-" (a template that opens with an event param,
  // and a PR comment reading "--dangerously-skip-permissions …") would parse as
  // a CLI flag. A leading space keeps it a positional for every CLI here.
  const p = prompt ? shellQuote(prompt.startsWith("-") ? ` ${prompt}` : prompt) : null;
  switch (agent) {
    case "claude-code": {
      const base = `claude --settings ${shellQuote(hookSettingsPath)}`;
      if (resume) return `${base} --resume ${resume}` + (p ? ` ${p}` : "");
      if (headless) return `${base} -p` + (p ? ` ${p}` : "");
      return base + (p ? ` ${p}` : "");
    }
    case "codex": {
      if (resume) return `codex resume ${resume}` + (p ? ` ${p}` : "");
      if (headless) return `codex exec` + (p ? ` ${p}` : "");
      return `codex` + (p ? ` ${p}` : "");
    }
    case "cursor":
      if (headless) return `cursor-agent -p` + (p ? ` ${p}` : "");
      return `cursor-agent` + (p ? ` ${p}` : "");
    case "gemini":
      if (headless) return `gemini` + (p ? ` -p ${p}` : "");
      return `gemini` + (p ? ` -i ${p}` : "");
    case "opencode":
      if (headless) return `opencode run` + (p ? ` ${p}` : "");
      return `opencode` + (p ? ` --prompt ${p}` : "");
  }
}
