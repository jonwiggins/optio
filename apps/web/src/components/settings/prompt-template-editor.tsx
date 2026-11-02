"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import {
  BTN_PRIMARY,
  CardFooter,
  MONO_AREA,
  SkeletonCard,
  TemplateVars,
} from "@/components/settings/settings-ui";
import {
  SourceNote,
  useDefaultsEditing,
  type DefaultsScope,
  type DefaultsSource,
} from "@/components/settings/defaults-scope";

/**
 * Settings → Agent prompt: the default coding prompt and auto-merge, of the
 * workspace (its admins') or, with `scope` deployment, of the deployment
 * (deployment admins'), which every workspace without its own uses.
 */
export function PromptTemplateEditor({ scope = "workspace" }: { scope?: DefaultsScope }) {
  const { canEdit, refusal } = useDefaultsEditing(scope);
  const [template, setTemplate] = useState("");
  const [autoMerge, setAutoMerge] = useState(false);
  const [source, setSource] = useState<DefaultsSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getEffectiveTemplate(undefined, scope)
      .then((res) => {
        setTemplate(res.template);
        setAutoMerge(res.autoMerge);
        setSource(res.source ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [scope]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.savePromptTemplate(
        scope === "deployment" ? { template, autoMerge, scope } : { template, autoMerge },
      );
      setSource(scope);
      toast.success(
        scope === "deployment" ? "Deployment default prompt saved" : "Prompt template saved",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    const res = await api.getBuiltinDefault();
    setTemplate(res.template);
  };

  const label = scope === "deployment" ? "Agent prompt (deployment default)" : "Agent prompt";
  const hint =
    scope === "deployment"
      ? "For every workspace that hasn't set its own"
      : "Default for every repo unless a repo overrides it";
  if (loading) return <SkeletonCard label={label} hint={hint} rows={2} />;

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={autoMerge ? "auto-merge on" : "auto-merge off"}
      bodyClassName="p-4 space-y-4"
    >
      <TemplateVars
        vars={[
          ["TASK_FILE", "Path to the task markdown file written into the worktree"],
          ["BRANCH_NAME", "Git branch name the agent is working on"],
          ["TASK_ID", "Unique task identifier"],
          ["TASK_TITLE", "Short title of the task"],
          ["REPO_NAME", "Repository name (e.g. owner/repo)"],
          [
            "AUTO_MERGE",
            <>
              Whether auto-merge is enabled — use with{" "}
              <code className="text-primary">{"{{#if AUTO_MERGE}}...{{/if}}"}</code>
            </>,
          ],
        ]}
      />
      <textarea
        value={template}
        onChange={(e) => setTemplate(e.target.value)}
        rows={12}
        aria-label="Agent prompt"
        className={MONO_AREA}
      />
      <label className="flex items-center gap-2 text-sm cursor-pointer w-fit">
        <input
          type="checkbox"
          checked={autoMerge}
          onChange={(e) => setAutoMerge(e.target.checked)}
          className="w-4 h-4 rounded"
        />
        Auto-merge PRs
      </label>
      <CardFooter
        note={
          <span className="flex flex-wrap items-center gap-3">
            <button onClick={handleReset} className="text-xs text-primary hover:underline">
              Reset to default
            </button>
            <SourceNote scope={scope} source={source} />
          </span>
        }
      >
        {!canEdit && <span className="text-xs text-text-muted">{refusal}</span>}
        <button onClick={handleSave} disabled={saving || !canEdit} className={BTN_PRIMARY}>
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {saving ? "Saving..." : "Save"}
        </button>
      </CardFooter>
    </SectionCard>
  );
}
