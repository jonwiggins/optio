import { createHmac } from "node:crypto";
import { z } from "zod";
import { normalizeRepoUrl, parseRepoUrl } from "@optio/shared";
import type { InstallationRepo } from "./github-app-service.js";

const Scope = z
  .object({
    workspaceId: z.string().uuid().nullable(),
    ownerUserId: z.string().uuid().nullable(),
    // A team's work (its creator in ownerUserId): the team's credentials.
    // Absent for every other scope, so those keep the key they had.
    ownerTeamId: z.string().uuid().optional(),
    // The one repo the pod works in (normalized URL): its installation token
    // reaches only that repo. Null: a pod with no repo. Absent: a scope
    // minted before repos were bound (refused unless legacy is allowed).
    repo: z.string().min(1).max(512).nullable().optional(),
  })
  .strict();
export type GitCredentialScope = z.infer<typeof Scope>;

/** A pod may refresh credentials for its owner and repo, never another owner/workspace/repo.
 * Give it only this derived key; the deployment signing key stays in the API.
 */
export function gitCredentialScope(scope: {
  workspaceId: string | null;
  ownerUserId: string | null;
  ownerTeamId?: string | null;
  repoUrl: string | null;
}): string {
  return Buffer.from(
    JSON.stringify({
      workspaceId: scope.workspaceId,
      ownerUserId: scope.ownerUserId,
      ...(scope.ownerTeamId ? { ownerTeamId: scope.ownerTeamId } : {}),
      repo: scope.repoUrl ? normalizeRepoUrl(scope.repoUrl) : null,
    }),
  ).toString("base64url");
}

export function parseGitCredentialScope(scope: string) {
  try {
    return Scope.parse(JSON.parse(Buffer.from(scope, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

/**
 * The GitHub repository a pod's installation token is limited to, from its
 * repo URL. `null` when the URL is not a GitHub repository (that pod gets no
 * GitHub App token at all).
 */
export function installationRepoFor(repoUrl: string): InstallationRepo | null {
  const parsed = parseRepoUrl(repoUrl);
  if (!parsed || parsed.platform !== "github" || parsed.host !== "github.com") return null;
  return { owner: parsed.owner, name: parsed.repo };
}

export function gitCredentialKey(scope: string): string {
  // Do not derive from the legacy credential secret: old pods still know
  // that key. Only the API has the encryption root, so legacy pods cannot
  // mint credentials for new boundaries after this upgrade.
  const root = process.env.OPTIO_ENCRYPTION_KEY;
  if (!root) throw new Error("OPTIO_ENCRYPTION_KEY required for scoped git credentials");
  return createHmac("sha256", root).update(`git-credentials:v1:${scope}`).digest("hex");
}
