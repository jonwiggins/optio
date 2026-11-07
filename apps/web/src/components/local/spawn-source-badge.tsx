import { OptioMark } from "@/components/optio-mark";
import { Bot, Briefcase, GitPullRequest, Layers, Ticket, User, Webhook } from "lucide-react";
import { BrandIcon, BRAND_LABEL, brandFor, triggerTypeIcon } from "@/components/brand-icon";
import { cn } from "@/lib/utils";

const SPAWN_SOURCE: Record<string, { label: string; icon: any }> = {
  optio: { label: "Optio", icon: OptioMark },
  review: { label: "PR review", icon: GitPullRequest },
  manual: { label: "manual", icon: User },
  ticket: { label: "ticket", icon: Ticket },
  trigger: { label: "trigger", icon: Webhook },
  blueprint: { label: "blueprint", icon: Layers },
  api: { label: "api", icon: Bot },
  resume: { label: "resumed", icon: User },
  // Terminals that execute a Job run / Repo Task whose run location is this machine.
  job: { label: "job", icon: Briefcase },
  task: { label: "task", icon: GitPullRequest },
};

/** A trigger-started session names its source: GitHub, Slack, a schedule, … */
const TRIGGER_SOURCE: Record<string, { label: string; icon: any }> = {
  github: { label: "GitHub", icon: triggerTypeIcon("github") },
  gitlab: { label: "GitLab", icon: triggerTypeIcon("gitlab") },
  slack: { label: "Slack", icon: triggerTypeIcon("slack") },
  linear: { label: "Linear", icon: triggerTypeIcon("linear") },
  jira: { label: "Jira", icon: triggerTypeIcon("jira") },
  pagerduty: { label: "PagerDuty", icon: triggerTypeIcon("pagerduty") },
  pylon: { label: "Pylon", icon: triggerTypeIcon("pylon") },
  sentry: { label: "Sentry", icon: triggerTypeIcon("sentry") },
  alertmanager: { label: "Alertmanager", icon: triggerTypeIcon("alertmanager") },
  datadog: { label: "Datadog", icon: triggerTypeIcon("datadog") },
  schedule: { label: "schedule", icon: triggerTypeIcon("schedule") },
  webhook: { label: "webhook", icon: triggerTypeIcon("webhook") },
  ticket: { label: "ticket", icon: triggerTypeIcon("ticket") },
};

export function SpawnSourceBadge({
  spawnedBy,
  triggerType,
  ticketSource,
  compact = false,
  colored = false,
  overlay = false,
}: {
  spawnedBy: string;
  triggerType?: string | null;
  /** A ticket-started session shows its tracker's mark (GitHub, Linear, …). */
  ticketSource?: string | null;
  compact?: boolean;
  colored?: boolean;
  /** Fill the source badge in an avatar instead of adding inline padding. */
  overlay?: boolean;
}) {
  const ticketBrand =
    spawnedBy === "ticket" || (spawnedBy === "trigger" && triggerType === "ticket")
      ? brandFor(ticketSource)
      : null;
  const src =
    (spawnedBy === "trigger" && triggerType ? TRIGGER_SOURCE[triggerType] : undefined) ??
    (ticketBrand
      ? {
          label: `${BRAND_LABEL[ticketBrand]} ticket`,
          icon: triggerTypeIcon("ticket", ticketBrand),
        }
      : undefined) ??
    SPAWN_SOURCE[spawnedBy] ??
    SPAWN_SOURCE.manual;
  const Icon = src.icon;
  const brand = ticketBrand ?? (spawnedBy === "trigger" ? brandFor(triggerType) : null);
  return (
    <span
      title={`Started by ${src.label}`}
      className={cn(
        "inline-flex shrink-0 items-center text-text-muted",
        colored && spawnedBy === "optio" && "text-primary",
        overlay
          ? "h-full w-full justify-center"
          : compact
            ? "p-1"
            : "gap-1 px-1.5 py-0.5 rounded border border-border bg-bg text-[10px] uppercase tracking-wide",
      )}
    >
      {colored && brand ? (
        <BrandIcon brand={brand} mono={false} className={overlay ? "h-[70%] w-[70%]" : "w-3 h-3"} />
      ) : (
        <Icon className={overlay ? "h-[70%] w-[70%]" : "w-3 h-3"} />
      )}
      <span className={compact ? "sr-only" : undefined}>{src.label}</span>
    </span>
  );
}
