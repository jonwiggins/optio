"use client";

import { useEffect, useState } from "react";
import { SectionCard } from "@/components/ui/section-card";
import { EffectiveRules } from "@/components/settings/agent-policy-settings";
import { agentPolicyApi, type RunPolicy } from "@/lib/agent-policy-api";

/**
 * The run page's Agent policy card (docs/agent-policy.md): the deny rules
 * this run started with, where each came from, how they reached the agent,
 * and the pod's RuntimeClass. Nothing for a run from before agent policy.
 */
export function RunAgentPolicy({ runId }: { runId: string }) {
  const [policy, setPolicy] = useState<RunPolicy | null>(null);
  useEffect(() => {
    agentPolicyApi
      .run(runId)
      .then((r) => setPolicy(r.policy))
      .catch(() => setPolicy(null));
  }, [runId]);
  if (!policy) return null;
  const how =
    policy.enforcedBy === "claude-managed-settings"
      ? "Claude Code's managed settings"
      : policy.enforcedBy === "opencode-config"
        ? "OpenCode's config"
        : policy.rules.length === 0
          ? "No rules"
          : `Not enforced for ${policy.agentType ?? "this runtime"}`;
  return (
    <SectionCard label="Agent policy" summary={how}>
      <details data-testid="run-agent-policy">
        <summary className="cursor-pointer text-xs text-primary">
          {policy.rules.length} deny rule{policy.rules.length === 1 ? "" : "s"}
          {policy.defaults ? " (built-in ones on)" : ""}
          {policy.runtimeClassName ? ` · RuntimeClass ${policy.runtimeClassName}` : ""}
        </summary>
        <div className="mt-3 space-y-2">
          <EffectiveRules rules={policy.rules} />
          {policy.notEnforced.length > 0 && (
            <p className="text-[11px] text-text-muted">
              {policy.agentType} has no equivalent for: {policy.notEnforced.join(", ")}
            </p>
          )}
        </div>
      </details>
    </SectionCard>
  );
}
