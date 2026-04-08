import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { generatePkce } from "./pkce.js";
import { openBrowser } from "../utils/browser.js";
import { loadConfig, saveConfig } from "../config/config-store.js";
import { loadCredentials, saveCredentials } from "../config/credentials-store.js";

const PREFERRED_PORT = 18271;
const SUCCESS_HTML = `<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
<h2>✓ Logged in to Optio</h2><p>You can close this tab.</p></body></html>`;

interface LoginResult {
  token: string;
  tokenId: string;
  user: { id: string; email: string; displayName: string };
  host: string;
  server: string;
}

export async function performLogin(serverUrl: string, provider?: string): Promise<LoginResult> {
  const server = serverUrl.replace(/\/+$/, "");

  // 1. Discover providers if none specified
  if (!provider) {
    const res = await fetch(`${server}/api/auth/providers`);
    const data = (await res.json()) as { providers: string[] };
    provider = data.providers[0] ?? "github";
  }

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
  const host = new URL(server).host;
  const config = loadConfig();
  config.currentHost = host;
  config.hosts[host] = { server };
  saveConfig(config);

  const creds = loadCredentials();
  creds.hosts[host] = {
    token: tokenData.token,
    tokenId: tokenData.tokenId,
    user: tokenData.user,
  };
  saveCredentials(creds);

  return { ...tokenData, host, server };
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
