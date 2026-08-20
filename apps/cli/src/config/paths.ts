import { homedir } from "node:os";
import { join } from "node:path";

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "optio") : join(homedir(), ".config", "optio");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

/** Optio Local daemon config (directory allowlist + per-server host ids). */
export function localConfigPath(): string {
  return join(configDir(), "local.json");
}

/** Directory for Optio Local runtime files (e.g. Claude hook settings). */
export function localStateDir(): string {
  return join(configDir(), "local");
}

/** Claude Code hooks settings file injected into `agent: "claude-code"` spawns. */
export function claudeHookSettingsPath(): string {
  return join(localStateDir(), "claude-hooks.json");
}
