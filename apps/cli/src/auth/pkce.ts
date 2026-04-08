import { randomBytes, createHash } from "node:crypto";

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

export function generatePkce(): PkcePair {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}
