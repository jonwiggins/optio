"use client";

import { KeyRound } from "lucide-react";
import { api } from "@/lib/api-client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useGateway } from "@/hooks/use-gateway";
import { useFeatures } from "@/hooks/use-features";
import { SectionCard } from "@/components/ui/section-card";
import { EmptyState } from "@/components/empty-state";
import { SkeletonCard } from "./settings-ui";
import { GatewayTokenField, TokenChip, keyInfoLine } from "./gateway-token-field";
import { GitLabTokenSection } from "./gitlab-token-section";
import { PersonalGatewayToken, useMyGatewayKey } from "./my-gateway-key";
import { MyCredentialHealth } from "./system-health";

/**
 * Settings → My tokens (docs/model-gateway.md): the viewer's own token for
 * the workspace's default model gateway — every run of their work carries
 * it; pasted, or made by Optio on the gateway ("Get my token",
 * my-gateway-key.tsx), as the gateway allows — and, read-only unless they
 * may change them, their teams' tokens
 * and the organization's. A team admin (or a workspace admin) adds a
 * team's here or under Teams → the team → Tokens; a workspace admin the
 * organization's. Below it, their own GitLab token (`GITLAB_TOKEN` at user
 * scope), used for their work on GitLab instead of the organization's, and
 * the health of each of their tokens (docs/credential-health.md).
 */
export function MyTokens() {
  const { user, isAdmin } = useCurrentUser();
  const { gatewayOnly } = useFeatures();
  const { status, loaded, reload } = useGateway();
  // How the gateway hands out tokens: pasted, made by Optio, or both (my-gateway-key.tsx).
  const { keyStatus, reload: reloadKey } = useMyGatewayKey();

  const label = "My tokens";
  const hint = "Your token for the model gateway";
  if (!loaded) return <SkeletonCard id="my-tokens" label={label} hint={hint} rows={1} />;

  const gateway = status?.gateway ?? null;
  const gitlab = <GitLabTokenSection scope="user" userId={user?.id ?? null} />;
  if (!gateway) {
    // No gateway token to hold. The default deployment reaches models other ways,
    // so only the GitLab token stays; the restricted deployment says what's missing.
    return (
      <SectionCard
        id="my-tokens"
        label={label}
        hint={gatewayOnly ? hint : "Your GitLab token"}
        bodyClassName="p-4 space-y-4"
      >
        {gatewayOnly && (
          <EmptyState
            size="panel"
            icon={KeyRound}
            title="No model gateway yet"
            description="An admin adds the organization's gateway under Model gateway below; tokens come after."
          />
        )}
        <div className={gatewayOnly ? "pt-3 border-t border-border/50" : undefined}>{gitlab}</div>
        <div className="pt-3 border-t border-border/50">
          <MyCredentialHealth />
        </div>
      </SectionCard>
    );
  }

  const adminTeams = new Set(user?.adminTeamIds ?? []);
  const canEditTeam = (teamId: string) => isAdmin || adminTeams.has(teamId);
  const teams = status?.teams ?? [];
  const personalLine = keyInfoLine(status?.keyInfo);
  // A gateway that takes only keys Optio makes refuses a pasted team token too.
  const pastingTeams = keyStatus?.modes.personalPasted ?? true;

  return (
    <SectionCard
      id="my-tokens"
      label={label}
      hint={hint}
      summary={status?.hasToken ? "Token stored" : "No token yet"}
      bodyClassName="p-4 space-y-4"
    >
      <p className="text-xs text-text-muted">
        Work you own runs with your own token for <strong>{gateway.name}</strong>{" "}
        <span className="font-mono">({gateway.baseUrl})</span>, stored as{" "}
        <code>{gateway.secretName}</code>. Without one, your runs fail until you add it.
      </p>

      <PersonalGatewayToken
        keyStatus={keyStatus}
        hasToken={!!status?.hasToken}
        usageLine={personalLine}
        onChanged={async () => {
          await Promise.all([reload(), reloadKey()]);
        }}
      />

      {teams.length > 0 && (
        <div className="space-y-3 pt-3 border-t border-border/50">
          <p className="text-sm font-medium">Your teams</p>
          {teams.map((t) => (
            <div key={t.id} className="space-y-1.5" data-testid={`team-token-${t.id}`}>
              <div className="flex items-center gap-2">
                <span className="text-sm">{t.name}</span>
                <TokenChip hasToken={t.hasToken} />
                {!canEditTeam(t.id) && (
                  <span className="text-[11px] text-text-muted">a team admin adds it</span>
                )}
                {canEditTeam(t.id) && !pastingTeams && (
                  <span className="text-[11px] text-text-muted">
                    made by Optio under Teams → {t.name} → Tokens
                  </span>
                )}
              </div>
              {canEditTeam(t.id) && pastingTeams && (
                <GatewayTokenField
                  placeholder={t.hasToken ? "Replace the team's token" : "The team's token"}
                  onSave={async (value) => {
                    await api.createSecret({
                      name: gateway.secretName,
                      value,
                      scope: "team",
                      teamId: t.id,
                    });
                  }}
                  onSaved={reload}
                />
              )}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-1.5 pt-3 border-t border-border/50" data-testid="org-token">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">The organization</span>
          <TokenChip hasToken={!!status?.orgHasToken} />
          <span className="text-[11px] text-text-muted">
            {isAdmin
              ? "Background runs of the organization's work use it."
              : "An admin adds it; the organization's work runs with it."}
          </span>
        </div>
        {isAdmin && (
          <GatewayTokenField
            placeholder={
              status?.orgHasToken ? "Replace the organization's token" : "The organization's token"
            }
            onSave={async (value) => {
              await api.createSecret({ name: gateway.secretName, value, scope: "global" });
            }}
            onSaved={reload}
          />
        )}
      </div>

      <div className="pt-3 border-t border-border/50">{gitlab}</div>
      {/* Whether each of them still works, and when it expires (docs/credential-health.md). */}
      <div className="pt-3 border-t border-border/50">
        <MyCredentialHealth />
      </div>
    </SectionCard>
  );
}
