import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { credentialsPath } from "./paths.js";

export interface HostCredentials {
  token: string;
  tokenId: string;
  user: { id: string; email: string; displayName: string };
}

export interface Credentials {
  hosts: Record<string, HostCredentials>;
}

export function loadCredentials(): Credentials {
  try {
    const raw = readFileSync(credentialsPath(), "utf-8");
    return JSON.parse(raw) as Credentials;
  } catch {
    return { hosts: {} };
  }
}

export function saveCredentials(creds: Credentials): void {
  const p = credentialsPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    // ignore on Windows
  }
}

export function getToken(hostname: string): string | undefined {
  const creds = loadCredentials();
  return creds.hosts[hostname]?.token;
}
