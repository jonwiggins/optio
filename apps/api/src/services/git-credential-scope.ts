import { createHmac } from "node:crypto";
import { z } from "zod";

const Scope = z
  .object({
    workspaceId: z.string().uuid().nullable(),
    ownerUserId: z.string().uuid().nullable(),
    ownerTeamId: z.string().uuid().nullable().optional(),
  })
  .strict();

/** A pod may refresh credentials for its owner, never another owner/workspace.
 * Give it only this derived key; the deployment signing key stays in the API.
 *
 * A team's work is the team's, not its creator's: its scope names the team
 * and no person, so the helper hands it the organization's token (GitHub
 * has no team token) — never the creator's own (docs/teams.md). Anyone
 * else's scope keeps its old shape, so running pods' keys still verify.
 */
export function gitCredentialScope(scope: z.infer<typeof Scope>): string {
  const { workspaceId, ownerUserId, ownerTeamId } = scope;
  const payload = ownerTeamId
    ? { workspaceId, ownerUserId: null, ownerTeamId }
    : { workspaceId, ownerUserId };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
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
