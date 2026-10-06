import { createHmac } from "node:crypto";
import { z } from "zod";

const Scope = z
  .object({
    workspaceId: z.string().uuid().nullable(),
    ownerUserId: z.string().uuid().nullable(),
  })
  .strict();

/** A pod may refresh credentials for its owner, never another owner/workspace.
 * Give it only this derived key; the deployment signing key stays in the API.
 */
export function gitCredentialScope(scope: z.infer<typeof Scope>): string {
  return Buffer.from(JSON.stringify(scope)).toString("base64url");
}

export function parseGitCredentialScope(scope: string) {
  try {
    return Scope.parse(JSON.parse(Buffer.from(scope, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export function gitCredentialKey(scope: string): string {
  // Do not derive from the legacy credential secret: old pods still know
  // that key. Only the API has the encryption root, so legacy pods cannot
  // mint credentials for new boundaries after this upgrade.
  const root = process.env.OPTIO_ENCRYPTION_KEY;
  if (!root) throw new Error("OPTIO_ENCRYPTION_KEY required for scoped git credentials");
  return createHmac("sha256", root).update(`git-credentials:v1:${scope}`).digest("hex");
}
