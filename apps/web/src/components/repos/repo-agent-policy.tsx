"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SectionCard } from "@/components/ui/section-card";
import { Field, INPUT } from "@/components/settings/settings-ui";
import { RuleEditor } from "@/components/settings/agent-policy-settings";
import { agentPolicyApi, type LevelPolicyView } from "@/lib/agent-policy-api";

/**
 * Repos → a repo → Agent policy (docs/agent-policy.md): the deny rules work
 * in this repo adds, and the RuntimeClass (gVisor, Kata) its pods run under.
 * A repo's settings are a workspace admin's; others read them.
 */
export function RepoAgentPolicy({ repoId }: { repoId: string }) {
  const [view, setView] = useState<LevelPolicyView | null>(null);
  useEffect(() => {
    agentPolicyApi
      .repo(repoId)
      .then(setView)
      .catch(() => setView(null));
  }, [repoId]);
  if (!view) return null;
  const rules = view.policy?.denyRules ?? [];
  const runtimeClass = view.policy?.runtimeClassName ?? null;
  const runtime = view.runtime ?? { deployment: null, available: [] };

  const setClass = async (next: string) => {
    try {
      setView(
        await agentPolicyApi.setRepo(repoId, {
          denyRules: rules,
          runtimeClassName: next || null,
        }),
      );
      toast.success("Saved");
    } catch (err) {
      toast.error("Couldn't save", { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <SectionCard
      label="Agent policy"
      hint="Deny rules work in this repo adds to the workspace's, and its pods' sandbox"
      summary={runtimeClass ?? runtime.deployment ?? undefined}
    >
      <div className="space-y-4">
        <RuleEditor
          rules={rules}
          canEdit={view.canEdit}
          testId="repo-deny-rules"
          onSave={async (next) =>
            setView(
              await agentPolicyApi.setRepo(repoId, {
                denyRules: next,
                runtimeClassName: runtimeClass,
              }),
            )
          }
        />
        <Field
          label="RuntimeClass"
          help={
            runtime.available.length > 0
              ? "The Kubernetes RuntimeClass this repo's pods run under. Docker-in-Docker can't run under gVisor."
              : "This deployment lists no RuntimeClasses (the chart's agent.runtimeClasses)."
          }
        >
          {view.canEdit ? (
            <select
              className={INPUT}
              value={runtimeClass ?? ""}
              onChange={(e) => setClass(e.target.value)}
              aria-label="RuntimeClass"
              disabled={runtime.available.length === 0 && !runtimeClass}
            >
              <option value="">
                {runtime.deployment
                  ? `The deployment's (${runtime.deployment})`
                  : "The cluster's default runtime"}
              </option>
              {[...new Set([...runtime.available, ...(runtimeClass ? [runtimeClass] : [])])].map(
                (c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ),
              )}
            </select>
          ) : (
            <p className="text-xs">
              {runtimeClass ?? runtime.deployment ?? "The cluster's default runtime"}
            </p>
          )}
        </Field>
      </div>
    </SectionCard>
  );
}
