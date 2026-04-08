import { loadConfig, saveConfig } from "../config/config-store.js";
import { loadCredentials, saveCredentials } from "../config/credentials-store.js";

export async function performLogout(serverUrl?: string): Promise<{ host: string }> {
  const config = loadConfig();
  const hostKey = serverUrl ? new URL(serverUrl).host : config.currentHost;

  if (!hostKey) {
    throw new Error("No server configured. Nothing to log out of.");
  }

  const hostConfig = config.hosts[hostKey];
  const creds = loadCredentials();
  const hostCreds = creds.hosts[hostKey];

  // Revoke on server if we have a token and server URL
  if (hostCreds?.token && hostConfig?.server) {
    try {
      await fetch(`${hostConfig.server}/api/auth/api-keys/${hostCreds.tokenId}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${hostCreds.token}`,
        },
      });
    } catch {
      // Best-effort server-side revocation
    }
  }

  // Remove local entries
  delete creds.hosts[hostKey];
  saveCredentials(creds);

  delete config.hosts[hostKey];
  if (config.currentHost === hostKey) {
    const remaining = Object.keys(config.hosts);
    config.currentHost = remaining[0] ?? undefined;
  }
  saveConfig(config);

  return { host: hostKey };
}
