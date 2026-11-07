import type { Signer } from "./crypto/signer.js";
import { Rs256Signer } from "./crypto/signer.js";
import { logger } from "../logger.js";

// A per-instance cache of installation tokens (an hour long; GitHub mints
// as many as are asked for and rotates nothing), so every API instance
// fetching its own is correct — the locks only fold concurrent callers
// within this process onto one fetch. Not shared state. Keyed by
// installation and repo: the API's own token (every repo of the
// installation) and one per repo a pod works in.
const cachedTokens = new Map<string, { token: string; expiresAt: number }>();
const installationTokenLocks = new Map<string, Promise<string>>();

const TOKEN_CACHE_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

export function isGitHubAppConfigured(): boolean {
  return !!(
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_INSTALLATION_ID &&
    process.env.GITHUB_APP_PRIVATE_KEY
  );
}

// Cache the signer instance so the private key is only parsed once
let _appSigner: Signer | null = null;

export function loadAppSigner(): Signer {
  if (_appSigner) return _appSigner;

  const alg = process.env.GITHUB_APP_JWT_ALG ?? "RS256";
  switch (alg) {
    case "RS256":
      _appSigner = new Rs256Signer(process.env.GITHUB_APP_PRIVATE_KEY!);
      break;
    // Future: case "ML-DSA-65": _appSigner = new MlDsa65Signer(); break;
    default:
      throw new Error(`Unsupported GitHub App JWT algorithm: ${alg}`);
  }

  logger.info(
    { githubAppJwtKty: _appSigner.kty, githubAppJwtAlg: _appSigner.jwtAlg },
    "Signer configuration",
  );

  return _appSigner;
}

export async function generateJwt(): Promise<string> {
  const appId = process.env.GITHUB_APP_ID!;
  const signer = loadAppSigner();

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: signer.jwtAlg ?? "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: appId,
      iat: now - 60, // Clock skew tolerance
      exp: now + 600, // 10 minutes
    }),
  ).toString("base64url");

  const sigBuf = await signer.sign(Buffer.from(`${header}.${payload}`));
  const signature = sigBuf.toString("base64url");

  return `${header}.${payload}.${signature}`;
}

/** One repository of the installation's account, for a token that reaches only it. */
export interface InstallationRepo {
  owner: string;
  name: string;
}

/**
 * An installation token. Without `repo` it reaches every repository the
 * installation does — for the API's own calls only. With `repo` it reaches
 * that one repository (`repositories: [name]`): what a pod, whose agent may
 * be prompt-injected, is given — never the whole installation.
 */
export async function getInstallationToken(repo?: InstallationRepo): Promise<string> {
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID!;
  const key = `${installationId}:${repo ? `${repo.owner}/${repo.name}`.toLowerCase() : "*"}`;
  const cached = cachedTokens.get(key);
  if (cached && Date.now() < cached.expiresAt - TOKEN_CACHE_BUFFER_MS) return cached.token;

  // Dedup concurrent requests: if a fetch is already in-flight, reuse it
  const inFlight = installationTokenLocks.get(key);
  if (inFlight) return inFlight;

  const fetchPromise = fetchInstallationToken(installationId, key, repo);
  installationTokenLocks.set(key, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    installationTokenLocks.delete(key);
  }
}

async function fetchInstallationToken(
  installationId: string,
  key: string,
  repo: InstallationRepo | undefined,
): Promise<string> {
  const jwt = await generateJwt();

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Optio",
        ...(repo ? { "Content-Type": "application/json" } : {}),
      },
      ...(repo ? { body: JSON.stringify({ repositories: [repo.name] }) } : {}),
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to get installation token: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as {
    token: string;
    expires_at: string;
    repositories?: { full_name?: string }[];
  };
  if (repo) {
    // `repositories` names a repo of the installation's account: make sure
    // it is this one (not a same-named repo of another owner), and only it.
    const want = `${repo.owner}/${repo.name}`.toLowerCase();
    const got = (data.repositories ?? []).map((r) => r.full_name?.toLowerCase());
    if (got.length !== 1 || got[0] !== want) {
      throw new Error(`The GitHub App installation token is not limited to ${want}`);
    }
  }
  cachedTokens.set(key, { token: data.token, expiresAt: new Date(data.expires_at).getTime() });
  return data.token;
}

export function resetTokenCache(): void {
  cachedTokens.clear();
  installationTokenLocks.clear();
  _appSigner = null;
}
