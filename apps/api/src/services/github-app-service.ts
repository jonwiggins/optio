import { createSign } from "node:crypto";

let cachedToken: { token: string; fetchedAt: number } | null = null;

const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000; // 50 minutes

export function isGitHubAppConfigured(): boolean {
  return !!(
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_APP_INSTALLATION_ID &&
    process.env.GITHUB_APP_PRIVATE_KEY
  );
}

export function generateJwt(): string {
  const appId = process.env.GITHUB_APP_ID!;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY!;

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: appId,
      iat: now - 60, // Clock skew tolerance
      exp: now + 600, // 10 minutes
    }),
  ).toString("base64url");

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey, "base64url");

  return `${header}.${payload}.${signature}`;
}

export async function getInstallationToken(): Promise<string> {
  if (cachedToken && Date.now() - cachedToken.fetchedAt < TOKEN_CACHE_TTL_MS) {
    return cachedToken.token;
  }

  const installationId = process.env.GITHUB_APP_INSTALLATION_ID!;
  const jwt = generateJwt();

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Optio",
      },
    },
  );

  if (!res.ok) {
    throw new Error(`Failed to get installation token: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  cachedToken = { token: data.token, fetchedAt: Date.now() };
  return data.token;
}

export function resetTokenCache(): void {
  cachedToken = null;
}
