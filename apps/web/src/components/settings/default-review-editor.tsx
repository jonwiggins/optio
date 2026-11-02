"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { AgentType } from "@optio/shared";
import { api } from "@/lib/api-client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { AgentIcon } from "@/components/brand-icon";
import { ReviewAgentPicker } from "@/components/review-agent-picker";
import { SectionCard } from "@/components/ui/section-card";
import {
  BTN_PRIMARY,
  CardFooter,
  MONO_AREA,
  SkeletonCard,
  TemplateVars,
  WORKSPACE_ADMIN_ONLY,
} from "@/components/settings/settings-ui";

/**
 * Settings → Code review: the workspace's default reviewer (agent and model,
 * saved through PUT /api/optio/settings) and review prompt (the
 * "review-default" prompt). When a review starts, how deep it goes and the
 * test command are each repo's own (the repo's settings page).
 */
export function DefaultReviewEditor() {
  // Both saves take a workspace admin.
  const { isAdmin } = useCurrentUser();
  const [reviewPrompt, setReviewPrompt] = useState("");
  const [reviewAgentType, setReviewAgentType] = useState<AgentType>("claude-code");
  const [reviewModel, setReviewModel] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.getReviewDefault().catch(() => null),
      api.getOptioSettings().catch(() => null),
    ])
      .then(([promptRes, settingsRes]) => {
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
  }, []);

  const label = "Code review";
  const hint = "The default reviewer for every repo";
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

      <div className="pt-4 border-t border-border space-y-3">
        <div className="text-xs font-medium text-text-muted">Review prompt</div>
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
        {!isAdmin && <span className="text-xs text-text-muted">{WORKSPACE_ADMIN_ONLY}</span>}
        <button
          onClick={async () => {
            setSaving(true);
            try {
              await api.saveReviewDefault(reviewPrompt);
              await api.updateOptioSettings({
                defaultReviewAgentType: reviewAgentType,
                defaultReviewModel: reviewModel || null,
              });
              toast.success("Review defaults saved");
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Failed to save");
            } finally {
              setSaving(false);
            }
          }}
          disabled={saving || !isAdmin}
          className={BTN_PRIMARY}
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {saving ? "Saving..." : "Save"}
        </button>
      </CardFooter>
    </SectionCard>
  );
}
