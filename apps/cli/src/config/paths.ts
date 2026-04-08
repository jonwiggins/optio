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
