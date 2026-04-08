import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./paths.js";

export interface HostConfig {
  server: string;
  workspaceId?: string;
  workspaceSlug?: string;
}

export interface Config {
  currentHost?: string;
  hosts: Record<string, HostConfig>;
}

export function loadConfig(): Config {
  try {
    const raw = readFileSync(configPath(), "utf-8");
    return JSON.parse(raw) as Config;
  } catch {
    return { hosts: {} };
  }
}

export function saveConfig(config: Config): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function getCurrentHost(config: Config): HostConfig | undefined {
  if (!config.currentHost) return undefined;
  return config.hosts[config.currentHost];
}

export function getServerUrl(config: Config, flagServer?: string): string | undefined {
  if (flagServer) return flagServer.replace(/\/+$/, "");
  const host = getCurrentHost(config);
  return host?.server;
}
