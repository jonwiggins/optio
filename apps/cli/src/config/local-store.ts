import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LocalHostDir } from "@optio/shared";
import { localConfigPath } from "./paths.js";

/**
 * Persistent config for the `optio local` daemon: the directory allowlist
 * plus the host id assigned by each server we have registered with.
 * Lives next to the CLI config (see paths.ts), e.g. ~/.config/optio/local.json.
 */
export interface LocalConfig {
  dirs: LocalHostDir[];
  /** serverUrl → hostId, assigned by POST /api/local/hosts/register. */
  hostIds: Record<string, string>;
}

export function loadLocalConfig(): LocalConfig {
  try {
    const raw = readFileSync(localConfigPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<LocalConfig>;
    return {
      dirs: Array.isArray(parsed.dirs) ? parsed.dirs : [],
      hostIds: parsed.hostIds ?? {},
    };
  } catch {
    return { dirs: [], hostIds: {} };
  }
}

export function saveLocalConfig(config: LocalConfig): void {
  const p = localConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function getHostIdForServer(config: LocalConfig, serverUrl: string): string | undefined {
  return config.hostIds[serverUrl];
}

export function setHostIdForServer(serverUrl: string, hostId: string): void {
  const config = loadLocalConfig();
  config.hostIds[serverUrl] = hostId;
  saveLocalConfig(config);
}
