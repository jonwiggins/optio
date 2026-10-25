"use client";

import { Sparkles } from "lucide-react";
import type { ReviewDepth } from "@optio/shared";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/segmented";
import { REVIEW_TRIGGER_LABEL } from "@/components/review-labels";

/**
 * "Turn on automatic code review" in one click, the same everywhere a repo's
 * review is set up: the repo page, Add repository, the setup wizard. On, a
 * review agent reads each pull or merge request Optio opens — once CI passes,
 * or as soon as it opens — and approves it or asks for changes. Two choices go
 * with it: how deep the review goes, and whether other people's PRs / MRs are
 * reviewed (and the review posted) too.
 *
 * The value maps onto the repo's columns as `PATCH /api/repos/:id` takes them
 * (`autoReviewPatch`): reviewEnabled, reviewTrigger, reviewDepth and
 * externalReviewMode.
 */

export type ReviewStart = "on_ci_pass" | "on_pr" | "manual";

export interface AutoReviewValue {
  enabled: boolean;
  /** When a review starts; "manual" (no automatic review) is kept only when already set. */
  trigger: string;
  depth: ReviewDepth;
  /** repos.external_review_mode: "off" | "on_request" | "on_pr_hold" | "on_pr_post". */
  externalMode?: string;
}

export const REVIEW_DEPTH_OPTIONS: Array<{ value: ReviewDepth; label: string; hint: string }> = [
  {
    value: "thorough",
    label: "Thorough",
    hint: "Reads the code around the diff, runs the test command, reports every real issue.",
  },
  {
    value: "light",
    label: "Light",
    hint: "The diff only, no tests: the few findings that matter most, in half the turns.",
  },
];

/** The two depths as pills, with the chosen one's meaning underneath. */
export function ReviewDepthPicker({
  value,
  onChange,
  label = "Depth",
}: {
  value: ReviewDepth;
  onChange: (v: ReviewDepth) => void;
  label?: string | null;
}) {
  const hint = REVIEW_DEPTH_OPTIONS.find((o) => o.value === value)?.hint;
  return (
    <div>
      {label && <span className="block text-xs text-text-muted mb-1">{label}</span>}
      <Segmented
        aria-label="Review depth"
        value={value}
        onChange={onChange}
        options={REVIEW_DEPTH_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      />
      {hint && <p className="text-[11px] text-text-muted mt-1">{hint}</p>}
    </div>
  );
}

/** External review modes that review other people's PRs / MRs by themselves. */
const EXTERNAL_ON = new Set(["on_pr_post", "on_pr_hold"]);

/** The repo fields the switch's value stands for (what `PATCH /api/repos/:id` takes). */
export function autoReviewPatch(v: AutoReviewValue): {
  reviewEnabled: boolean;
  reviewTrigger: string;
  reviewDepth: ReviewDepth;
  externalReviewMode?: string;
} {
  return {
    reviewEnabled: v.enabled,
    reviewTrigger: v.trigger,
    reviewDepth: v.depth,
    ...(v.externalMode !== undefined ? { externalReviewMode: v.externalMode } : {}),
  };
}

export function AutoReviewSwitch({
  value,
  onChange,
  showExternal = true,
  defaultTrigger = "on_ci_pass",
  className,
}: {
  value: AutoReviewValue;
  onChange: (next: AutoReviewValue) => void;
  /** Offer "other people's PRs / MRs too" (a repo's setting, not a piece of work's). */
  showExternal?: boolean;
  /** The start a review gets when switched on from "manual" (the workspace's default). */
  defaultTrigger?: ReviewStart;
  className?: string;
}) {
  const set = (patch: Partial<AutoReviewValue>) => onChange({ ...value, ...patch });
  const turnOn = (on: boolean) =>
    set({
      enabled: on,
      // Switching on with no automatic start would review nothing.
      ...(on && value.trigger !== "on_pr" && value.trigger !== "on_ci_pass"
        ? { trigger: defaultTrigger === "manual" ? "on_ci_pass" : defaultTrigger }
        : {}),
    });
  const externalOn = EXTERNAL_ON.has(value.externalMode ?? "off");

  return (
    <div
      className={cn(
        "rounded-lg border p-3 space-y-3",
        value.enabled ? "border-primary/40 bg-primary/5" : "border-border",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <Sparkles
          className={cn(
            "w-4 h-4 mt-0.5 shrink-0",
            value.enabled ? "text-primary" : "text-text-muted",
          )}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-heading">
            {value.enabled ? "Automatic code review is on" : "Turn on automatic code review"}
          </div>
          <p className="text-xs text-text-muted">
            A review agent reads each PR / MR Optio opens and approves it or asks for changes.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={value.enabled}
          aria-label="Automatic code review"
          onClick={() => turnOn(!value.enabled)}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors mt-0.5",
            value.enabled ? "bg-primary" : "bg-border",
          )}
        >
          <span
            className={cn(
              "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
              value.enabled ? "translate-x-4.5" : "translate-x-1",
            )}
          />
        </button>
      </div>

      {value.enabled && (
        <div className="space-y-3 pl-7">
          <div>
            <span className="block text-xs text-text-muted mb-1">Starts</span>
            <Segmented
              wrap
              aria-label="When the review starts"
              value={value.trigger}
              onChange={(trigger) => set({ trigger })}
              options={[
                { value: "on_ci_pass", label: REVIEW_TRIGGER_LABEL.on_ci_pass },
                { value: "on_pr", label: REVIEW_TRIGGER_LABEL.on_pr },
                // Only shown for a repo already set to manual, so its value reads true.
                ...(value.trigger === "manual"
                  ? [{ value: "manual", label: REVIEW_TRIGGER_LABEL.manual }]
                  : []),
              ]}
            />
          </div>
          <ReviewDepthPicker value={value.depth} onChange={(depth) => set({ depth })} />
          {showExternal && (
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={externalOn}
                onChange={(e) => set({ externalMode: e.target.checked ? "on_pr_post" : "off" })}
                className="w-4 h-4 rounded mt-0.5"
              />
              <span className="text-sm">
                Other people&apos;s PRs / MRs too
                <span className="block text-[11px] text-text-muted">
                  {value.externalMode === "on_pr_hold"
                    ? "Reviews are drafted and held for you to post (External PR review)."
                    : "Reviews the PRs / MRs that people and bots open, and posts the review on each."}
                </span>
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
