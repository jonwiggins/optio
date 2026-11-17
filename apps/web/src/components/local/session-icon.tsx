import { workOrigin } from "@optio/shared";
import { AgentAvatar } from "@/components/agent-avatar";

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
  return (
    <AgentAvatar
      runtime={runtime ?? "terminal"}
      origin={workOrigin({
        source: "local-terminal",
        spawnedBy: terminal.spawnedBy ?? "manual",
        triggers: terminal.triggerType
          ? [{ type: terminal.triggerType, source: terminal.ticketSource }]
          : [],
        ticketSource: terminal.ticketSource,
      })}
      className={className}
    />
  );
}
