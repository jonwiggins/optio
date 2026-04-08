import { buildClient } from "../api/client.js";
import type { UserInfo } from "../api/types.js";

export async function getCurrentUser(opts: {
  server?: string;
  apiKey?: string;
  workspace?: string;
}): Promise<{ user: UserInfo; server: string; authDisabled: boolean }> {
  const client = buildClient(opts);
  const data = await client.get<{
    user: UserInfo;
    authDisabled: boolean;
  }>("/api/auth/me");
  return { ...data, server: client.serverUrl };
}
