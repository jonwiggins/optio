"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { GatewayTokenField, TokenChip } from "./gateway-token-field";

/**
 * A GitLab token for one person's or one team's work (docs/teams.md): the
 * secret `GITLAB_TOKEN` at user or team scope. Optio reaches GitLab for a
 * piece of work with its team's token (a team's work), else its owner's own,
 * else the organization's — the same order the agent pods get it in.
 *
 *   <GitLabTokenSection scope="user" />          // Settings → My tokens
 *   <GitLabTokenSection scope="team" teamId=… /> // Teams → the team → Tokens
 */

export const GITLAB_TOKEN_SECRET = "GITLAB_TOKEN";

export function GitLabTokenSection(
  props: { scope: "user"; userId: string | null } | { scope: "team"; teamId: string },
) {
  const personal = props.scope === "user";
  // A person's own token shows whether one is stored; a team's is write-only here.
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const userId = personal ? props.userId : null;

  const reload = useCallback(async () => {
    if (!personal) return;
    try {
      const { secrets } = await api.listSecrets("user");
      setHasToken(
        secrets.some(
          (s) =>
            s.name === GITLAB_TOKEN_SECRET &&
            s.scope === "user" &&
            (!userId || s.ownerUserId === userId),
        ),
      );
    } catch {
      setHasToken(null);
    }
  }, [personal, userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async () => {
    try {
      await api.deleteSecret(GITLAB_TOKEN_SECRET, "user");
      toast.success("GitLab token removed");
      await reload();
    } catch (err) {
      toast.error("Couldn't remove the token", {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  return (
    <div className="space-y-2" data-testid={personal ? "my-gitlab-token" : "team-gitlab-token"}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">GitLab token</span>
        {hasToken !== null && <TokenChip hasToken={hasToken} />}
        {personal && hasToken && (
          <button
            type="button"
            onClick={remove}
            className="text-[11px] text-text-muted hover:text-error hover:underline"
          >
            Remove
          </button>
        )}
      </div>
      <p className="text-xs text-text-muted">
        {personal
          ? "Used for your work on GitLab instead of the organization's token — merge requests, pipelines and clones under your account."
          : "Used for this team's work on GitLab instead of the organization's token."}{" "}
        A personal or project access token with the <code>api</code> scope, stored as{" "}
        <code>{GITLAB_TOKEN_SECRET}</code>.
      </p>
      <GatewayTokenField
        placeholder={
          personal
            ? hasToken
              ? "Paste a new token to replace it"
              : "glpat-…"
            : "The team's GitLab token (replaces any stored)"
        }
        onSave={async (value) => {
          await api.createSecret({
            name: GITLAB_TOKEN_SECRET,
            value,
            ...(personal ? { scope: "user" } : { scope: "team", teamId: props.teamId }),
          });
        }}
        onSaved={reload}
      />
    </div>
  );
}
