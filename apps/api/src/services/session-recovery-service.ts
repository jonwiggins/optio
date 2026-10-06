import { getSession } from "./interactive-session-service.js";
import { getTerminal } from "./local-terminal-service.js";
import { isHostOnline } from "./local-relay.js";
import { getPod, podHandle } from "./agent-pod-pool.js";
import { getRuntime } from "./container-service.js";
import { latestSessionTurn } from "./session-turn-service.js";
import type { SessionKind } from "./session-sharing-service.js";

export interface SessionRecovery {
  state: "live" | "reconnecting" | "resumable" | "lost" | "ended";
  message: string;
  automaticReplay: false;
}
const recovery = (state: SessionRecovery["state"], message: string): SessionRecovery => ({
  state,
  message,
  automaticReplay: false,
});

export async function sessionRecovery(kind: SessionKind, id: string): Promise<SessionRecovery> {
  if (kind === "local") {
    const terminal = await getTerminal(id);
    if (!terminal) return recovery("lost", "Session record is unavailable.");
    if (terminal.state === "running" || terminal.state === "launching") {
      return isHostOnline(terminal.hostId)
        ? recovery("live", "Connected to your machine.")
        : recovery(
            "reconnecting",
            "Waiting for your machine to reconnect. Running work is preserved; no commands will be replayed.",
          );
    }
    if (terminal.state === "pending")
      return recovery(
        "reconnecting",
        "Waiting for the session to start. No previous commands are being replayed.",
      );
    if (terminal.agentSessionId)
      return recovery(
        "resumable",
        "The process stopped. Its agent conversation can be resumed on the same machine; review the last result before continuing.",
      );
    return terminal.errorMessage
      ? recovery(
          "lost",
          "The process was lost. Recorded output is preserved; commands will not be automatically retried.",
        )
      : recovery("ended", "This session has ended. Recorded output is available.");
  }
  const session = await getSession(id);
  if (!session) return recovery("lost", "Session record is unavailable.");
  if (session.state === "ended")
    return recovery("ended", "This session has ended. Chat history is preserved.");
  const pod = session.podId ? await getPod(session.podId) : null;
  if (!pod?.podName)
    return recovery(
      "lost",
      "The session's pod is unavailable. Chat history is preserved; the session will not be silently recreated.",
    );
  if (!pod.isolationKey)
    return recovery(
      "resumable",
      "This session uses a legacy shared pod. Preserve your changes and start an isolated session before sharing. Legacy Git credential refresh is disabled.",
    );
  try {
    const status = await getRuntime().status(podHandle(pod));
    if (status.state !== "running") {
      return pod.managedBy === "statefulset"
        ? recovery(
            "reconnecting",
            "Waiting for the pod to recover. Its workspace and agent home are retained on persistent storage.",
          )
        : recovery(
            "lost",
            "The process stopped in an ephemeral pod. Chat history is preserved; commands will not be replayed.",
          );
    }
    if (status.startedAt && status.startedAt.getTime() > session.createdAt.getTime()) {
      return recovery(
        pod.managedBy === "statefulset" ? "resumable" : "lost",
        pod.managedBy === "statefulset"
          ? "The pod restarted. Its previous processes stopped, but the workspace and agent home are retained. Review saved output before continuing; commands will not be replayed."
          : "The pod restarted and its previous processes were lost. Review recorded output and available files before starting again; commands will not be replayed.",
      );
    }
  } catch {
    return recovery(
      "reconnecting",
      "Checking the pod after a connection interruption. No work will be automatically repeated.",
    );
  }
  const turn = await latestSessionTurn(id);
  if (turn?.state === "interrupted")
    return recovery(
      "resumable",
      "The last turn was interrupted and its outcome is uncertain. Review the terminal and saved history before sending a new prompt; it will not be replayed.",
    );
  return recovery("live", "Connected. Terminal and chat continue when you reconnect.");
}
