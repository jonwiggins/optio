"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { AgentType } from "@optio/shared";
import { api } from "@/lib/api-client";
import { AgentIcon } from "@/components/brand-icon";
import { ReviewAgentPicker } from "@/components/review-agent-picker";
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
 * Settings → Code review: the workspace's default reviewer (agent and model,
 * saved through PUT /api/optio/settings) and review prompt (the
 * "review-default" prompt). When a review starts, how deep it goes and the
 * test command are each repo's own (the repo's settings page). With `scope`
 * deployment, the deployment's defaults, which every workspace without its
 * own uses.
 */
export function DefaultReviewEditor({ scope = "workspace" }: { scope?: DefaultsScope }) {
  // Both saves take a workspace admin, or a deployment admin for the deployment's.
  const { canEdit, refusal } = useDefaultsEditing(scope);
  const [reviewPrompt, setReviewPrompt] = useState("");
  const [reviewAgentType, setReviewAgentType] = useState<AgentType>("claude-code");
  const [reviewModel, setReviewModel] = useState("");
  const [promptSource, setPromptSource] = useState<DefaultsSource | null>(null);
  const [reviewerSource, setReviewerSource] = useState<DefaultsSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.getReviewDefault(scope).catch(() => null),
      api.getOptioSettings(scope).catch(() => null),
    ])
      .then(([promptRes, settingsRes]) => {
        setPromptSource(promptRes?.source ?? null);
        setReviewerSource(settingsRes?.source ?? null);
        if (promptRes?.template) {
          setReviewPrompt(promptRes.template);
        } else {
          import("@optio/shared")
            .then((m) => setReviewPrompt(m.DEFAULT_REVIEW_PROMPT_TEMPLATE))
            .catch(() => {});
        }
        const s = settingsRes?.settings;
        if (s) {
          if (s.defaultReviewAgentType) setReviewAgentType(s.defaultReviewAgentType as AgentType);
          if (s.defaultReviewModel) setReviewModel(s.defaultReviewModel);
        }
      })
      .finally(() => setLoading(false));
  }, [scope]);

  const label = scope === "deployment" ? "Code review (deployment default)" : "Code review";
  const hint =
    scope === "deployment"
      ? "The default reviewer for every workspace that hasn't set its own"
      : "The default reviewer for every repo";
  if (loading) return <SkeletonCard label={label} hint={hint} rows={3} />;

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={[reviewAgentType, reviewModel].filter(Boolean).join(" · ")}
      summaryIcon={<AgentIcon runtime={reviewAgentType} className="w-3 h-3" />}
      bodyClassName="p-4 space-y-4"
    >
      <ReviewAgentPicker
        agentType={reviewAgentType}
        onAgentTypeChange={(next) => setReviewAgentType(next ?? "claude-code")}
        model={reviewModel}
        onModelChange={setReviewModel}
        allowInherit={false}
      />
      <SourceNote scope={scope} source={reviewerSource} />

      <div className="pt-4 border-t border-border space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-xs font-medium text-text-muted">Review prompt</div>
          <SourceNote scope={scope} source={promptSource} />
        </div>
        <TemplateVars
          vars={[
            ["PR_NUMBER", "Pull request number"],
            ["TASK_FILE", "Path to the review context file"],
            ["REPO_NAME", "Repository name (e.g. owner/repo)"],
            ["TASK_TITLE", "Original task title"],
            ["TEST_COMMAND", "Test command from repo settings"],
          ]}
        />
        <textarea
          value={reviewPrompt}
          onChange={(e) => setReviewPrompt(e.target.value)}
          rows={10}
          aria-label="Review prompt"
          className={MONO_AREA}
        />
      </div>

      <CardFooter
        note={
          <button
            onClick={() =>
              import("@optio/shared").then((m) => setReviewPrompt(m.DEFAULT_REVIEW_PROMPT_TEMPLATE))
            }
            className="text-xs text-primary hover:underline"
          >
            Reset to default
          </button>
        }
      >
        {!canEdit && <span className="text-xs text-text-muted">{refusal}</span>}
        <button
          onClick={async () => {
            setSaving(true);
            try {
              const reviewer = {
                defaultReviewAgentType: reviewAgentType,
                defaultReviewModel: reviewModel || null,
              };
              if (scope === "deployment") {
                await api.saveReviewDefault(reviewPrompt, scope);
                await api.updateOptioSettings({ ...reviewer, scope });
              } else {
                await api.saveReviewDefault(reviewPrompt);
                await api.updateOptioSettings(reviewer);
              }
              setPromptSource(scope);
              setReviewerSource(scope);
              toast.success(
                scope === "deployment"
                  ? "Deployment review defaults saved"
                  : "Review defaults saved",
              );
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Failed to save");
            } finally {
              setSaving(false);
            }
          }}
          disabled={saving || !canEdit}
          className={BTN_PRIMARY}
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {saving ? "Saving..." : "Save"}
        </button>
      </CardFooter>
    </SectionCard>
  );
}
