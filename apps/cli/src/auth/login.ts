import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { generatePkce } from "./pkce.js";
import { openBrowser } from "../utils/browser.js";
import { performLdapLogin } from "./ldap-login.js";
import { storeLogin, type LoginResult } from "./store-login.js";

const PREFERRED_PORT = 18271;
const SUCCESS_HTML = `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
<h2>✓ Logged in to Optio</h2><p>You can close this tab.</p></body></html>`;

export async function performLogin(serverUrl: string, provider?: string): Promise<LoginResult> {
  const server = serverUrl.replace(/\/+$/, "");

  // 1. Discover providers if none specified
  let usernameLabel: string | null | undefined;
  if (!provider) {
    const res = await fetch(`${server}/api/auth/providers`);
    const data = (await res.json()) as {
      providers: Array<{
        name: string;
        displayName: string;
        method?: "redirect" | "password";
        usernameLabel?: string | null;
      }>;
      setupRequired?: boolean;
    };
    if (data.setupRequired) {
      throw new Error(
        "Nobody can sign in to this Optio yet: open it in a browser and finish the setup wizard's Sign-in step.",
      );
    }
    // A browser sign-in when there is one; the password one (LDAP) when
    // it is all there is.
    const isPassword = (p: { name: string; method?: string }) =>
      p.method === "password" || p.name === "ldap";
    const redirect = data.providers.find((p) => !isPassword(p));
    const password = data.providers.find(isPassword);
    provider = redirect?.name ?? password?.name ?? "github";
    usernameLabel = password?.usernameLabel;
  }
  if (provider === "ldap") return performLdapLogin(server, { usernameLabel });

  // 2. Generate PKCE + state
  const pkce = generatePkce();
  const state = randomBytes(16).toString("hex");

  // 3. Start loopback server
  const { port, callbackPromise } = await startLoopback(state);
  const callbackUrl = `http://127.0.0.1:${port}/cb`;

  // 4. Start CLI flow on server
  const startRes = await fetch(`${server}/api/auth/cli/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      callback: callbackUrl,
      state,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: "S256",
      client_name: "optio-cli",
      client_version: "0.1.0",
    }),
  });
  const startData = (await startRes.json()) as { url: string };

  // 5. Open browser
  await openBrowser(startData.url);

  // 6. Wait for callback
  const callbackResult = await callbackPromise;

  // 7. Exchange code for PAT
  const tokenRes = await fetch(`${server}/api/auth/cli/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: callbackResult.code,
      code_verifier: pkce.codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    const err = (await tokenRes.json()) as { error: string };
    throw new Error(`Token exchange failed: ${err.error}`);
  }

  const tokenData = (await tokenRes.json()) as {
    token: string;
    tokenId: string;
    user: { id: string; email: string; displayName: string };
  };

  // 8. Save config + credentials
  return storeLogin(server, tokenData);
}

function startLoopback(
  expectedState: string,
): Promise<{ port: number; callbackPromise: Promise<{ code: string; state: string }> }> {
  return new Promise((resolveStart) => {
    let resolveCallback: (value: { code: string; state: string }) => void;
    const callbackPromise = new Promise<{ code: string; state: string }>((r) => {
      resolveCallback = r;
    });

    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (url.pathname === "/cb") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SUCCESS_HTML);
        srv.close();

        if (code && state === expectedState) {
          resolveCallback({ code, state });
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    // Try preferred port, fall back to ephemeral
    srv.listen(PREFERRED_PORT, "127.0.0.1", () => {
      resolveStart({ port: PREFERRED_PORT, callbackPromise });
    });
    srv.on("error", () => {
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolveStart({ port, callbackPromise });
      });
    });
  });
}
