"use client";

import type { TeamDetail } from "@optio/shared";
import { api } from "@/lib/api-client";
import { useGateway } from "@/hooks/use-gateway";
import { useFeatures } from "@/hooks/use-features";
import { SectionCard } from "@/components/ui/section-card";
import { GatewayTokenField, TokenChip } from "@/components/settings/gateway-token-field";
import { GitLabTokenSection } from "@/components/settings/gitlab-token-section";
import { TeamGatewayKey, useTeamGatewayKey } from "./team-gateway-key";

/**
 * Teams → a team → Tokens (docs/model-gateway.md): the team's token for the
 * default model gateway, which every run of the team's work carries — pasted,
 * or made by Optio with a team budget ("Create team key",
 * team-gateway-key.tsx), as the gateway allows. For those who manage the
 * team; the same control as Settings → My tokens. And
 * the team's GitLab token (`GITLAB_TOKEN` at team scope), used for the
 * team's work on GitLab instead of the organization's.
 */
export function TeamTokens({ team }: { team: TeamDetail }) {
  const { gatewayOnly } = useFeatures();
  const { status, loaded, reload } = useGateway();
  // The key Optio made the team, its budget, and which ways the gateway allows (team-gateway-key.tsx).
  const { teamKey, reload: reloadKey } = useTeamGatewayKey(team.id);
  if (!loaded) return null;
  const pasting = teamKey?.modes.personalPasted ?? true;
  const changed = async () => {
    await Promise.all([reload(), reloadKey()]);
  };
  const gateway = status?.gateway ?? null;
  const mine = status?.teams.find((t) => t.id === team.id);
  const gitlab = (
    <div className="pt-3 border-t border-border/50">
      <GitLabTokenSection scope="team" teamId={team.id} />
    </div>
  );
  // The default deployment without a gateway: only the GitLab token is the team's to hold.
  if (!gateway && !gatewayOnly) {
    return (
      <SectionCard
        id="team-tokens"
        label="Tokens"
        hint="The team's GitLab token"
        bodyClassName="p-4 space-y-3"
      >
        <GitLabTokenSection scope="team" teamId={team.id} />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      id="team-tokens"
      label="Tokens"
      hint="The team's tokens for the model gateway and GitLab"
      summary={gateway ? (mine?.hasToken ? "Token stored" : "No token yet") : undefined}
      bodyClassName="p-4 space-y-3"
    >
      {!gateway ? (
        <p className="text-xs text-text-muted">
          No model gateway yet — an admin adds the organization&apos;s under Settings → Model
          gateway; the team&apos;s token comes after.
        </p>
      ) : (
        <>
          <p className="text-xs text-text-muted">
            The team&apos;s work runs with this token for <strong>{gateway.name}</strong>, stored as{" "}
            <code>{gateway.secretName}</code> at the team&apos;s scope. Without one, its runs fail
            until a team admin adds it.
          </p>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{team.name}</span>
            <TokenChip hasToken={!!mine?.hasToken} />
          </div>
          {teamKey && (
            <TeamGatewayKey
              key={`${teamKey.issued?.id ?? "none"}-${teamKey.budget?.maxBudget ?? ""}`}
              teamKey={teamKey}
              onChanged={changed}
            />
          )}
          {pasting && (
            <GatewayTokenField
              testId="team-token"
              label={teamKey?.modes.optioIssued ? "Or paste a key from the gateway" : undefined}
              placeholder={mine?.hasToken ? "Replace the team's token" : "The team's token"}
              onSave={async (value) => {
                await api.createSecret({
                  name: gateway.secretName,
                  value,
                  scope: "team",
                  teamId: team.id,
                });
              }}
              onSaved={changed}
            />
          )}
        </>
      )}
      {gitlab}
    </SectionCard>
  );
}
