"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { SectionCard } from "@/components/ui/section-card";
import {
  BTN_PRIMARY,
  CardFooter,
  MONO_AREA,
  SkeletonCard,
  TemplateVars,
  WORKSPACE_ADMIN_ONLY,
} from "@/components/settings/settings-ui";

/** Settings → Agent prompt: the workspace's default coding prompt and auto-merge. */
export function PromptTemplateEditor() {
  // The workspace's default prompt is its admins' to change (POST /api/prompt-templates).
  const { isAdmin } = useCurrentUser();
  const [template, setTemplate] = useState("");
  const [autoMerge, setAutoMerge] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getEffectiveTemplate()
      .then((res) => {
        setTemplate(res.template);
        setAutoMerge(res.autoMerge);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.savePromptTemplate({ template, autoMerge });
      toast.success("Prompt template saved");
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

  const label = "Agent prompt";
  const hint = "Default for every repo unless a repo overrides it";
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
          <button onClick={handleReset} className="text-xs text-primary hover:underline">
            Reset to default
          </button>
        }
      >
        {!isAdmin && <span className="text-xs text-text-muted">{WORKSPACE_ADMIN_ONLY}</span>}
        <button onClick={handleSave} disabled={saving || !isAdmin} className={BTN_PRIMARY}>
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {saving ? "Saving..." : "Save"}
        </button>
      </CardFooter>
    </SectionCard>
  );
}
