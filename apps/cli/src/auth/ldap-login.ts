import { createPrompter, type Prompter } from "../utils/prompt.js";
import { storeLogin, type LoginResult } from "./store-login.js";

/**
 * `optio login --provider ldap`: the LDAP / Active Directory password
 * sign-in. Asks for the username and the password here (the password isn't
 * echoed), sends them to `POST /api/auth/ldap/login` with `cli: true`, and
 * keeps the personal access token it answers with — no browser involved,
 * so it works over SSH and in a remote workspace.
 */
export async function performLdapLogin(
  server: string,
  opts: { usernameLabel?: string | null; prompter?: Prompter } = {},
): Promise<LoginResult> {
  const prompter = opts.prompter ?? createPrompter();
  let username: string;
  let password: string;
  try {
    username = (await prompter.ask(`${opts.usernameLabel?.trim() || "Username"}: `)).trim();
    if (!username) throw new Error("Give a username");
    password = await prompter.ask("Password: ", { hidden: true });
    if (!password) throw new Error("Give a password");
  } finally {
    prompter.close();
  }

  const res = await fetch(`${server}/api/auth/ldap/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, cli: true }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    token?: string;
    tokenId?: string;
    user?: { id: string; email?: string | null; displayName?: string | null };
  };
  if (!res.ok) {
    throw new Error(`Sign-in failed: ${data.error ?? `HTTP ${res.status}`}`);
  }
  if (!data.token || !data.tokenId || !data.user) {
    throw new Error("Sign-in failed: the server didn't return a token (is it older than the CLI?)");
  }
  return storeLogin(server, { token: data.token, tokenId: data.tokenId, user: data.user });
}
