import { shellQuote, type LocalAgentKind, type LocalAgentSessionMode } from "@optio/shared";

export interface AgentCommandOptions {
  /** `interactive` (default) stays at the agent's prompt; `headless` runs one turn and exits. */
  mode?: LocalAgentSessionMode;
  /**
   * Resume this agent session instead of starting fresh. Interactive, except
   * for Claude Code in headless mode (`claude -p --resume`), which is how a
   * local Repo Task picks its own session back up after review feedback.
   */
  resumeSessionId?: string;
  /** Model override for the agent CLI (`--model` / `-m`). */
  model?: string;
}

/**
 * Build the shell command string for an `{kind: "agent"}` spawn. Prompts,
 * session ids, and model names are always passed as single shell-quoted argv
 * elements — never interpolated into shell syntax (see docs/optio-local.md,
 * "Command safety").
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
  const resume = opts.resumeSessionId ? shellQuote(opts.resumeSessionId) : null;
  // Only Claude Code has a one-shot resume; every other CLI resumes into its
  // interactive prompt.
  const headless = opts.mode === "headless" && (!resume || agent === "claude-code");
  const model = opts.model?.trim() ? shellQuote(opts.model.trim()) : null;
  // A prompt that starts with "-" (a template that opens with an event param,
  // and a PR comment reading "--dangerously-skip-permissions …") would parse as
  // a CLI flag. A leading space keeps it a positional for every CLI here.
  const p = prompt ? shellQuote(prompt.startsWith("-") ? ` ${prompt}` : prompt) : null;
  switch (agent) {
    case "claude-code": {
      let base = `claude --settings ${shellQuote(hookSettingsPath)}`;
      if (model) base += ` --model ${model}`;
      if (headless) base += " -p";
      if (resume) base += ` --resume ${resume}`;
      return base + (p ? ` ${p}` : "");
    }
    case "codex": {
      const m = model ? ` -m ${model}` : "";
      if (resume) return `codex resume${m} ${resume}` + (p ? ` ${p}` : "");
      if (headless) return `codex exec${m}` + (p ? ` ${p}` : "");
      return `codex${m}` + (p ? ` ${p}` : "");
    }
    case "cursor": {
      const m = model ? ` --model ${model}` : "";
      if (headless) return `cursor-agent${m} -p` + (p ? ` ${p}` : "");
      return `cursor-agent${m}` + (p ? ` ${p}` : "");
    }
    case "gemini": {
      const m = model ? ` -m ${model}` : "";
      if (headless) return `gemini${m}` + (p ? ` -p ${p}` : "");
      return `gemini${m}` + (p ? ` -i ${p}` : "");
    }
    case "opencode": {
      const m = model ? ` --model ${model}` : "";
      if (headless) return `opencode run${m}` + (p ? ` ${p}` : "");
      return `opencode${m}` + (p ? ` --prompt ${p}` : "");
    }
  }
}
