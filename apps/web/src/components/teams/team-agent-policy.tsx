"use client";

import { useEffect, useState } from "react";
import { SectionCard } from "@/components/ui/section-card";
import { RuleEditor } from "@/components/settings/agent-policy-settings";
import { agentPolicyApi, type LevelPolicyView } from "@/lib/agent-policy-api";

/**
 * Teams → a team → Agent policy (docs/agent-policy.md): the deny rules the
 * team's work adds to the workspace's. Its admins (and workspace admins)
 * change them; members read them.
 */
export function TeamAgentPolicy({ teamId }: { teamId: string }) {
  const [view, setView] = useState<LevelPolicyView | null>(null);
  useEffect(() => {
    agentPolicyApi
      .team(teamId)
      .then(setView)
      .catch(() => setView(null));
  }, [teamId]);
  if (!view) return null;
  const rules = view.policy?.denyRules ?? [];
  if (!view.canEdit && rules.length === 0) return null;
  return (
    <SectionCard
      label="Agent policy"
      hint="Deny rules the team's work adds to the workspace's (Workspace settings → Agent policy)"
    >
      <RuleEditor
        rules={rules}
        canEdit={view.canEdit}
        testId="team-deny-rules"
        onSave={async (next) => setView(await agentPolicyApi.setTeam(teamId, { denyRules: next }))}
      />
    </SectionCard>
  );
}
