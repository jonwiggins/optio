import { AgentIcon, TriggerIcon, triggerLabel } from "@/components/brand-icon";
import { runtimeLabel } from "@/components/agent-choice-model";

/** Keep the session's identity consistent in its header, rail and split group. */
export function LocalSessionIcon({
  terminal,
  className,
}: {
  terminal: {
    spec?: { kind?: string; agent?: string } | null;
    spawnedBy?: string | null;
    triggerType?: string | null;
    ticketSource?: string | null;
  };
  className?: string;
}) {
  const runtime = terminal.spec?.kind === "agent" ? terminal.spec.agent : null;
  const trigger =
    terminal.triggerType && terminal.triggerType !== "manual"
      ? terminal.triggerType
      : terminal.spawnedBy === "ticket"
        ? "ticket"
        : terminal.spawnedBy === "trigger"
          ? "webhook"
          : null;
  return (
    <span
      className="inline-flex shrink-0"
      title={
        runtime
          ? runtimeLabel(runtime)
          : trigger
            ? `Started by ${triggerLabel(trigger, terminal.ticketSource)}`
            : "Terminal"
      }
      aria-hidden="true"
    >
      {runtime ? (
        <AgentIcon runtime={runtime} className={className} />
      ) : trigger ? (
        <TriggerIcon type={trigger} source={terminal.ticketSource} className={className} />
      ) : (
        <AgentIcon runtime="terminal" className={className} />
      )}
    </span>
  );
}
