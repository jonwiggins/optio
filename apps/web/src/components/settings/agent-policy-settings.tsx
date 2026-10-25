"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import {
  BTN_PRIMARY,
  CardFooter,
  Field,
  MONO_AREA,
  SkeletonCard,
  Tag,
} from "@/components/settings/settings-ui";
import {
  agentPolicyApi,
  parseRules,
  SOURCE_LABEL,
  type PolicyRule,
  type WorkspacePolicyView,
} from "@/lib/agent-policy-api";

/**
 * Workspace settings → Agent policy (docs/agent-policy.md): the deny rules
 * every agent in the workspace gets (Claude Code's managed settings; OpenCode
 * the same in its own syntax), the built-in ones on or off, where agent pods
 * may connect, and the RuntimeClasses. Workspace admins change it; everyone
 * reads it.
 */

const ERR = (err: unknown) => (err instanceof Error ? err.message : undefined);

/** A list of rules, one per line: a textarea and Save for who may change it, a list otherwise. */
export function RuleEditor({
  rules,
  canEdit,
  onSave,
  hint,
  testId,
}: {
  rules: string[];
  canEdit: boolean;
  onSave: (rules: string[]) => Promise<void>;
  hint?: string;
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
      <Field
        help={
          hint ??
          "One Claude Code permission rule per line, e.g. Read(**/secrets/**) or Bash(terraform apply*)."
        }
      >
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

/** The rules a run or a level ends up with, each with where it came from. */
export function EffectiveRules({ rules }: { rules: PolicyRule[] }) {
  if (rules.length === 0) return <p className="text-xs text-text-muted">No deny rules.</p>;
  return (
    <ul className="space-y-1.5">
      {rules.map((r) => (
        <li key={r.rule} className="flex flex-wrap items-center gap-2">
          <code className="text-xs">{r.rule}</code>
          <Tag tone={r.from === "default" ? "muted" : "primary"}>{SOURCE_LABEL[r.from]}</Tag>
          {!r.opencode && (
            <Tag title="OpenCode has no equivalent for this rule">Claude Code only</Tag>
          )}
        </li>
      ))}
    </ul>
  );
}

type DefaultsChoice = "profile" | "on" | "off";

export function AgentPolicySettings() {
  const [view, setView] = useState<WorkspacePolicyView | null>(null);
  const [failed, setFailed] = useState(false);

  const load = () =>
    agentPolicyApi
      .workspace()
      .then(setView)
      .catch(() => setFailed(true));
  useEffect(() => {
    load();
  }, []);

  if (failed) {
    return (
      <SectionCard label="Agent policy">
        <p className="text-xs text-text-muted">The agent policy couldn&apos;t be loaded.</p>
      </SectionCard>
    );
  }
  if (!view) return <SkeletonCard label="Agent policy" rows={4} />;

  const chosen = view.policy?.defaults;
  const choice: DefaultsChoice = typeof chosen === "boolean" ? (chosen ? "on" : "off") : "profile";
  const setDefaults = async (next: DefaultsChoice) => {
    try {
      await agentPolicyApi.setWorkspace({
        defaults: next === "profile" ? null : next === "on",
        denyRules: view.policy?.denyRules ?? [],
      });
      toast.success("Saved");
      await load();
    } catch (err) {
      toast.error("Couldn't save", { description: ERR(err) });
    }
  };
  const own = view.policy?.denyRules ?? [];

  return (
    <div className="space-y-4" data-testid="agent-policy-settings">
      <SectionCard
        label="Built-in rules"
        hint="Secrets in the checkout and the agent's home, rewriting history, piping downloads into a shell"
        summary={view.effective.defaults ? "On" : "Off"}
      >
        <div className="space-y-3">
          {view.canEdit && (
            <Segmented<DefaultsChoice>
              value={choice}
              onChange={setDefaults}
              aria-label="Built-in rules"
              options={[
                {
                  value: "profile",
                  label: `Deployment default (${view.profileDefaults ? "on" : "off"})`,
                },
                { value: "on", label: "On" },
                { value: "off", label: "Off" },
              ]}
            />
          )}
          <ul className="grid gap-1 sm:grid-cols-2">
            {view.builtIn.map((r) => (
              <li key={r}>
                <code className="text-xs">{r}</code>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-text-muted/80">
            Claude Code gets these in its managed settings (/etc/claude-code/managed-settings.json),
            which a repo&apos;s own settings can&apos;t override and which apply even with
            permission checks skipped. OpenCode gets the Read, Edit and Bash rules in its own
            config. They stop the agent&apos;s own tools, not every command it could run: the egress
            allowlist below is what keeps data in.
          </p>
        </div>
      </SectionCard>

      <SectionCard
        label="This workspace's rules"
        hint="Added to every agent's, on top of the built-in ones"
      >
        <RuleEditor
          rules={own}
          canEdit={view.canEdit}
          testId="workspace-deny-rules"
          onSave={async (rules) => {
            await agentPolicyApi.setWorkspace({ defaults: chosen ?? null, denyRules: rules });
            await load();
          }}
        />
      </SectionCard>

      <SectionCard
        label="Where agent pods may connect"
        hint="The chart's NetworkPolicy (networkPolicy.agentEgress)"
        summary={
          view.egress.mode === "allowlist"
            ? "Allowlist"
            : view.egress.mode === "any-https"
              ? "Any host on 443 and 80"
              : "Not enforced"
        }
      >
        <EgressList view={view} />
      </SectionCard>

      <SectionCard
        label="Sandbox (RuntimeClass)"
        hint="gVisor or Kata between the agent and the node"
      >
        <dl className="space-y-2 text-xs">
          <div className="flex flex-wrap gap-2">
            <dt className="text-text-muted">Every agent pod:</dt>
            <dd>
              {view.runtime.deployment ? (
                <code>{view.runtime.deployment}</code>
              ) : (
                "the cluster's default runtime (agent.runtimeClassName unset)"
              )}
            </dd>
          </div>
          <div className="flex flex-wrap gap-2">
            <dt className="text-text-muted">A repo may pick:</dt>
            <dd>
              {view.runtime.available.length > 0
                ? view.runtime.available.join(", ")
                : "none (agent.runtimeClasses is empty)"}
            </dd>
          </div>
        </dl>
      </SectionCard>
    </div>
  );
}

function EgressList({ view }: { view: WorkspacePolicyView }) {
  const { egress } = view;
  if (egress.mode === "unenforced") {
    return (
      <p className="text-xs text-text-muted">
        No NetworkPolicy: agent pods may connect anywhere the cluster lets them. An operator turns
        it on with the chart&apos;s networkPolicy.enabled and lists the allowed hosts in
        networkPolicy.agentEgress.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5 text-xs" data-testid="agent-egress">
      {egress.always.map((a) => (
        <li key={a}>{a}</li>
      ))}
      {egress.mode === "any-https" ? (
        <li>
          Any host on ports 443 and 80 (no allowlist: the chart&apos;s networkPolicy.agentEgress is
          empty)
        </li>
      ) : (
        egress.entries.map((e) => (
          <li key={e.name} className="flex flex-wrap gap-x-2">
            <span className="font-medium">{e.name}</span>
            <span className="text-text-muted">
              {e.to.join(", ")} · port{e.ports.length > 1 ? "s" : ""} {e.ports.join(", ")}
            </span>
          </li>
        ))
      )}
    </ul>
  );
}
