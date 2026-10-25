import { loadConfig, saveConfig } from "../config/config-store.js";
import { loadCredentials, saveCredentials } from "../config/credentials-store.js";

export interface LoginResult {
  token: string;
  tokenId: string;
  user: { id: string; email: string; displayName: string };
  host: string;
  server: string;
}

/**
 * Keep a personal access token a sign-in returned: the server becomes the
 * current host (config.json) and the token its credentials
 * (credentials.json, mode 0600). Every sign-in flow ends here.
 */
export function storeLogin(
  server: string,
  tokenData: {
    token: string;
    tokenId: string;
    user: { id: string; email?: string | null; displayName?: string | null };
  },
): LoginResult {
  const user = {
    id: tokenData.user.id,
    email: tokenData.user.email ?? "",
    displayName: tokenData.user.displayName ?? "",
  };
  const host = new URL(server).host;
  const config = loadConfig();
  config.currentHost = host;
  config.hosts[host] = { server };
  saveConfig(config);

  const creds = loadCredentials();
  creds.hosts[host] = { token: tokenData.token, tokenId: tokenData.tokenId, user };
  saveCredentials(creds);

  return { token: tokenData.token, tokenId: tokenData.tokenId, user, host, server };
}
