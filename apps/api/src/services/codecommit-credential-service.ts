import { retrieveSecretWithFallback } from "./secret-service.js";
import { logger } from "../logger.js";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
}

/**
 * Resolve AWS credentials for CodeCommit access from secrets, with workspace and global scopes,
 * falling back to env vars. Returns the credentials as a JSON string so it can be passed
 * through the existing GitPlatform factory which takes a single `token: string`.
 *
 * Lookup order:
 *   1. Workspace-scoped or global secrets named AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
 *      (+ optional AWS_SESSION_TOKEN, AWS_REGION).
 *   2. Process env vars (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN,
 *      AWS_REGION / AWS_DEFAULT_REGION).
 *
 * If neither source provides creds, returns the sentinel string `"workload-identity"` so the
 * AWS SDK falls back to its default credential provider chain (instance profile / IRSA /
 * environment) at the call site.
 */
export async function getCodeCommitCredentials(workspaceId?: string | null): Promise<string> {
  let accessKeyId: string | undefined;
  let secretAccessKey: string | undefined;
  let sessionToken: string | undefined;
  let region: string | undefined;

  try {
    accessKeyId = await retrieveSecretWithFallback("AWS_ACCESS_KEY_ID", "global", workspaceId);
    secretAccessKey = await retrieveSecretWithFallback(
      "AWS_SECRET_ACCESS_KEY",
      "global",
      workspaceId,
    );
  } catch {
    logger.debug({ workspaceId }, "No AWS credential secrets found, checking env");
  }

  try {
    sessionToken = await retrieveSecretWithFallback("AWS_SESSION_TOKEN", "global", workspaceId);
  } catch {
    // Optional
  }

  try {
    region = await retrieveSecretWithFallback("AWS_REGION", "global", workspaceId);
  } catch {
    // Optional
  }

  accessKeyId ??= process.env.AWS_ACCESS_KEY_ID;
  secretAccessKey ??= process.env.AWS_SECRET_ACCESS_KEY;
  sessionToken ??= process.env.AWS_SESSION_TOKEN;
  region ??= process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

  if (!accessKeyId || !secretAccessKey) {
    // Signal to the SDK to use the default credential provider chain
    return "workload-identity";
  }

  const creds: AwsCredentials = {
    accessKeyId,
    secretAccessKey,
    region: region ?? "us-east-1",
    ...(sessionToken ? { sessionToken } : {}),
  };
  return JSON.stringify(creds);
}

/**
 * Parse a credential string produced by getCodeCommitCredentials() back into an
 * AwsCredentials object, or return null if the caller should use the default chain.
 */
export function parseAwsCredentials(token: string): AwsCredentials | null {
  if (!token || token === "workload-identity") return null;
  try {
    const parsed = JSON.parse(token) as AwsCredentials;
    if (!parsed.accessKeyId || !parsed.secretAccessKey) return null;
    return parsed;
  } catch {
    return null;
  }
}
