import type { WorkOrigin } from "@optio/shared";
import { AgentIcon, triggerLabel } from "@/components/brand-icon";
import { runtimeLabel } from "@/components/agent-choice-model";
import { SpawnSourceBadge } from "@/components/local/spawn-source-badge";
import { cn } from "@/lib/utils";

/** One identity for work everywhere: harness first, recorded source in the corner. */
export function AgentAvatar({
  runtime,
  origin,
  label,
  className,
}: {
  runtime?: string | null;
  origin?: WorkOrigin | null;
  label?: string;
  className?: string;
}) {
  const terminal = runtime === "terminal" || runtime === "shell" || runtime === "";
  const source =
    origin &&
    (origin.spawnedBy === "ticket"
      ? triggerLabel("ticket", origin.ticketSource)
      : origin.triggerType
        ? triggerLabel(origin.triggerType, origin.ticketSource)
        : origin.spawnedBy);
  const title =
    label ??
    `${terminal ? "Terminal" : runtime ? runtimeLabel(runtime) : "Agent"}${source ? ` · ${source}` : ""}`;
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      className={cn(
        "relative inline-flex h-8 w-8 shrink-0 items-center justify-center text-text-heading",
        className,
      )}
    >
      <AgentIcon runtime={terminal ? "terminal" : runtime} colored className="h-full w-full" />
      {origin && (
        <span
          aria-hidden="true"
          className="absolute -bottom-[11%] -right-[11%] flex h-[58%] w-[58%] items-center justify-center rounded-md border border-border bg-bg-card text-primary shadow-sm"
        >
          <SpawnSourceBadge {...origin} compact colored overlay />
        </span>
      )}
    </span>
  );
}
