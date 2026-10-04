"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, Plug, Server, Sparkles, Terminal } from "lucide-react";
import type { WorkEnvironmentItem, WorkEnvironmentOptions, WorkSettings } from "@optio/shared";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Disclosure } from "@/components/ui/disclosure";
import { Segmented } from "@/components/ui/segmented";
import { inputClass } from "@/components/ui/input";
import {
  DEFAULT_MAX_AUTO_RESUMES,
  overrideOn,
  settingsChanges,
  toggleOverride,
  type EnvironmentPart,
} from "./model";

/**
 * Where → Environment: what the agent's pod has besides the code. The repo's
 * settings (and the workspace's) are the defaults, shown switched on; this
 * work can turn any of them off, add others, run its own setup commands, and
 * — when it opens a PR — decide its own review, draft PRs, and how often it is
 * resumed. Only the changes are saved (`WorkSettings`), so work that changes
 * nothing keeps following the repo.
 */

const TEXTAREA = inputClass({ className: "text-xs font-mono" });

const REPO = "__repo__";

export function EnvironmentPanel({
  settings,
  repoUrl,
  agentType,
  owner,
  prApplies,
  command = false,
  secrets,
  onChange,
}: {
  settings: WorkSettings;
  /** The repo the work runs in, if any (its settings are the defaults). */
  repoUrl: string | null;
  agentType: string;
  owner: "workspace" | "me";
  /** The work opens a PR, so its follow-through settings apply. */
  prApplies: boolean;
  /** A command, not an agent: only secrets and setup commands mean anything. */
  command?: boolean;
  /** The pod secrets row, rendered first. */
  secrets?: ReactNode;
  /** The work's settings, with a change applied ({} = back to the defaults). */
  onChange: (next: WorkSettings) => void;
}) {
  const set = (patch: Partial<WorkSettings>) => onChange({ ...settings, ...patch });
  const toggle = (part: EnvironmentPart, item: WorkEnvironmentItem, on: boolean) =>
    set({ [part]: toggleOverride(settings[part], item.id, item.default, on) });
  const changes = settingsChanges(settings);
  const [open, setOpen] = useState(changes > 0);
  const [options, setOptions] = useState<WorkEnvironmentOptions | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getWorkEnvironment({ repoUrl, agentType, owner })
      .then((o) => live && setOptions(o))
      .catch(() => live && setOptions(null));
    return () => {
      live = false;
    };
  }, [repoUrl, agentType, owner]);

  const count = (part: EnvironmentPart) =>
    options?.[part].filter((i) => overrideOn(settings[part], i.id, i.default)).length ?? 0;
  const summary = command
    ? "secrets and setup commands"
    : options
      ? [
          plural(count("mcpServers"), "MCP server"),
          plural(count("connections"), "connection"),
          plural(count("skills"), "skill"),
        ].join(" · ")
      : "Loading…";

  return (
    <div data-testid="work-environment">
      <Disclosure
        open={open}
        onToggle={() => setOpen((o) => !o)}
        label={
          <span>
            Environment{" "}
            <span className="text-text-muted/70">
              — {changes > 0 ? `${plural(changes, "change")} from ` : ""}
              {repoUrl ? "the repo's defaults" : "the workspace's defaults"} · {summary}
            </span>
          </span>
        }
      >
        <div className="space-y-4">
          {secrets}
          {!command && (
            <>
              <Toggles
                part="connections"
                label="Connections"
                icon={<Plug className="w-3 h-3" />}
                items={options?.connections}
                settings={settings}
                onToggle={toggle}
                empty="No connections in this workspace — add them under Library → Connections."
              />
              <Toggles
                part="mcpServers"
                label="MCP servers"
                icon={<Server className="w-3 h-3" />}
                items={options?.mcpServers}
                settings={settings}
                onToggle={toggle}
                empty="No MCP servers configured — add them in a repo's or the workspace's settings."
              />
              <Toggles
                part="skills"
                label="Skills"
                icon={<Sparkles className="w-3 h-3" />}
                items={options?.skills}
                settings={settings}
                onToggle={toggle}
                empty="No custom skills configured."
              />
            </>
          )}

          <div>
            <label className="flex items-center gap-1.5 text-xs text-text-muted mb-1">
              <Terminal className="w-3 h-3" /> Setup commands
            </label>
            <textarea
              rows={2}
              value={settings.setupCommands ?? ""}
              onChange={(e) => set({ setupCommands: e.target.value })}
              placeholder="npm ci && npm run build"
              className={TEXTAREA}
              aria-label="Setup commands"
            />
            <p className="text-[11px] text-text-muted/80 mt-1">
              Run in the agent's directory before it starts; the run stops if they fail.
              {options?.repo?.setupCommands
                ? " The repo's own setup commands still run when its pod starts."
                : ""}
            </p>
          </div>

          {repoUrl && (
            <p className="text-[11px] text-text-muted/80">
              The pod itself — image, resources, network — is the repo&apos;s: its tasks share its
              pods. Change it in the repo&apos;s settings.
            </p>
          )}

          {prApplies && <PrSettings settings={settings} repo={options?.repo} onChange={set} />}

          {changes > 0 && (
            <button
              type="button"
              onClick={() => onChange({})}
              className="text-xs text-text-muted hover:text-text underline underline-offset-2"
              data-testid="work-environment-reset"
            >
              Back to {repoUrl ? "the repo's" : "the workspace's"} defaults
            </button>
          )}
        </div>
      </Disclosure>
    </div>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One kind of item as chips: on ones highlighted, defaults tagged. */
function Toggles({
  part,
  label,
  icon,
  items,
  settings,
  onToggle,
  empty,
}: {
  part: EnvironmentPart;
  label: string;
  icon: ReactNode;
  items: WorkEnvironmentItem[] | undefined;
  settings: WorkSettings;
  onToggle: (part: EnvironmentPart, item: WorkEnvironmentItem, on: boolean) => void;
  empty: string;
}) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-xs text-text-muted mb-1">
        {icon} {label}
      </label>
      {!items ? (
        <p className="text-[11px] text-text-muted/60">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-[11px] text-text-muted/80">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
          {items.map((item) => {
            const on = overrideOn(settings[part], item.id, item.default);
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={on}
                title={item.detail ?? undefined}
                onClick={() => onToggle(part, item, !on)}
                className={cn(
                  "inline-flex items-center gap-1 px-2 py-1 rounded-md border text-xs transition-colors",
                  on
                    ? "bg-primary/10 border-primary/40 text-text"
                    : "bg-bg border-border text-text-muted hover:text-text",
                )}
              >
                <Check className={cn("w-3 h-3", on ? "text-primary" : "opacity-0")} />
                {item.name}
                <span className="text-[10px] text-text-muted/70">
                  {item.default ? "default" : item.scope}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Review, draft PRs, and resumes for this work. The repo's settings are an
 * admin's, so work can only be more careful than its repo: ask for a review,
 * open drafts, or resume fewer times (`effectivePrSettings`).
 */
function PrSettings({
  settings,
  repo,
  onChange,
}: {
  settings: WorkSettings;
  repo: WorkEnvironmentOptions["repo"] | undefined;
  onChange: (patch: Partial<WorkSettings>) => void;
}) {
  const repoReviews = !!repo?.reviewEnabled;
  const repoReview = repoReviews
    ? `Repo (${repo?.reviewTrigger === "on_pr" ? "on PR" : repo?.reviewTrigger === "on_ci_pass" ? "after CI" : "manual"})`
    : "Repo (off)";
  const review = settings.review?.enabled ? (settings.review.trigger ?? "on_ci_pass") : REPO;
  const cap = repo?.maxAutoResumes ?? DEFAULT_MAX_AUTO_RESUMES;
  return (
    <div className="space-y-3 pt-3 border-t border-border">
      <div>
        <label className="block text-xs text-text-muted mb-1">Code review</label>
        <Segmented
          wrap
          value={review}
          onChange={(v) =>
            onChange({
              review:
                v === REPO ? undefined : { enabled: true, trigger: v as "on_pr" | "on_ci_pass" },
            })
          }
          options={[
            { value: REPO, label: repoReview },
            { value: "on_pr", label: "Review when the PR opens" },
            { value: "on_ci_pass", label: "Review once CI passes" },
          ]}
        />
      </div>
      <div className="flex flex-wrap gap-6">
        <div>
          <label className="block text-xs text-text-muted mb-1">PRs</label>
          <Segmented
            wrap
            value={settings.cautiousMode === true && !repo?.cautiousMode ? "draft" : REPO}
            onChange={(v) => onChange({ cautiousMode: v === "draft" ? true : undefined })}
            options={[
              {
                value: REPO,
                label: repo?.cautiousMode ? "Repo (draft)" : "Repo (ready for review)",
                disabled: repo?.cautiousMode ? "This repo already opens draft PRs." : undefined,
              },
              { value: "draft", label: "Draft — a person merges" },
            ]}
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Auto-resumes</label>
          <input
            type="number"
            min={0}
            max={cap}
            value={settings.maxAutoResumes ?? ""}
            placeholder={String(cap)}
            onChange={(e) =>
              onChange({
                maxAutoResumes:
                  e.target.value === "" ? undefined : Math.min(Number(e.target.value), cap),
              })
            }
            className={inputClass({ className: "w-24" })}
            aria-label="Auto-resumes"
          />
        </div>
      </div>
      <p className="text-[11px] text-text-muted/80">
        Work can be more careful than its repo, never less: a review, draft PRs, or fewer resumes.
        To loosen them, change the repo&apos;s settings. The plan under Then shows the result.
      </p>
    </div>
  );
}
