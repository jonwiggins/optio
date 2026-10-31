"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import {
  BTN_PRIMARY,
  CardFooter,
  Field,
  MONO_AREA,
  SkeletonCard,
  Tag,
} from "@/components/settings/settings-ui";
import {
  parseRules,
  SOURCE_LABEL,
  type PolicyRule,
  type WorkspacePolicyView,
} from "@/lib/agent-policy-api";

/**
 * Workspace settings → Agent policy (docs/agent-policy.md): the deny rules
 * every agent run in the workspace gets, the built-in ones on or off, and
 * the deployment's egress allowlist and RuntimeClass (the operator's, read
 * only here). Workspace admins change the workspace's part; members read it.
 */

const ERR = (err: unknown) => (err instanceof Error ? err.message : undefined);

/** A list of rules, one per line: a textarea and Save for who may change it, a list otherwise. */
export function RuleEditor({
  rules,
  canEdit,
  onSave,
  testId,
}: {
  rules: string[];
  canEdit: boolean;
  onSave: (rules: string[]) => Promise<void>;
  testId?: string;
}) {
  const joined = rules.join("\n");
  const [text, setText] = useState(joined);
  const [saving, setSaving] = useState(false);
  // A new saved list (by value: a fresh array each render must not reset typing).
  useEffect(() => setText(joined), [joined]);

  if (!canEdit) {
    return rules.length === 0 ? (
      <p className="text-xs text-text-muted">None.</p>
    ) : (
      <ul className="space-y-1" data-testid={testId}>
        {rules.map((r) => (
          <li key={r}>
            <code className="text-xs">{r}</code>
          </li>
        ))}
      </ul>
    );
  }
  const changed = parseRules(text).join("\n") !== joined;
  const save = async () => {
    setSaving(true);
    try {
      await onSave(parseRules(text));
      toast.success("Saved");
    } catch (err) {
      toast.error("Couldn't save", { description: ERR(err) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-3">
      <Field help="One Claude Code permission rule per line, e.g. Read(**/secrets/**) or Bash(terraform apply*).">
        <textarea
          className={MONO_AREA}
          rows={Math.max(3, Math.min(12, rules.length + 2))}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Read(**/secrets/**)\nBash(terraform apply*)"}
          aria-label="Deny rules"
          data-testid={testId}
        />
      </Field>
      <CardFooter>
        <button className={BTN_PRIMARY} onClick={save} disabled={saving || !changed}>
          {saving ? "Saving..." : "Save"}
        </button>
      </CardFooter>
    </div>
  );
}

/** The rules a run ends up with, each with where it came from. */
function EffectiveRules({ rules }: { rules: PolicyRule[] }) {
  if (rules.length === 0) return <p className="text-xs text-text-muted">No deny rules.</p>;
  return (
    <ul className="space-y-1.5" data-testid="agent-policy-effective">
      {rules.map((r) => (
        <li key={r.rule} className="flex flex-wrap items-center gap-2">
          <code className="text-xs">{r.rule}</code>
          <Tag tone={r.from === "built-in" ? "muted" : "primary"}>{SOURCE_LABEL[r.from]}</Tag>
          {!r.opencode && (
            <Tag title="OpenCode has no equivalent for this rule">Claude Code only</Tag>
          )}
        </li>
      ))}
    </ul>
  );
}

export function AgentPolicySettings() {
  const [view, setView] = useState<WorkspacePolicyView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .getAgentPolicy()
      .then(setView)
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <SectionCard label="Agent policy">
        <p className="text-xs text-text-muted">The agent policy couldn&apos;t be loaded.</p>
      </SectionCard>
    );
  }
  if (!view) return <SkeletonCard label="Agent policy" rows={4} />;

  const own = view.policy?.denyRules ?? [];
  const fromDeployment = view.deployment.builtInRules;
  const toggleBuiltIn = async (on: boolean) => {
    try {
      setView(await api.setAgentPolicy({ builtInRules: on }));
      toast.success("Saved");
    } catch (err) {
      toast.error("Couldn't save", { description: ERR(err) });
    }
  };

  return (
    <div className="space-y-4" data-testid="agent-policy-settings">
      <SectionCard
        label="Built-in rules"
        hint="Secrets in the checkout and the agent's home, force pushes, piping downloads into a shell"
        summary={view.effective.builtInRules ? "On" : "Off"}
      >
        <div className="space-y-3">
          {fromDeployment ? (
            <p className="text-xs text-text-muted">On for every workspace in this deployment.</p>
          ) : (
            view.canEdit && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={view.policy?.builtInRules === true}
                  onChange={(e) => void toggleBuiltIn(e.target.checked)}
                  aria-label="Built-in rules for this workspace"
                />
                Turn the built-in rules on for this workspace
              </label>
            )
          )}
          <ul className="grid gap-1 sm:grid-cols-2">
            {view.builtIn.map((r) => (
              <li key={r}>
                <code className="text-xs">{r}</code>
              </li>
            ))}
          </ul>
        </div>
      </SectionCard>

      <SectionCard label="This workspace's rules" hint="Added to every agent run in the workspace">
        <RuleEditor
          rules={own}
          canEdit={view.canEdit}
          testId="workspace-deny-rules"
          onSave={async (rules) => setView(await api.setAgentPolicy({ denyRules: rules }))}
        />
      </SectionCard>

      <SectionCard label="What a run gets" hint="Before the rules a repo adds">
        <div className="space-y-3">
          <EffectiveRules rules={view.effective.rules} />
          <p className="text-[11px] text-text-muted/80">
            Claude Code gets these in its managed settings (/etc/claude-code/managed-settings.json),
            which a repo&apos;s own settings can&apos;t override. OpenCode gets the Read, Edit and
            Bash rules in its own config. They stop the agent&apos;s own tools; they are not a
            sandbox: a shell command written another way gets past them.
          </p>
        </div>
      </SectionCard>

      <SectionCard
        label="Where agent pods may connect"
        hint="Set by the operator in the chart (networkPolicy.agentEgress)"
        summary={EGRESS_SUMMARY[view.deployment.egress.mode]}
      >
        <EgressList view={view} />
      </SectionCard>

      <SectionCard
        label="Sandbox (RuntimeClass)"
        hint="Set by the operator (agent.runtimeClassName)"
      >
        <p className="text-xs" data-testid="agent-runtime-class">
          {view.deployment.runtimeClassError ? (
            <span className="text-error">{view.deployment.runtimeClassError}</span>
          ) : view.deployment.runtimeClassName ? (
            <>
              Every agent pod runs under <code>{view.deployment.runtimeClassName}</code>.
            </>
          ) : (
            "The cluster's default runtime."
          )}
        </p>
      </SectionCard>
    </div>
  );
}

const EGRESS_SUMMARY: Record<WorkspacePolicyView["deployment"]["egress"]["mode"], string> = {
  allowlist: "Allowlist",
  default: "Public addresses on 443 and 80",
  "not-set": "No allowlist",
  invalid: "Invalid",
};

function EgressList({ view }: { view: WorkspacePolicyView }) {
  const { egress } = view.deployment;
  if (egress.mode === "invalid") {
    return <p className="text-xs text-error">{egress.error}</p>;
  }
  if (egress.mode !== "allowlist") {
    return (
      <p className="text-xs text-text-muted">
        No allowlist. With the chart&apos;s NetworkPolicy on (networkPolicy.enabled), agent pods
        reach DNS, the Optio API and public addresses on ports 443 and 80; without it, wherever the
        cluster lets them.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5 text-xs" data-testid="agent-egress">
      <li>DNS and the Optio API</li>
      {egress.entries.map((e) => (
        <li key={e.name} className="flex flex-wrap gap-x-2">
          <span className="font-medium">{e.name}</span>
          <span className="text-text-muted">
            {e.to.join(", ")} · port{e.ports.length > 1 ? "s" : ""} {e.ports.join(", ")}
          </span>
        </li>
      ))}
    </ul>
  );
}
