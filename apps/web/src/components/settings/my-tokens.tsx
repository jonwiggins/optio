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

/**
 * Settings → My tokens (docs/model-gateway.md): the viewer's own token for
 * the workspace's default model gateway — every run of their work through
 * it carries it — and, read-only unless they are an admin, the
 * organization's. Each is stored as the secret `gateway:<providerId>`,
 * bound to the gateway's current URLs: after the gateway moves, it is
 * entered again here.
 */
export function MyTokens() {
  const { isAdmin } = useCurrentUser();
  const { gatewayOnly } = useFeatures();
  const { status, loaded, reload } = useGateway();

  const label = "My tokens";
  const hint = "Your token for the model gateway";
  if (!loaded) return <SkeletonCard id="my-tokens" label={label} hint={hint} rows={1} />;

  const gateway = status?.gateway ?? null;
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
      </SectionCard>
    );
  }

  const personalLine = keyInfoLine(status?.keyInfo);

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
        <span className="font-mono">({gateway.baseUrl})</span>. It is only ever sent to that
        address: if the gateway moves, enter it again. Without one, your runs fail until you add it.
      </p>

      <GatewayTokenField
        testId="my-token"
        placeholder={status?.hasToken ? "Paste a new token to replace it" : "Paste your token"}
        onSave={async (token) => (await api.setMyGatewayToken(token, gateway.id)).test}
        onSaved={reload}
      />
      {personalLine && <p className="text-xs text-text-muted">{personalLine}</p>}

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
            onSave={async (value) =>
              (await api.setOrganizationGatewayToken(gateway.id, value)).test
            }
            onSaved={reload}
          />
        )}
      </div>
    </SectionCard>
  );
}
