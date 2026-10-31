"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import { RuleEditor } from "@/components/settings/agent-policy-settings";
import type { RepoPolicyView } from "@/lib/agent-policy-api";

/**
 * Repos → a repo → Agent policy (docs/agent-policy.md): the deny rules work
 * in this repo adds to the workspace's. Workspace admins change them; others
 * read them.
 */
export function RepoAgentPolicy({ repoId }: { repoId: string }) {
  const [view, setView] = useState<RepoPolicyView | null>(null);
  useEffect(() => {
    api
      .getRepoAgentPolicy(repoId)
      .then(setView)
      .catch(() => setView(null));
  }, [repoId]);
  if (!view) return null;
  return (
    <SectionCard label="Agent policy" hint="Deny rules work in this repo adds to the workspace's">
      <RuleEditor
        rules={view.policy?.denyRules ?? []}
        canEdit={view.canEdit}
        testId="repo-deny-rules"
        onSave={async (denyRules) => setView(await api.setRepoAgentPolicy(repoId, { denyRules }))}
      />
    </SectionCard>
  );
}
