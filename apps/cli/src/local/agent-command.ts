import {
  LOCAL_AGENT_PERMISSION_MODES,
  shellQuote,
  type LocalAgentKind,
  type LocalAgentPermissionMode,
  type LocalAgentSessionMode,
} from "@optio/shared";
import type { ClaudeCliCaps } from "./cli-probes.js";

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
  /** Reasoning effort: Claude Code `--effort`, Codex `-c model_reasoning_effort="…"`. */
  effort?: string;
  /** Claude Code's `--permission-mode`; `auto` when unset. */
  permissionMode?: LocalAgentPermissionMode;
  /**
   * What this machine's `claude` accepts (see `probeClaudeCli`), once known.
   * A Claude Code too old for auto mode or `--effort` would refuse to start
   * with them, so they are left out; unknown = pass them.
   */
  claudeCaps?: ClaudeCliCaps | null;
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
 *
 * Claude Code starts in auto mode unless told otherwise: `-p` would
 * otherwise start in Manual, where every edit and command is denied because
 * nobody can answer the prompt, and a fresh install's first interactive
 * session would stop at each one.
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
  // Effort names are short words ("xhigh"); anything else is dropped rather
  // than handed to a CLI flag or a Codex config override.
  const effort = /^[A-Za-z0-9_-]{1,32}$/.test(opts.effort?.trim() ?? "")
    ? opts.effort!.trim()
    : null;
  // A prompt that starts with "-" (a template that opens with an event param,
  // and a PR comment reading "--dangerously-skip-permissions …") would parse as
  // a CLI flag. A leading space keeps it a positional for every CLI here.
  const p = prompt ? shellQuote(prompt.startsWith("-") ? ` ${prompt}` : prompt) : null;
  switch (agent) {
    case "claude-code": {
      let base = `claude --settings ${shellQuote(hookSettingsPath)}`;
      const permission = LOCAL_AGENT_PERMISSION_MODES.includes(opts.permissionMode!)
        ? opts.permissionMode!
        : "auto";
      base += claudePermissionFlag(permission, opts.claudeCaps);
      if (model) base += ` --model ${model}`;
      if (effort && opts.claudeCaps?.effort !== false) base += ` --effort ${shellQuote(effort)}`;
      if (headless) base += " -p";
      if (resume) base += ` --resume ${resume}`;
      return base + (p ? ` ${p}` : "");
    }
    case "codex": {
      let flags = model ? ` -m ${model}` : "";
      if (effort) flags += ` -c ${shellQuote(`model_reasoning_effort="${effort}"`)}`;
      if (resume) return `codex resume${flags} ${resume}` + (p ? ` ${p}` : "");
      if (headless) return `codex exec${flags}` + (p ? ` ${p}` : "");
      return `codex${flags}` + (p ? ` ${p}` : "");
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

/**
 * Claude Code's permission flag. Skipping checks uses the long-standing
 * `--dangerously-skip-permissions`; a mode this `claude` doesn't list (auto
 * mode on an older release) is left out, so it starts in its own default
 * rather than refusing to start.
 */
function claudePermissionFlag(
  mode: LocalAgentPermissionMode,
  caps: ClaudeCliCaps | null | undefined,
): string {
  if (mode === "bypassPermissions") return " --dangerously-skip-permissions";
  if (caps?.permissionModes && !caps.permissionModes.includes(mode)) return "";
  return ` --permission-mode ${mode}`;
}
