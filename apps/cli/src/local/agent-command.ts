import {
  LOCAL_AGENT_PERMISSION_MODES,
  shellQuote,
  type LocalAgentKind,
  type LocalAgentPermissionMode,
  type LocalAgentSessionMode,
  type ModelProviderLaunch,
  bedrockRuntime,
} from "@optio/shared";
import type { ClaudeCliCaps } from "./cli-probes.js";

export interface AgentCommandOptions {
  /** `interactive` (default) stays at the agent's prompt; `headless` runs one turn and exits. */
  mode?: LocalAgentSessionMode;
  /**
   * Resume this agent session instead of starting fresh. Interactive, except
   * for Claude Code and Codex in headless mode (`claude -p --resume`, `codex
   * exec resume`), which is how a local Repo Task picks its own session back
   * up after review feedback.
   */
  resumeSessionId?: string;
  /** Model override for the agent CLI (`--model` / `-m`). */
  model?: string;
  /** Reasoning effort: Claude Code `--effort`, Codex `-c model_reasoning_effort="…"`. */
  effort?: string;
  /**
   * Claude Code's `--permission-mode`; `auto` when unset. Codex takes only
   * `bypassPermissions` (`--yolo`); otherwise it keeps its own config.
   */
  permissionMode?: LocalAgentPermissionMode;
  /**
   * What this machine's `claude` accepts (see `probeClaudeCli`), once known.
   * A Claude Code too old for auto mode or `--effort` would refuse to start
   * with them, so they are left out; unknown = pass them.
   */
  claudeCaps?: ClaudeCliCaps | null;
  /**
   * Reach the models through a model provider (Amazon Bedrock) with this
   * machine's own AWS credentials: its region and, optionally, which of the
   * machine's AWS profiles to use. Claude Code and Codex only.
   */
  provider?: Pick<ModelProviderLaunch, "region" | "awsProfile"> | null;
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
  const provider =
    opts.provider && (agent === "claude-code" || agent === "codex")
      ? bedrockRuntime(agent, opts.provider)
      : null;
  const command = agentCli(agent, prompt, hookSettingsPath, opts, provider?.codexConfig ?? []);
  return provider ? withProviderEnv(provider.env, !!opts.provider?.awsProfile, command) : command;
}

/**
 * Run `command` with the provider's env set on the command itself — after
 * the login shell's rc files, which could otherwise override it. With a
 * named AWS profile, AWS keys exported in the environment are dropped first:
 * the SDK prefers them to the profile.
 */
function withProviderEnv(env: Record<string, string>, profile: boolean, command: string): string {
  const unset = profile
    ? " -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_BEARER_TOKEN_BEDROCK"
    : "";
  const assignments = Object.entries(env)
    .filter(([k]) => /^[A-Z_][A-Z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(" ");
  return `env${unset} ${assignments} ${command}`;
}

function agentCli(
  agent: LocalAgentKind,
  prompt: string | undefined,
  hookSettingsPath: string,
  opts: AgentCommandOptions,
  codexConfig: string[],
): string {
  const resume = opts.resumeSessionId ? shellQuote(opts.resumeSessionId) : null;
  // Claude Code and Codex resume one-shot (`claude -p --resume`, `codex exec
  // resume`); every other CLI resumes into its interactive prompt.
  const headless =
    opts.mode === "headless" && (!resume || agent === "claude-code" || agent === "codex");
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
      // An effort this `claude` doesn't list (an older release without
      // xhigh / max) would stop it from starting: leave it to its default.
      const effortOk =
        opts.claudeCaps?.effort !== false &&
        (!opts.claudeCaps?.effortLevels || opts.claudeCaps.effortLevels.includes(effort ?? ""));
      if (effort && effortOk) base += ` --effort ${shellQuote(effort)}`;
      if (headless) base += " -p";
      if (resume) base += ` --resume ${resume}`;
      return base + (p ? ` ${p}` : "");
    }
    case "codex": {
      // `--yolo` is Codex's alias for this flag; the long name is the one its
      // --help documents, so it's the one older releases are sure to take.
      let flags =
        opts.permissionMode === "bypassPermissions"
          ? " --dangerously-bypass-approvals-and-sandbox"
          : "";
      if (model) flags += ` -m ${model}`;
      if (effort) flags += ` -c ${shellQuote(`model_reasoning_effort="${effort}"`)}`;
      for (const override of codexConfig) flags += ` -c ${shellQuote(override)}`;
      if (resume) {
        const sub = headless ? "codex exec resume" : "codex resume";
        return `${sub}${flags} ${resume}` + (p ? ` ${p}` : "");
      }
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
