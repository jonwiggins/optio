import {
  LOCAL_AGENT_PERMISSION_MODES,
  shellQuote,
  type LocalAgentKind,
  type LocalAgentPermissionMode,
  type LocalAgentSessionMode,
  type ModelProviderLaunch,
  bedrockRuntime,
} from "@optio/shared";
import { dirname, join } from "node:path";
import type { ClaudeCliCaps } from "./cli-probes.js";

/**
 * Claude Code's settings for a spawn through the model gateway, over the
 * hooks: no WebFetch preflight, which would call api.anthropic.com — what
 * a pod's gateway run gets too (`gatewayClaudeSettings` in the API).
 */
export const GATEWAY_CLAUDE_SETTINGS = { skipWebFetchPreflight: true } as const;

/** Where the daemon writes the gateway spawns' settings: next to the hooks file. */
export function gatewaySettingsPath(hookSettingsPath: string): string {
  return join(dirname(hookSettingsPath), "claude-gateway.json");
}

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
   * Permission checks; `bypassPermissions` when unset. Claude Code:
   * `--dangerously-skip-permissions`, else `--permission-mode auto|default`.
   * Codex: `--dangerously-bypass-approvals-and-sandbox` (`--yolo`), a
   * workspace-write sandbox for `auto`, its own config for `default`.
   */
  permissionMode?: LocalAgentPermissionMode;
  /**
   * What this machine's `claude` accepts (see `probeClaudeCli`), once known.
   * A Claude Code too old for auto mode or `--effort` would refuse to start
   * with them, so they are left out; unknown = pass them.
   */
  claudeCaps?: ClaudeCliCaps | null;
  /**
   * Reach the models through a model provider. Amazon Bedrock (the default
   * kind) with this machine's own AWS credentials: its region and,
   * optionally, which of the machine's AWS profiles to use; Claude Code and
   * Codex only. The model gateway (`kind: "gateway"`): the env the server
   * built, the owner's own token included (docs/model-gateway.md, "On a
   * machine"); Claude Code and OpenCode only.
   */
  provider?:
    | (Pick<ModelProviderLaunch, "region" | "awsProfile"> &
        Partial<Pick<ModelProviderLaunch, "kind" | "env">>)
    | null;
}

/** The env a provider puts on the command, and the variables it unsets first. */
interface ProviderCommandEnv {
  env: Record<string, string>;
  codexConfig: string[];
  unset: string[];
}

/**
 * Bedrock: `bedrockRuntime`'s env; with a named AWS profile, the AWS keys
 * exported in the environment are dropped first (the SDK prefers them to
 * the profile). A gateway: the launch's env; the machine's own
 * `ANTHROPIC_API_KEY` is dropped when the token travels as
 * `ANTHROPIC_AUTH_TOKEN` (Claude Code would take the key first), and a
 * `CLAUDE_CODE_OAUTH_TOKEN` always — the gateway is the one sign-in.
 */
function providerCommandEnv(
  agent: LocalAgentKind,
  provider: NonNullable<AgentCommandOptions["provider"]>,
): ProviderCommandEnv | null {
  if (provider.kind === "gateway") {
    if (agent !== "claude-code" && agent !== "opencode") return null;
    const env = provider.env ?? {};
    const unset =
      agent === "claude-code"
        ? [...(env.ANTHROPIC_AUTH_TOKEN ? ["ANTHROPIC_API_KEY"] : []), "CLAUDE_CODE_OAUTH_TOKEN"]
        : [];
    return { env, codexConfig: [], unset };
  }
  if (agent !== "claude-code" && agent !== "codex") return null;
  const unset = provider.awsProfile
    ? [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_BEARER_TOKEN_BEDROCK",
      ]
    : [];
  return { ...bedrockRuntime(agent, provider), unset };
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
 * Every agent skips its permission checks unless the spawn says otherwise
 * (`claude --dangerously-skip-permissions`, `codex --yolo`): the work was
 * started from Optio to run on its own, and a headless `claude -p` without a
 * flag would start in Manual, where every edit and command is denied because
 * nobody can answer the prompt. `auto` and `default` are opt-ins to Claude's
 * classifier / Codex's workspace-write sandbox, or to asking first.
 */
export function buildAgentCommand(
  agent: LocalAgentKind,
  prompt: string | undefined,
  hookSettingsPath: string,
  opts: AgentCommandOptions = {},
): string {
  const provider = opts.provider ? providerCommandEnv(agent, opts.provider) : null;
  // A gateway run's Claude Code reads the hooks file with the gateway's settings in it.
  const settingsPath =
    provider && opts.provider?.kind === "gateway"
      ? gatewaySettingsPath(hookSettingsPath)
      : hookSettingsPath;
  const command = agentCli(agent, prompt, settingsPath, opts, provider?.codexConfig ?? []);
  return provider ? withProviderEnv(provider.env, provider.unset, command) : command;
}

/**
 * Run `command` with the provider's env set on the command itself — after
 * the login shell's rc files, which could otherwise override it — and the
 * variables that would compete with it dropped first (`providerCommandEnv`).
 */
function withProviderEnv(
  env: Record<string, string>,
  unsetNames: string[],
  command: string,
): string {
  const unset = unsetNames.map((name) => ` -u ${name}`).join("");
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
      base += claudePermissionFlag(permissionMode(opts), opts.claudeCaps);
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
      // `--yolo` is Codex's alias for the bypass flag; the long name is the
      // one its --help documents, so it's the one older releases are sure to
      // take. `auto` keeps Codex in its workspace-write sandbox (as a config
      // override: `--full-auto` is gone from recent releases and `--sandbox`
      // can't follow `exec resume`); `default` leaves its config alone.
      const codexPermission = permissionMode(opts);
      let flags =
        codexPermission === "bypassPermissions"
          ? " --dangerously-bypass-approvals-and-sandbox"
          : codexPermission === "auto"
            ? ` -c ${shellQuote('sandbox_mode="workspace-write"')}`
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

/** The spawn's permission mode; an unset or unknown one skips every check. */
function permissionMode(opts: AgentCommandOptions): LocalAgentPermissionMode {
  return LOCAL_AGENT_PERMISSION_MODES.includes(opts.permissionMode!)
    ? opts.permissionMode!
    : "bypassPermissions";
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
